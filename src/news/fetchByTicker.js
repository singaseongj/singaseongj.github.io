import fs from 'fs';
import path from 'path';
import { aggregate } from './sentiment.js';
import { TICKER_MAP } from '../maps.js';
import { fetchNaverTrends, fetchNaverBlogCount, NEWSAPI_KEY } from './apis.js';
import { withRetry, fetchWithTimeout } from '../util/limiter.js';
import { getTickerArticlesBackup } from './fetchByTicker.kotraBackup.js';

const CACHE_DIR = 'cache';
const NEWS_TTL_MS = Number(process.env.NEWS_TTL_MS || 60 * 60 * 1000); // 1h
const NEWS_CONCURRENCY = Number(process.env.NEWS_CONCURRENCY || 2);
const ALLOW_STALE_NEWS = process.env.ALLOW_STALE_NEWS !== '0';

const UA = 'ddsciencehs-trender/1.0 (+github actions)';

function looksLikeXmlOrHtml(s) {
  const t = String(s || '').trim();
  return !!t && t.startsWith('<');
}
function cacheKey(url) {
  const h = Buffer.from(url).toString('base64url');
  return path.join(CACHE_DIR, `news-${h}.json`);
}
async function cachedJson(url, fetcher, ttlMs = NEWS_TTL_MS, allowStale = ALLOW_STALE_NEWS) {
  const key = cacheKey(url);
  let stale;
  try {
    const st = fs.statSync(key);
    const age = Date.now() - st.mtimeMs;
    stale = JSON.parse(fs.readFileSync(key, 'utf8'));
    if (age < ttlMs) return stale;
  } catch {}
  try {
    const data = await fetcher(url);
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(key, JSON.stringify(data)); } catch {}
    return data;
  } catch (e) {
    if (allowStale && stale != null) return stale;
    throw e;
  }
}
async function safeGetJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
  if (/json/i.test(ct)) return await res.json();
  const text = await res.text();
  if (looksLikeXmlOrHtml(text)) {
    throw new Error(`non-JSON payload (${ct || 'unknown'})`);
  }
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`JSON parse failed (${ct || 'unknown'}): ${e.message}`); }
}

// Simple concurrency gate
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0, active = 0, rejectOnce;
  await new Promise((resolve, reject) => {
    rejectOnce = reject;
    const next = () => {
      while (active < limit && i < items.length) {
        const idx = i++;
        active++;
        Promise.resolve(worker(items[idx], idx))
          .then(v => { out[idx] = v; active--; next(); })
          .catch(e => { rejectOnce(e); });
      }
      if (i >= items.length && active === 0) resolve();
    };
    next();
  });
  return out;
}

async function naverPopularityScore(name) {
  if (process.env.SKIP_NAVER === '1') return null;
  const json = await fetchNaverTrends(name);
  const series = json?.results?.[0]?.data || [];
  const last = series.slice(-7).map(d => d.ratio || 0);
  if (!last.length) return null;
  const avg = last.reduce((a, b) => a + b, 0) / (7 * 100);
  return Math.max(0, Math.min(1, avg));
}

async function naverBlogMentions(name) {
  if (process.env.SKIP_NAVER === '1') return null;
  const total = await fetchNaverBlogCount(name);
  return total == null ? null : Number(total);
}

export async function fetchByTicker(symbol, name) {
  const out = { count:0, sentiment:null, top:null, naverPopularity:null, blogMentions:null };
  let titles = [];
  let lang = 'en';
  try {
    if (/\.K[QS]$/.test(symbol)) {
      const query = encodeURIComponent(name || symbol);
      const url = `https://news.google.com/rss/search?q=${query}&hl=ko&gl=KR&ceid=KR:ko`;
      const res = await withRetry(() =>
        fetchWithTimeout(
          url,
          { headers: { 'User-Agent': UA } },
          Number(process.env.REQ_TIMEOUT_MS || 5000)
        )
      );
      const txt = await res.text();
      titles = Array.from(txt.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)).slice(1).map(m=>m[1]);
      lang = 'kr';
    } else {
      if (process.env.FINNHUB_API_KEY) {
        try {
          const from = new Date(Date.now()-72*3600*1000).toISOString().slice(0,10);
          const to = new Date().toISOString().slice(0,10);
          const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${process.env.FINNHUB_API_KEY}`;
          const data = await cachedJson(url, (u)=>safeGetJson(u), 30*60*1000, true);
          titles = Array.isArray(data) ? data.map(d=>d.headline) : [];
        } catch (e) {
          console.warn(`[news] Finnhub failed for ${symbol}: ${e.message}`);
        }
      }
      if (!titles.length && NEWSAPI_KEY) {
        try {
          const q = encodeURIComponent(name || symbol);
          const url = `https://newsapi.org/v2/everything?q=${q}&language=en&pageSize=20&sortBy=publishedAt&apiKey=${NEWSAPI_KEY}`;
          const data = await cachedJson(url, (u)=>safeGetJson(u), 30*60*1000, true);
          titles = Array.isArray(data?.articles) ? data.articles.map(a => a.title) : [];
        } catch (e) {
          console.warn(`[news] NewsAPI failed for ${symbol}: ${e.message}`);
        }
      }
    }

    if (!titles.length && process.env.USE_KOTRA_BACKUP === '1') {
      try {
        const backup = await getTickerArticlesBackup(symbol);
        titles = backup.map(x => x.title);
        if (titles.length) console.log(`[kotra-backup] ${symbol}: ${titles.length} items from KOTRA`);
      } catch (e) {
        console.error(`[kotra-backup] ${symbol} backup failed:`, e.message);
      }
    }

    if (titles.length) {
      const agg = aggregate(titles, lang);
      if (/\.K[QS]$/.test(symbol)) {
        const pop = await naverPopularityScore(name || symbol);
        const blog = await naverBlogMentions(name || symbol);
        return { count: titles.length, sentiment: agg.sentiment, top: agg.top, naverPopularity: pop, blogMentions: blog };
      }
      return { count: titles.length, sentiment: agg.sentiment, top: agg.top };
    }
  } catch (e) {
    console.warn(`[news] primary failed for ${symbol}: ${e.message}`);
  }
  if (process.env.USE_KOTRA_BACKUP === '1') {
    try {
      const backup = await getTickerArticlesBackup(symbol);
      const titles = backup.map(x => x.title);
      if (titles.length) {
        const agg = aggregate(titles, /\.K[QS]$/.test(symbol)?'kr':'en');
        return { count: titles.length, sentiment: agg.sentiment, top: agg.top };
      }
    } catch (e2) {
      console.error(`[kotra-backup] ${symbol} backup failed:`, e2.message);
    }
  }
  return out;
}

export async function buildNewsFeatures(symbols){
  const feats = {};
  await mapLimit(symbols, NEWS_CONCURRENCY, async (sym) => {
    const name = Object.keys(TICKER_MAP).find(k => TICKER_MAP[k] === sym) || sym;
    feats[sym] = await fetchByTicker(sym, name);
  });
  return feats;
}

