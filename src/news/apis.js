import { withRetry, fetchWithTimeout } from '../util/limiter.js';

const NEWSAPI_KEY = process.env.NEWSAPI_KEY || '';
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || '';
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || '';
const UA = 'ddsciencehs-trender/1.0 (+github actions)';

export async function fetchNews(topic) {
  if (!NEWSAPI_KEY) return null;
  try {
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(topic)}&apiKey=${NEWSAPI_KEY}`;
    const res = await withRetry(() =>
      fetchWithTimeout(
        url,
        { headers: { 'User-Agent': UA } },
        Number(process.env.REQ_TIMEOUT_MS || 5000)
      )
    );
    if (!res.ok) throw new Error(`NewsAPI HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn('fetchNews failed', err.message);
    return null;
  }
}

export async function fetchNaverTrends(keyword) {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) return null;
  try {
    const url = 'https://openapi.naver.com/v1/datalab/search';
    const body = {
      startDate: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      endDate: new Date().toISOString().slice(0, 10),
      timeUnit: 'date',
      keywordGroups: [{ groupName: 'trend', keywords: [keyword] }]
    };
    const res = await withRetry(() =>
      fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'X-Naver-Client-Id': NAVER_CLIENT_ID,
            'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
            'Content-Type': 'application/json',
            'User-Agent': UA
          },
          body: JSON.stringify(body)
        },
        Number(process.env.REQ_TIMEOUT_MS || 5000)
      )
    );
    if (!res.ok) throw new Error(`Naver API HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn('fetchNaverTrends failed', err.message);
    return null;
  }
}

export { NEWSAPI_KEY, NAVER_CLIENT_ID, NAVER_CLIENT_SECRET };
