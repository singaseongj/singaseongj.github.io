import { aggregate } from './sentiment.js';
import { TICKER_MAP } from '../maps.js';
import { fetchNews, fetchNaverTrends, fetchNaverBlogCount, NEWSAPI_KEY } from './apis.js';
import { withRetry, fetchWithTimeout } from '../util/limiter.js';
import { getTickerArticlesBackup } from './fetchByTicker.kotraBackup.js';

const UA = 'ddsciencehs-trender/1.0 (+github actions)';

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

export async function fetchByTicker(symbol, name){
  const out = { count:0, sentiment:null, top:null, naverPopularity:null, blogMentions:null };
  try {
    let titles = [];
    let lang = 'en';
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
    } else if (process.env.FINNHUB_API_KEY) {
      const from = new Date(Date.now()-72*3600*1000).toISOString().slice(0,10);
      const to = new Date().toISOString().slice(0,10);
      const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${process.env.FINNHUB_API_KEY}`;
      const res = await withRetry(() =>
        fetchWithTimeout(
          url,
          { headers: { 'User-Agent': UA } },
          Number(process.env.REQ_TIMEOUT_MS || 5000)
        )
      );
      const data = await res.json();
      titles = Array.isArray(data) ? data.map(d=>d.headline) : [];
    } else if (NEWSAPI_KEY) {
      const data = await fetchNews(name || symbol);
      titles = Array.isArray(data?.articles) ? data.articles.map(a => a.title) : [];
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
    console.error(`[news] primary failed for ${symbol}:`, e.message);
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
  }
  return out;
}

export async function buildNewsFeatures(symbols){
  const feats = {};
  for (const sym of symbols){
    const name = Object.keys(TICKER_MAP).find(k => TICKER_MAP[k] === sym) || sym;
    feats[sym] = await fetchByTicker(sym, name);
  }
  return feats;
}
