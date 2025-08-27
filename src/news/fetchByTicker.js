import fs from 'fs';
import path from 'path';
import { fetchKotraRecent } from "./kotraOverseas.js";
import { getCompanyNameByYahooSymbol } from "../data/krxDirectory.js";
import { tokenBucket, circuitBreaker } from "./helpers/rate.js";

const CACHE_DIR = 'cache';
const NEWS_TTL_MS = Number(process.env.NEWS_TTL_MS || 30 * 60 * 1000); // 30m
const NEWS_CONCURRENCY = Number(process.env.NEWS_CONCURRENCY || 2);
const ALLOW_STALE_NEWS = process.env.ALLOW_STALE_NEWS !== '0';
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || 8000);
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 3000);
const defaultHeaders = {
  'User-Agent': 'stock-recs/1.1 (+ci)',
  'Accept': 'application/json,text/*;q=0.9,*/*;q=0.8',
  'Accept-Encoding': 'gzip,deflate',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
};
const defaultUA = { 'User-Agent': 'stock-recs/1.0 (+github-actions)' };
const SKIP_NAVER = process.env.SKIP_NAVER === '1';

const buckets = {
  newsapi: tokenBucket({capacity:3, refillPerSec:2}),
  serpapi: tokenBucket({capacity:2, refillPerSec:1.5}),
  finnhub: tokenBucket({capacity:2, refillPerSec:1}),
  gdelt: tokenBucket({capacity:2, refillPerSec:1}),
  naver: tokenBucket({capacity:3, refillPerSec:2}),
};
const cb = circuitBreaker({cooldownMs:20*60_000});

async function guardedCall(name, fn){
  if (cb.isOpen(name)) return null;
  await buckets[name]?.();
  try {
    return await fn();
  } catch (e){
    const msg = String(e?.message||e);
    if (/HTTP 403/.test(msg)) cb.open(name);
    throw e;
  }
}

function looksLikeXmlOrHtml(s){ const t=String(s||'').trim(); return !!t && t.startsWith('<'); }
function cacheKey(url){ return path.join(CACHE_DIR, `news-${Buffer.from(url).toString('base64url')}.json`); }

async function cachedJson(url, fetcher, ttlMs=NEWS_TTL_MS, allowStale=ALLOW_STALE_NEWS){
  const key = cacheKey(url);
  try{
    const st=fs.statSync(key); const age=Date.now()-st.mtimeMs;
    if (age < ttlMs) return JSON.parse(fs.readFileSync(key,'utf8'));
    if (allowStale) return JSON.parse(fs.readFileSync(key,'utf8'));
  }catch{}
  const data = await fetcher(url);
  try{ fs.mkdirSync(CACHE_DIR,{recursive:true}); fs.writeFileSync(key, JSON.stringify(data)); }catch{}
  return data;
}
async function safeGetJson(url, headers={}, timeoutMs=REQ_TIMEOUT_MS){
  const ctrl = new AbortController();
  const connectTimer = setTimeout(()=>ctrl.abort(new Error('timeout')), CONNECT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers: { ...defaultHeaders, ...headers }, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(connectTimer);
  } catch (e){
    const host = (()=>{ try { return new URL(url).host; } catch { return 'unknown-host'; }})();
    const code = e?.cause?.code || e.name || 'ERR_FETCH';
    throw new Error(`fetch failed (${host}): ${e.message} [${code}]`);
  }
  const readTimer = setTimeout(()=>ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    if (!res.ok) {
      const hdrs = {};
      res.headers?.forEach((v,k)=>hdrs[k]=v);
      const err = new Error(`HTTP ${res.status}`);
      err.responseHeaders = hdrs;
      throw err;
    }
    const ct = res.headers?.get?.('content-type') || '';
    if (/json/i.test(ct)) return await res.json();
    const txt = await res.text();
    if (looksLikeXmlOrHtml(txt)) throw new Error(`non-JSON payload (${ct||'unknown'})`);
    return JSON.parse(txt);
  } catch(e){
    if (e instanceof SyntaxError) throw new Error(`JSON parse failed (${e.message})`);
    throw e;
  } finally {
    clearTimeout(readTimer);
  }
}

function isKR(sym){ return /\.K[QS]$/.test(sym); }

function baseSymbol(sym){ return String(sym||'').replace(/[\.\-]/g,'').toUpperCase(); }

