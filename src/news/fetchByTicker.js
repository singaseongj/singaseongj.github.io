import fs from 'fs';
import path from 'path';
import { fetchKotraRecent } from "./kotraOverseas.js";
import { getCompanyNameByYahooSymbol } from "../data/krxDirectory.js";

const CACHE_DIR = 'cache';
const NEWS_TTL_MS = Number(process.env.NEWS_TTL_MS || 30 * 60 * 1000); // 30m
const NEWS_CONCURRENCY = Number(process.env.NEWS_CONCURRENCY || 2);
const ALLOW_STALE_NEWS = process.env.ALLOW_STALE_NEWS !== '0';
const defaultUA = { 'User-Agent': 'stock-recs/1.0 (+github-actions)' };

// Prefer explicitly encoded key if provided; otherwise encode decoded/plain
function chooseEncodedServiceKey() {
  const enc = process.env.DATA_API_KEY || '';
  const dec = process.env.DATA_API_KEY_DECODED || '';
  const looksEncoded = /%[0-9a-fA-F]{2}/.test(enc);
  if (enc && looksEncoded) return enc;
  if (!enc && dec) return encodeURIComponent(dec);
  if (enc) return encodeURIComponent(enc);
  return '';
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
async function safeGetJson(url, headers={}){
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers?.get?.('content-type') || '';
  if (/json/i.test(ct)) return await res.json();
  const txt = await res.text();
  if (looksLikeXmlOrHtml(txt)) throw new Error(`non-JSON payload (${ct||'unknown'})`);
  try{ return JSON.parse(txt); } catch(e){ throw new Error(`JSON parse failed (${ct||'unknown'}): ${e.message}`); }
}

function isKR(sym){ return /\.K[QS]$/.test(sym); }

/**
 * Build a compact symbol→query dictionary.
 * - For KR symbols: prefer Korean display name if provided (opts.symbolToName), else the numeric code.
 * - For US: use ticker + display name to help NewsAPI.
 */
function buildQueries(symbols, { symbolToName={} }={}){
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

async function with429Retry(fn, max=1, baseMs=400){
  let last; for (let i=0;i<=max;i++){
    try { return await fn(); } catch(e){
      last = e;
      if (!/HTTP 429/.test(String(e))) break;
      if (i<max) await new Promise(r=>setTimeout(r, Math.floor(baseMs*Math.pow(2,i)*(0.6+Math.random()*0.6))));
    }
  } throw last;
}

/**
 * Provider calls (each returns a {count, sentiment?, blogMentions?} shape or null)
 */
async function newsFromFinnhub(sym, FINNHUB){
  if (!FINNHUB) return null;
  const to = new Date().toISOString().slice(0,10);
  const from = new Date(Date.now()-7*864e5).toISOString().slice(0,10);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}&token=${FINNHUB}`;
  const j = await cachedJson(url, (u)=>safeGetJson(u, defaultUA), 20*60*1000, true);
  const arr = Array.isArray(j) ? j : [];
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
}

async function newsFromNewsAPI(sym, q, NEWSAPI){
  if (!NEWSAPI) return null;
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&pageSize=10&sortBy=publishedAt&apiKey=${NEWSAPI}`;
  const j = await cachedJson(url, (u)=>safeGetJson(u, defaultUA), 20*60*1000, true);
  const arr = Array.isArray(j?.articles) ? j.articles : [];
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
}

async function newsFromNaver(sym, q, NAVER_ID, NAVER_SECRET){
  if (!NAVER_ID || !NAVER_SECRET) return null;
  // news search (date-sorted); we only need a small page to decide "non-zero"
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(q)}&display=10&sort=date`;
  const headers = { ...defaultUA, 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET };
  const j = await cachedJson(url, (u)=>safeGetJson(u, headers), 20*60*1000, true);
  const arr = Array.isArray(j?.items) ? j.items : [];
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
}

async function blogFromNaver(q, NAVER_ID, NAVER_SECRET){
  if (!NAVER_ID || !NAVER_SECRET) return 0;
  const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(q)}&display=10&sort=date`;
  const headers = { ...defaultUA, 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET };
  const j = await cachedJson(url, (u)=>safeGetJson(u, headers), 20*60*1000, true);
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
  const serviceKey = chooseEncodedServiceKey();
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
  const j = await cachedJson(url, (u) => safeGetJson(u, headers), 20 * 60 * 1000, true);

  const header = j?.response?.header;
  if (!header || header.resultCode !== '00') return { count: 0, sentiment: 0, blogMentions: 0 };

  const itemsNode = j?.response?.body?.itemList?.item;
  const items = Array.isArray(itemsNode) ? itemsNode : (itemsNode ? [itemsNode] : []);
  const count = Math.min(items.length, 30);
  const hasKw = items.some(it => typeof it?.kwrd === 'string' && it.kwrd.trim());
  return { count, sentiment: 0, blogMentions: hasKw ? Math.min(count, 10) : 0 };
}

/**
 * Main: buildNewsFeatures(symbols, { symbolToName })
 * Returns shape: { [symbol]: { count, sentiment, blogMentions } }
 */
export async function buildNewsFeatures(symbols, opts={}){
  const FINNHUB = process.env.FINNHUB_API_KEY || '';
  const NEWSAPI = process.env.NEWSAPI_KEY || '';
  const NAVER_ID = process.env.NAVER_CLIENT_ID || '';
  const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || '';

  const queries = buildQueries(symbols, opts);
  const out = {};

  await mapLimit(symbols, NEWS_CONCURRENCY, async (sym)=>{
    const q = queries[sym];
    let feat = { count: 0, sentiment: 0, blogMentions: 0 };
    const isKr = /\.K[QS]$/.test(sym);
    const providers = isKr
      ? ['naver', 'kotra', 'finnhub', 'newsapi']
      : ['finnhub', 'newsapi', 'kotra', 'naver'];
    try {
      for (const p of providers) {
        let v = null;
        if (p === 'finnhub') v = await newsFromFinnhub(sym, FINNHUB);
        else if (p === 'newsapi') v = await with429Retry(() => newsFromNewsAPI(sym, q, NEWSAPI), 1);
        else if (p === 'kotra') v = await newsFromKotra(sym, q);
        else v = await newsFromNaver(sym, q, NAVER_ID, NAVER_SECRET);
        if (v && v.count > 0) {
          try {
            const blogs = await blogFromNaver(q, NAVER_ID, NAVER_SECRET);
            v.blogMentions = Math.max(v.blogMentions || 0, blogs);
          } catch {}
          out[sym] = v;
          return;
        }
      }
    } catch (e) {
      console.warn(`[news] providers failed for ${sym}: ${e.message}`);
    }
    out[sym] = feat;
  });

  return out;
}

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
  if (NAVER_ID && NAVER_SECRET) {
    try {
      const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(ticker)}&display=20&sort=date`;
      const headers = { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET };
      const res = await fetch(url, { headers });
      const j = await res.json();
      const arr = Array.isArray(j?.items) ? j.items : [];
      out.push(...arr.map(normalizeNaverArticle).filter(Boolean));
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

