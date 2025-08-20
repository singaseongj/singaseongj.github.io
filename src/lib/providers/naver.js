import { fetchWithTimeout } from '../utils/timeoutFetch.js';
import { withRetry } from '../utils/retry.js';

const NAVER_ID = process.env.NAVER_CLIENT_ID;
const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET;

function naverDisabled(){
  return process.env.SKIP_NAVER === '1' || !NAVER_ID || !NAVER_SECRET;
}

export async function dataLabPopularity({ query, startDate, endDate, timeUnit='week' }){
  if (naverDisabled()) return { popularity: null };
  const body = {
    startDate, endDate, timeUnit,
    keywordGroups: [{ groupName: query, keywords: [query] }],
    device: 'pc'
  };
  const url = 'https://openapi.naver.com/v1/datalab/search';
  try {
    const res = await withRetry(() => fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'X-Naver-Client-Id': NAVER_ID,
        'X-Naver-Client-Secret': NAVER_SECRET,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      timeout: 6000
    }));
    if (!res.ok) return { popularity: null };
    const json = await res.json();
    const series = (json.results?.[0]?.data || []).map(d => d.ratio).slice(-8);
    if (!series.length) return { popularity: null };
    const max = Math.max(...series), min = Math.min(...series);
    const avg = series.reduce((a,b)=>a+b,0)/series.length;
    const popularity = max===min ? 0.5 : (avg - min)/(max - min);
    return { popularity };
  } catch {
    return { popularity: null };
  }
}

export async function blogSearch({ query }){
  if (naverDisabled()) return { blogScore: null, total: 0 };
  const url = 'https://openapi.naver.com/v1/search/blog?query=' + encodeURIComponent(query);
  try {
    const res = await withRetry(() => fetchWithTimeout(url, {
      headers: {
        'X-Naver-Client-Id': NAVER_ID,
        'X-Naver-Client-Secret': NAVER_SECRET
      },
      timeout: 6000
    }));
    if (!res.ok) return { blogScore: null, total: 0 };
    const json = await res.json();
    const total = Number(json.total || 0);
    const blogScore = Math.max(0, Math.min(1, Math.log10(1 + total) / 6));
    return { blogScore, total };
  } catch {
    return { blogScore: null, total: 0 };
  }
}