/**
 * Build a compact symbol→query dictionary.
 * - For KR symbols: prefer Korean display name if provided (opts.symbolToName), else the numeric code.
 * - For US: use ticker + display name to help NewsAPI.
 */
function buildQueries(symbols, { symbolToName={} }={}) {
  const q = {};
  for (const s of symbols){
    const name = symbolToName[s] || s;
    if (isKR(s)) q[s] = `${name} ${s}`;
    else q[s] = `${s} ${name}`;
  }
  return q;
}

async function mapLimit(items, limit, worker){
  const out = new Array(items.length);
  let i=0, active=0; 
  await new Promise((resolve, reject)=>{
    const next=()=>{
      while (active<limit && i<items.length){
        const idx=i++; active++;
        Promise.resolve(worker(items[idx], idx))
          .then(v=>{ out[idx]=v; active--; next(); })
          .catch(reject);
      }
      if (i>=items.length && active===0) resolve();
    };
    next();
  });
  return out;
}

async function withRetry(fn,{max=2,baseMs=600,onError}={}){
  let last;
  for(let i=0;i<=max;i++){
    try { return await fn(); }
    catch(e){
      last=e;
      const msg=String(e);
      const ra=Number((e?.responseHeaders?.['retry-after'])||0);
      const is429=/HTTP 429/.test(msg);
      const wait=typeof onError==='function' ? (onError(e)||0) : 0;
      const backoff=Math.floor((is429 ? (ra*1000||baseMs*Math.pow(2,i)) : baseMs*Math.pow(2,i))*(0.6+Math.random()*0.6));
      if(i<max) await new Promise(r=>setTimeout(r, Math.max(wait, backoff)));
      else break;
    }
  }
  throw last;
}

async function with429Retry(fn, max=2, baseMs=600){
  return withRetry(fn,{max, baseMs});
}

/**
 * Provider calls (each returns a {count, sentiment?, blogMentions?} shape or null)
 */
async function newsFromFinnhub(sym, FINNHUB){
  if (!FINNHUB) return null;
  const to = new Date().toISOString().slice(0,10);
  const from = new Date(Date.now()-7*864e5).toISOString().slice(0,10);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}&token=${FINNHUB}`;
  const j = await withRetry(
    () => cachedJson(url, (u)=>safeGetJson(u, defaultUA), 20*60*1000, true),
    {max:2, baseMs:600}
  );
  const arr = Array.isArray(j) ? j : [];
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
}

async function newsFromNewsAPI(sym, q, NEWSAPI){
  if (!NEWSAPI) return null;
  const url = `https://newsapi.org/v2/everything?qInTitle=${encodeURIComponent(sym)}&language=en&pageSize=10&sortBy=publishedAt&apiKey=${NEWSAPI}`;
  const j = await withRetry(() => cachedJson(url, (u)=>safeGetJson(u, defaultUA), 20*60*1000, true), {max:1, baseMs:600});
  const arr = Array.isArray(j?.articles) ? j.articles : [];
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
}

/**
 * SerpApi (Google News)
 * Docs: https://serpapi.com/google-news-api
 * We localize KR vs US via gl/hl and add a recency hint (when:7d).
 */
async function newsFromSerpApi(sym, name, SERPAPI){
  if (!SERPAPI) return null;
  const isKr = isKR(sym);
  const gl = isKr ? 'kr' : 'us';
  const hl = isKr ? 'ko' : 'en';
  const baseQ = `"${name}" OR ${sym} site:news.google.com`;
  const finalQ = /\bwhen:\d+[hdwmy]?\b/i.test(baseQ) ? baseQ : `${baseQ} when:7d`;
  const url = `https://serpapi.com/search.json?engine=google_news&q=${encodeURIComponent(finalQ)}&gl=${gl}&hl=${hl}&no_cache=false&api_key=${SERPAPI}`;
  const j = await withRetry(() => cachedJson(url, (u)=>safeGetJson(u, defaultUA), 20*60*1000, true), {max:1, baseMs:600});
  const arr = Array.isArray(j?.news_results) ? j.news_results : [];
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
}

