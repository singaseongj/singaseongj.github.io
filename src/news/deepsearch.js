const API = 'https://api-v2.deepsearch.com';
const KEY = process.env.DEEPS_API_KEY || process.env.DEEPSEARCH_API_KEY || '';

const HEADERS = KEY
  ? { Authorization: `Bearer ${KEY}` }
  : {};

const DS_MAX_PAGES = +process.env.DS_MAX_PAGES || 2;
const DS_RECENT_D = +process.env.DS_RECENT_D || 1;
const DS_BASE_D = +process.env.DS_BASE_D || 7;

export function toDeepsearchSymbol(ticker, market) {
  if (!ticker) return null;
  const mKr = ticker.match(/^(\d{6})\.(KS|KQ)$/i);
  if (mKr) return `KRX:${mKr[1]}`;
  if (/^[A-Z]+:[A-Z.\-]+$/.test(ticker)) return ticker;
  if (market?.includes('NASDAQ')) return `NASDAQ:${ticker}`;
  if (/^[A-Z.\-]{1,6}$/.test(ticker)) return `NYSE:${ticker}`;
  return null;
}

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0,10);
}
function addDaysISO(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}
function rangeISO(daysBack) {
  const to = todayISO();
  const from = addDaysISO(to, -daysBack);
  return { from, to };
}

async function apiGet(path, params = {}) {
  const url = new URL(API + path);
  for (const [k,v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!r.ok) throw new Error(`DeepSearch ${r.status} ${await r.text()}`);
  return r.json();
}

function pickBase(market) {
  const isKR = /(KOSPI|KOSDAQ|KRX)/i.test(market || '');
  return { isKR, base: isKR ? '/v1/articles' : '/v1/global-articles' };
}

function buildQueryArgs({ name, ticker, market }) {
  const sym = toDeepsearchSymbol(ticker, market);
  if (sym) return { symbols: sym };
  if (name) return { company_name: name };
  return { keyword: (name || ticker || '').trim() };
}

async function getDailyCounts({ name, ticker, market }, days) {
  const { base } = pickBase(market);
  const { from, to } = rangeISO(days);
  const q = buildQueryArgs({ name, ticker, market });

  const counts = new Map();
  for (let page = 1; page <= DS_MAX_PAGES; page++) {
    const js = await apiGet(`${base}`, {
      ...q, date_from: from, date_to: to, page, page_size: 100, order: 'published_at'
    }).catch(() => null);
    if (!js?.data?.length) break;
    for (const it of js.data) {
      const dt = (it.published_at || it.date || it.created_at || '').slice(0,10);
      if (dt) counts.set(dt, (counts.get(dt) || 0) + 1);
    }
    const totalPages = js.total_pages || page;
    if (page >= totalPages) break;
  }
  const out = [];
  for (let d = from; d <= to; d = addDaysISO(d, 1)) {
    out.push({ date: d, count: counts.get(d) || 0 });
  }
  return out;
}

async function getTopicBoost({ name, ticker, market }) {
  const { base } = pickBase(market);
  const q = buildQueryArgs({ name, ticker, market });

  const path = `${base}/topics/trending`;
  const js = await apiGet(path, { ...q, order: 'published_at', page_size: 5 }).catch(() => null);
  if (!js?.data?.length) return 0;

  let score = 0;
  for (const it of js.data) {
    const r = Number(it.rank);
    if (Number.isFinite(r) && r > 0) score += 1 / r;
  }
  const capped = Math.min(score, 1.5);
  return capped / 1.5;
}

function featuresFromDaily(daily) {
  if (!daily?.length) {
    return { news1d:0, news7d:0, burst:0, slope7d:0 };
  }
  const n = daily.length;
  const last = daily[n-1]?.count || 0;
  const news7d = daily.reduce((s, x) => s + x.count, 0);
  const recentDays = Math.max(1, Math.min(DS_RECENT_D, n));
  const baseDays   = Math.max(1, Math.min(DS_BASE_D, n));

  const news1d = daily.slice(-recentDays).reduce((s,x)=>s+x.count,0);
  const prevBase = daily.slice(0, n - recentDays).slice(-(baseDays)).reduce((s,x)=>s+x.count,0) / baseDays;
  const burst = prevBase > 0 ? (news1d / prevBase) : (news1d > 0 ? 1 : 0);

  const arr = daily.slice(-baseDays).map(d => d.count);
  const k = arr.length;
  let sx=0, sy=0, sxx=0, sxy=0;
  for (let i=0;i<k;i++){ const x=i+1, y=arr[i]; sx+=x; sy+=y; sxx+=x*x; sxy+=x*y; }
  const denom = k*sxx - sx*sx;
  const slope = denom !== 0 ? (k*sxy - sx*sy) / denom : 0;
  const slope7d = Math.max(0, Math.min(1, slope / 10));

  return { news1d, news7d, burst, slope7d };
}

export async function fetchDeepsearchFeatures({ name, ticker, market }) {
  if (!KEY) {
    return { ds_news7:0, ds_burst:0, ds_slope7:0, ds_topic:0, ds_trend:0 };
  }
  const daily = await getDailyCounts({ name, ticker, market }, Math.max(DS_BASE_D, 7)).catch(() => []);
  const { news7d, burst, slope7d } = featuresFromDaily(daily);
  const topic = await getTopicBoost({ name, ticker, market }).catch(() => 0);

  const ds_trend = Math.max(0, Math.min(1, 0.5*(burst>0? Math.min(burst,3)/3 : 0) + 0.35*slope7d + 0.15*topic));

  return {
    ds_news7: news7d|0,
    ds_burst: +burst.toFixed(3),
    ds_slope7: +slope7d.toFixed(3),
    ds_topic: +topic.toFixed(3),
    ds_trend: +ds_trend.toFixed(3),
  };
}
