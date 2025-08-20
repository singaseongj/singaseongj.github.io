import { aggregate } from './sentiment.js';
import { TICKER_MAP } from '../maps.js';
import { fetchNews, fetchNaverTrends, fetchNaverBlogCount, NEWSAPI_KEY } from './apis.js';
import { withRetry, fetchWithTimeout } from '../util/limiter.js';

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
      const titles = Array.from(txt.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)).slice(1).map(m=>m[1]);
      const agg = aggregate(titles, 'kr');
      const pop = await naverPopularityScore(name || symbol);
      const blog = await naverBlogMentions(name || symbol);
      return { count: titles.length, sentiment: agg.sentiment, top: agg.top, naverPopularity: pop, blogMentions: blog };
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
      const titles = Array.isArray(data) ? data.map(d=>d.headline) : [];
      const agg = aggregate(titles, 'en');
      return { count: titles.length, sentiment: agg.sentiment, top: agg.top };
    } else if (NEWSAPI_KEY) {
      const data = await fetchNews(name || symbol);
      const titles = Array.isArray(data?.articles) ? data.articles.map(a => a.title) : [];
      const agg = aggregate(titles, 'en');
      return { count: titles.length, sentiment: agg.sentiment, top: agg.top };
    }
  } catch {}
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