async function newsFromGNews(sym, q, GNEWS_API){
  if (!GNEWS_API) return null;

  // Choose language by market (you can tweak country= as well if you like):
  const isKr = isKR(sym);
  const lang = isKr ? 'ko' : 'en';

  // Keep it simple and quota-friendly. You can add date filters later if needed.
  // Docs pattern: https://gnews.io/api/v4/search?q=...&lang=...&max=...&apikey=KEY
  const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=${lang}&max=10&apikey=${GNEWS_API}`;

  // Cache ~20 min; allow stale like others
  const j = await cachedJson(url, (u)=>safeGetJson(u, defaultUA), 20*60*1000, true);

  const arr = Array.isArray(j?.articles) ? j.articles : [];
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
}

async function newsFromNaver(name, NAVER_ID, NAVER_SECRET){
  if (SKIP_NAVER) return null;
  if (!NAVER_ID || !NAVER_SECRET) return null;
  const q = `${name} + 증권 OR 투자`;
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(q)}&display=10&sort=date`;
  const headers = { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET };
  const j = await withRetry(() => cachedJson(url, (u)=>safeGetJson(u, headers), 20*60*1000, true), {max:1, baseMs:600});
  const arr = Array.isArray(j?.items) ? j.items : [];
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
}

async function blogFromNaver(name, NAVER_ID, NAVER_SECRET){
  if (SKIP_NAVER) return 0;
  if (!NAVER_ID || !NAVER_SECRET) return 0;
  const q = `${name} + 증권 OR 투자`;
  const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(q)}&display=10&sort=date`;
  const headers = { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET };
  const j = await withRetry(() => cachedJson(url, (u)=>safeGetJson(u, headers), 20*60*1000, true), {max:1, baseMs:600});
  const arr = Array.isArray(j?.items) ? j.items : [];
  return Math.min(arr.length, 30);
}

const KOTRA_BASE =
  'https://apis.data.go.kr/B410001/kotra_overseasMarketNews/ovseaMrktNews/ovseaMrktNews';

function natnForSym(sym) {
  if (/\.K[QS]$/.test(sym)) return '대한민국';
  return '미국';
}

function buildKotraUrl({ serviceKey, natn, title, rows = 10, page = 1, includeText = true }) {
  const params = new URLSearchParams();
  params.set('serviceKey', serviceKey);
  params.set('type', 'json');
  params.set('numOfRows', String(rows));
  params.set('pageNo', String(page));
  if (includeText) params.set('search8', 'Y');
  if (natn) params.set('search1', natn);
  if (title) params.set('search2', title);
  return `${KOTRA_BASE}?${params.toString()}`;
}

async function newsFromKotra(sym, rawQuery) {
  // Prefer decoded service key so URLSearchParams encodes it exactly once.
  const serviceKey = chooseServiceKeyForDataGoKr();
  if (!serviceKey) return null;

  const natn = natnForSym(sym);
  const url = buildKotraUrl({
    serviceKey,
    natn,
    title: rawQuery,
    rows: 10,
    page: 1,
    includeText: true
  });

  const headers = { Accept: 'application/json' };
  // KOTRA will often return XML on auth/param error; soft-fail to keep other providers running.
  const j = await withRetry(() => cachedJson(url, async (u) => {
    try { return await safeGetJson(u, headers); }
    catch (e) {
      if (String(e.message).includes('non-JSON payload')) {
        return { response: { header: { resultCode: 'XX' }, body: {} } };
      }
      throw e;
    }
  }, 20 * 60 * 1000, true), {max:1, baseMs:600});

  const header = j?.response?.header;
  if (!header || header.resultCode !== '00') return { count: 0, sentiment: 0, blogMentions: 0 };

  const itemsNode = j?.response?.body?.itemList?.item;
  const items = Array.isArray(itemsNode) ? itemsNode : (itemsNode ? [itemsNode] : []);
  const count = Math.min(items.length, 30);
  const hasKw = items.some(it => typeof it?.kwrd === 'string' && it.kwrd.trim());
  return { count, sentiment: 0, blogMentions: hasKw ? Math.min(count, 10) : 0 };
}

async function newsFromGdelt(sym, q){
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&format=json&maxrecords=5&timespan=7d&sort=DateDesc`;
  const j = await withRetry(() => cachedJson(url, async (u)=>{
    try { return await safeGetJson(u, defaultUA, 4000); }
    catch(e){
      if (String(e.message).includes('non-JSON payload')) return { items: [] };
      throw e;
    }
  }, 10*60*1000, true), {max:1, baseMs:800});
  const arr = Array.isArray(j?.articles) ? j.articles : (Array.isArray(j?.items) ? j.items : []);
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
}

/**
 * Main: buildNewsFeatures(symbols, { symbolToName })
 * Returns shape: { [symbol]: { count, sentiment, blogMentions } }
 */
