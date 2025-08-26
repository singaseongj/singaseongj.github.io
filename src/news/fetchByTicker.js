import fs from 'fs';
import path from 'path';

const CACHE_DIR = 'cache';
const NEWS_TTL_MS = Number(process.env.NEWS_TTL_MS || 30 * 60 * 1000); // 30m
const NEWS_CONCURRENCY = Number(process.env.NEWS_CONCURRENCY || 2);
const ALLOW_STALE_NEWS = process.env.ALLOW_STALE_NEWS !== '0';

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
    if (isKR(s)){
      // KR: name is often Korean; fallback to raw symbol if not
      q[s] = encodeURIComponent(name || s);
    } else {
      // US: include both ticker and name to reduce ambiguity
      q[s] = encodeURIComponent(`${s} ${name}`);
    }
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

/**
 * Provider calls (each returns a {count, sentiment?, blogMentions?} shape or null)
 */
async function newsFromFinnhub(sym, FINNHUB){
  if (!FINNHUB) return null;
  const to = new Date().toISOString().slice(0,10);
  const from = new Date(Date.now()-7*864e5).toISOString().slice(0,10);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}&token=${FINNHUB}`;
  const j = await cachedJson(url, (u)=>safeGetJson(u), 20*60*1000, true);
  const arr = Array.isArray(j) ? j : [];
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
}

async function newsFromNewsAPI(sym, q, NEWSAPI){
  if (!NEWSAPI) return null;
  const url = `https://newsapi.org/v2/everything?q=${q}&language=en&pageSize=20&sortBy=publishedAt&apiKey=${NEWSAPI}`;
  const j = await cachedJson(url, (u)=>safeGetJson(u), 20*60*1000, true);
  const arr = Array.isArray(j?.articles) ? j.articles : [];
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
}

async function newsFromNaver(sym, q, NAVER_ID, NAVER_SECRET){
  if (!NAVER_ID || !NAVER_SECRET) return null;
  // news search (date-sorted); we only need a small page to decide "non-zero"
  const url = `https://openapi.naver.com/v1/search/news.json?query=${q}&display=10&sort=date`;
  const headers = { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET };
  const j = await cachedJson(url, (u)=>safeGetJson(u, headers), 20*60*1000, true);
  const arr = Array.isArray(j?.items) ? j.items : [];
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
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

    // 1) Finnhub (fast)
    try {
      const v = await newsFromFinnhub(sym, FINNHUB);
      if (v && v.count > 0) { out[sym] = v; return; }
    } catch (e) {
      console.warn(`[news] Finnhub failed for ${sym}: ${e.message}`);
    }

    // 2) NewsAPI fallback
    try {
      const v = await newsFromNewsAPI(sym, q, NEWSAPI);
      if (v && v.count > 0) { out[sym] = v; return; }
    } catch (e) {
      console.warn(`[news] NewsAPI failed for ${sym}: ${e.message}`);
    }

    // 3) NAVER news fallback (works well for KR, tolerable for US)
    try {
      const v = await newsFromNaver(sym, q, NAVER_ID, NAVER_SECRET);
      if (v && v.count > 0) { out[sym] = v; return; }
    } catch (e) {
      console.warn(`[news] NAVER failed for ${sym}: ${e.message}`);
    }

    // Nothing landed: return neutral
    out[sym] = feat;
  });

  return out;
}