export async function buildNewsFeatures(symbols, opts={}){
  const FINNHUB = process.env.FINNHUB_API_KEY || '';
  const NEWSAPI = process.env.NEWSAPI_KEY || '';
  const SERPAPI = process.env.SERP_API_KEY || '';
  const NAVER_ID = process.env.NAVER_CLIENT_ID || '';
  const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || '';
  const GNEWS = process.env.GNEWS_API || '';

  const nameFile = 'symbolNames.json';
  const cachedNames = (()=>{ try{return JSON.parse(fs.readFileSync(nameFile,'utf8'));}catch{return{}} })();
  const symbolToName = { ...(cachedNames), ...(opts.symbolToName||{}) };

  const baseMap = {};
  const uniq = [];
  for (const s of symbols){
    const b = baseSymbol(s);
    if (!baseMap[b]){ baseMap[b]=s; uniq.push(s); }
  }

  await Promise.all(uniq.map(async (s)=>{
    if (isKR(s) && !symbolToName[s]) {
      try {
        const nm = await getCompanyNameByYahooSymbol(s);
        if (nm){ symbolToName[s]=nm; cachedNames[s]=nm; }
      } catch {}
    }
  }));
  try { fs.writeFileSync(nameFile, JSON.stringify(cachedNames)); } catch {}

  const queries = buildQueries(uniq, { symbolToName });
  const baseOut = {};

  await mapLimit(uniq, NEWS_CONCURRENCY, async (sym)=>{
    const q = queries[sym];
    const name = symbolToName[sym] || sym;
    let feat = { count: 0, sentiment: 0, blogMentions: 0 };
    const preferKotra = process.env.USE_KOTRA_BACKUP === '1' || process.env.PREFER_KOTRA === '1';
    const providers = isKR(sym)
      ? (preferKotra
          ? ['gnews','kotra','naver','serpapi','finnhub','newsapi','gdelt']
          : ['gnews','naver','serpapi','kotra','finnhub','newsapi','gdelt'])
      : ['gnews','serpapi','newsapi','gdelt','finnhub','kotra','naver'];

    let lastErr = null;
    for (const p of providers) {
      try {
        let v = null;
        if (p === 'gnews') v = await guardedCall('gnews', () => with429Retry(() => newsFromGNews(sym, q, GNEWS), 2, 600));
        else if (p === 'finnhub') v = await guardedCall('finnhub', () => newsFromFinnhub(sym, FINNHUB));
        else if (p === 'serpapi') v = await guardedCall('serpapi', () => newsFromSerpApi(sym, name, SERPAPI));
        else if (p === 'newsapi') v = await guardedCall('newsapi', () => newsFromNewsAPI(sym, q, NEWSAPI));
        else if (p === 'kotra') v = await guardedCall('kotra', () => newsFromKotra(sym, q));
        else if (p === 'gdelt') v = await guardedCall('gdelt', () => newsFromGdelt(sym, q));
        else v = await guardedCall('naver', () => newsFromNaver(name, NAVER_ID, NAVER_SECRET));
        if (v && v.count > 0) {
          if (!SKIP_NAVER) {
            try {
              const blogs = await guardedCall('naver', () => blogFromNaver(name, NAVER_ID, NAVER_SECRET));
              v.blogMentions = Math.max(v.blogMentions || 0, blogs || 0);
            } catch {}
          }
          baseOut[baseSymbol(sym)] = v;
          return;
        }
      } catch (e) {
        lastErr = e;
        console.warn(`[news] ${sym} provider ${p} failed: ${e.message}`);
      }
    }
    if (lastErr) console.warn(`[news] providers exhausted for ${sym}. Last: ${lastErr.message}`);
    baseOut[baseSymbol(sym)] = feat;
  });

  const out = {};
  for (const s of symbols){
    out[s] = baseOut[baseSymbol(s)] || { count:0, sentiment:0, blogMentions:0 };
  }
  return out;
}

// --- helpers for KOTRA key handling (replace old chooseEncodedServiceKey) ---
function chooseApiKey(name){
  const dec = (process.env[`${name}_DECODED`] || '').trim();
  const enc = (process.env[name] || '').trim();
  if (dec) return dec;
  try { return decodeURIComponent(enc); } catch { return enc; }
}
function chooseServiceKeyForDataGoKr(){
  // Precedence: plain first, then encoded
  const candidates = [
    (process.env.DATA_API_KEY || '').trim(),        // preferred (decoded)
    (process.env.DATA_API_KEY_DECODED || '').trim(),// legacy plain
    (process.env.DATA_API_KEY_ENCODED || '').trim(),// legacy encoded
    (process.env.DATA_ENCODE_KEY || '').trim(),     // your encoded key
  ].filter(Boolean);
  if (!candidates.length) return '';
  const first = candidates[0];
  if (/%[0-9A-Fa-f]{2}/.test(first)) { // looks encoded
    try { return decodeURIComponent(first); } catch { /* fallthrough */ }
  }
  return first;
}
export function chooseKrxApiKey(){ return chooseApiKey('KRX_API_KEY'); }

function normalizeNewsApiArticle(it) {
  const title = it?.title || "";
  const url = it?.url || "";
  if (!title || !url) return null;
  const date = it?.publishedAt ? new Date(it.publishedAt).toISOString() : new Date().toISOString();
  const source = it?.source?.name || "NewsAPI";
  return { title, url, source, publishedAt: date };
}

function normalizeNaverArticle(it) {
  const title = (it?.title || "").replace(/<[^>]*>/g, "").trim();
  const url = (it?.originallink || it?.link || "").trim();
  if (!title || !url) return null;
  const date = it?.pubDate ? new Date(it.pubDate).toISOString() : new Date().toISOString();
  return { title, url, source: "Naver", publishedAt: date };
}

function normalizeGNewsArticle(it) {
  const title = it?.title || "";
  const url = it?.url || "";
  if (!title || !url) return null;
  const date = it?.publishedAt ? new Date(it.publishedAt).toISOString() : new Date().toISOString();
  const source = it?.source?.name || "GNews";
  return { title, url, source, publishedAt: date };
}

function dedupeArticles(items) {
  const seen = new Set();
  return items.filter(it => {
    const u = (it?.url || "").trim();
    if (!u || seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

async function getTickerArticlesPrimary(ticker) {
  const out = [];
  const NEWSAPI = process.env.NEWSAPI_KEY || "";
  if (NEWSAPI) {
    try {
      const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(ticker)}&language=en&pageSize=20&sortBy=publishedAt&apiKey=${NEWSAPI}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'stock-recs/1.0 (+github-actions)' } });
      const j = await res.json();
      const arr = Array.isArray(j?.articles) ? j.articles : [];
      out.push(...arr.map(normalizeNewsApiArticle).filter(Boolean));
    } catch {}
  }
  const NAVER_ID = process.env.NAVER_CLIENT_ID || "";
  const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || "";
  if (!SKIP_NAVER && NAVER_ID && NAVER_SECRET) {
    try {
      const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(ticker)}&display=20&sort=date`;
      const headers = { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET };
      const res = await fetch(url, { headers });
      const j = await res.json();
      const arr = Array.isArray(j?.items) ? j.items : [];
      out.push(...arr.map(normalizeNaverArticle).filter(Boolean));
    } catch {}
  }
  const GNEWS = process.env.GNEWS_API || "";
  if (GNEWS) {
    try {
      const lang = /\.K[QS]$/.test(ticker) ? 'ko' : 'en';
      const q = ticker.replace(/\.[A-Z]+$/,'');
      const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=${lang}&max=20&apikey=${GNEWS}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'stock-recs/1.0 (+github-actions)' } });
      const j = await res.json();
      const arr = Array.isArray(j?.articles) ? j.articles : [];
      out.push(...arr.map(normalizeGNewsArticle).filter(Boolean));
    } catch {}
  }
  return dedupeArticles(out);
}

export async function getTickerArticles(ticker) {
  const primary = await getTickerArticlesPrimary(ticker).catch(e => {
    console.error(`[news] primary failed for ${ticker}:`, e.message);
    return [];
  });
  if (primary?.length) return primary;

  if (process.env.USE_KOTRA_BACKUP === "1") {
    try {
      const name = await getCompanyNameByYahooSymbol(ticker);
      if (name) {
        // Pull ~100–150 recent items then keyword-match by company name
        const kotra = await fetchKotraRecent({ pages: 3, pageSize: 50, keyword: name });
        if (kotra.length) {
          console.log(`[kotra-backup] ${ticker}: ${kotra.length} items`);
          return kotra.slice(0, 20);
        }
      }
    } catch (e) {
      console.error(`[kotra-backup] ${ticker} backup failed:`, e.message);
    }
  }

  return primary ?? [];
}

