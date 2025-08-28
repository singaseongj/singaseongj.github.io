// fetchStockInfo.js — improved version with fallbacks and KOSDAQ stocks
import fs, { writeFile, rename, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'node:path';
import { nowKSTISO } from './utils/time.js';

const poolsMetricsRaw = JSON.parse(
  await readFile(new URL('./pools-metrics.json', import.meta.url), 'utf8')
);
const newsFeatures = JSON.parse(
  await readFile(new URL('./data/news-features.json', import.meta.url), 'utf8')
);
const naverTrends = JSON.parse(
  await readFile(new URL('./data/naver-trends.json', import.meta.url), 'utf8')
);

const OUT_FILE = path.resolve(process.cwd(), 'recommendations.json');
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const ARGS = new Set(process.argv.slice(2));
const FORCE = ARGS.has('--force');
const SKIP_FRESH = ARGS.has('--skip-fresh');
const DELAY_ARG = Number((process.argv.find(a => a.startsWith('--delay=')) || '').split('=')[1]);
const CACHE_FILE = path.resolve(process.cwd(), 'ticker-cache.json');
const POOLS_PATH = path.resolve(process.cwd(), 'pools.json');
const POOLS_CACHE = path.resolve(process.cwd(), 'pools-cache.json');
const POOLS_TTL_MS = Number(process.env.POOLS_TTL_MS || 24 * 60 * 60 * 1000); // default 24h
const POOLS_URL = process.env.POOLS_URL || ''; // optional remote JSON endpoint
const REFRESH_POOLS = ARGS.has('--refresh-pools');

// Naver News API (presence check only; we link to SERP)
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID || process.env.NAVER_ID || '';
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET || process.env.NAVER_SECRET || '';
const NAVER_NEWS_ENDPOINT = 'https://openapi.naver.com/v1/search/news.json';
const NAVER_ENABLED = Boolean(NAVER_CLIENT_ID && NAVER_CLIENT_SECRET);

// Cache TTLs
const NEWS_TTL_MS = Number(process.env.NEWS_TTL_MS || 12 * 60 * 60 * 1000);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 429-aware delay
let consecutive429 = 0;
function nextDelay() {
  if (Number.isFinite(DELAY_ARG) && DELAY_ARG > 0) return DELAY_ARG;
  const base = FORCE ? 500 : 1200;
  const jitter = Math.floor(Math.random() * (FORCE ? 200 : 800));
  const penalty = Math.min(consecutive429 * 500, 5000); // back off when throttled
  return base + jitter + penalty;
}

async function fetchWithRetry(url, options = {}, { retries = 3, base = 800, jitter = true } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (![429, 500, 502, 503, 504].includes(res.status)) throw new Error(`HTTP ${res.status}`);
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) {
      const backoff = base * Math.pow(2, attempt) + (jitter ? Math.floor(Math.random() * base) : 0);
      console.log(`[RETRY] ${attempt + 1}/${retries} after ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

function noteStatus(err) {
  if ((/HTTP 429/).test(String(err))) {
    consecutive429++;
    if (consecutive429 >= 3) {
      console.log(`[THROTTLE] Detected ${consecutive429} consecutive 429s, slowing down`);
    }
  } else {
    consecutive429 = 0;
  }
}

async function isFreshFile(p) {
  try {
    const s = await fs.stat(p);
    return (Date.now() - s.mtimeMs) < MAX_AGE_MS;
  } catch {
    return false;
  }
}

function seededRandom(seed) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => (
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909),
    (h >>> 0) / 2 ** 32
  );
}

function pickDeterministic(arr, k, seed) {
  const rnd = seededRandom(seed), a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

async function writeAtomically(dest, data) {
  const tmp = dest + '.tmp';
  await writeFile(tmp, data);
  await rename(tmp, dest);
}

async function loadJsonSafe(p) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } }
async function isFresh(p, ttlMs) { try { const s = await fs.stat(p); return (Date.now() - s.mtimeMs) < ttlMs; } catch { return false; } }

function validatePoolsSchema(pools) {
  if (!pools || typeof pools !== 'object') throw new Error('pools not object');
  for (const [m, b] of Object.entries(pools)) {
    if (!b || !Array.isArray(b.safe) || !Array.isArray(b.aggressive)) {
      throw new Error(`invalid pools schema at ${m}`);
    }
  }
}

async function fetchPoolsRemote() {
  if (!POOLS_URL) return null;
  try {
    const res = await fetchWithRetry(POOLS_URL, { headers: HEADERS_JSON });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    validatePoolsSchema(j);
    await writeAtomically(POOLS_CACHE, JSON.stringify(j, null, 2));
    return j;
  } catch (e) {
    console.warn('[POOLS] Remote fetch failed:', e.message);
    return null;
  }
}

async function loadPools() {
  if (POOLS_URL && (REFRESH_POOLS || !(await isFresh(POOLS_CACHE, POOLS_TTL_MS)))) {
    const remote = await fetchPoolsRemote();
    if (remote) return remote;
  }
  const cached = await loadJsonSafe(POOLS_CACHE);
  if (cached) { try { validatePoolsSchema(cached); return cached; } catch {} }
  const local = await loadJsonSafe(POOLS_PATH);
  if (local) { validatePoolsSchema(local); return local; }

  // Embedded last-resort fallback — (optional) keep a tiny minimal set
  return {
    KOSPI: { safe: ['삼성전자'], aggressive: ['POSCO퓨처엠'] },
    KOSDAQ: { safe: ['셀트리온헬스케어'], aggressive: ['에코프로비엠'] },
    'NASDAQ 100': { safe: ['Apple','Microsoft'], aggressive: ['NVIDIA'] },
    'S&P 500': { safe: ['Berkshire Hathaway (B)'], aggressive: ['Eli Lilly'] }
  };
}

function rotateFromPools(pools, prevData) {
  const seed = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const out = structuredClone(prevData || {});
  for (const [market, buckets] of Object.entries(pools)) {
    if (!hasAnyCandidates(buckets)) continue;
    out[market] = out[market] || {};
    for (const bucket of ['safe', 'aggressive']) {
      const src = buckets[bucket] || [];
      if (src.length === 0) continue;
      let candidates = src.slice();
      if (bucket === 'aggressive' && out[market]?.safe) {
        const safeNames = new Set(out[market].safe.map(e => typeof e === 'string' ? e : e.name));
        candidates = candidates.filter(n => !safeNames.has(n));
      }
      const picked = pickDeterministic(candidates, 5, `${seed}:${market}:${bucket}`);
      out[market][bucket] = picked.map(n => ({ name: n }));
    }
  }
  return out;
}

function hasAnyCandidates(buckets) {
  if (!buckets) return false;
  const s = Array.isArray(buckets.safe) ? buckets.safe.length : 0;
  const a = Array.isArray(buckets.aggressive) ? buckets.aggressive.length : 0;
  return (s + a) > 0;
}

function pruneEmptyMarkets(out) {
  for (const m of Object.keys(out)) {
    if (m === 'lastUpdated') continue;
    const s = out[m]?.safe?.length || 0;
    const a = out[m]?.aggressive?.length || 0;
    if ((s + a) === 0) delete out[m];
  }
}

function totalCount(out) {
  let n = 0;
  for (const m of Object.keys(out)) {
    if (m === 'lastUpdated') continue;
    n += (out[m]?.safe?.length || 0) + (out[m]?.aggressive?.length || 0);
  }
  return n;
}

function calcRawScore(market, tier, name, ticker) {
  const marketData = poolsMetricsRaw.markets?.[market] || poolsMetricsRaw[market];
  const metrics = marketData?.[name];
  const base = typeof metrics?.score?.[tier] === 'number' ? metrics.score[tier] : 0;
  const news = ticker ? (newsFeatures[ticker] || {}) : {};
  const trend = ticker ? (naverTrends[ticker] || {}) : {};
  const rnd = seededRandom(ticker || name);
  const jitter = rnd() * 0.01;

  const signals = [];
  const baseWeights = { sentiment: 0.1, count: 0.01, blog: 0.15, naver: 0.3 };
  if (typeof news.sentiment === 'number') signals.push({ v: news.sentiment, w: baseWeights.sentiment });
  if (typeof news.count === 'number') signals.push({ v: news.count, w: baseWeights.count });
  if (typeof news.blogMentions === 'number') signals.push({ v: news.blogMentions, w: baseWeights.blog });
  if (typeof trend.naverPopularity === 'number') signals.push({ v: trend.naverPopularity, w: baseWeights.naver });

  const totalOrig = baseWeights.sentiment + baseWeights.count + baseWeights.blog + baseWeights.naver;
  const totalAvail = signals.reduce((s, x) => s + x.w, 0);
  const scale = totalAvail > 0 ? totalOrig / totalAvail : 0;
  const extra = signals.reduce((s, x) => s + x.v * x.w * scale, 0);

  return base + extra + jitter;
}

function scaleScores(entries, tier) {
  const raws = entries.map(e => e.rawScore);
  const min = Math.min(...raws);
  const max = Math.max(...raws);
  for (const e of entries) {
    const norm = (e.rawScore - min) / (max - min || 1);
    let score = Math.round(50 + norm * 50);
    if (tier === 'safe') score = Math.min(100, score + 5);
    e.score = score;
    delete e.rawScore;
  }
}

// More stable headers
const HEADERS_HTML = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none'
};

const HEADERS_JSON = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'Connection': 'keep-alive'
};

const normalizeForYahoo = s => s.replace(/\./g, '-'); // if you decide to use it later

// Extended static ticker mapping including KOSDAQ
const TICKER_MAP = {
  // KOSPI
  '삼성전자': '005930.KS', 'SK하이닉스': '000660.KS', '삼성바이오로직스': '207940.KS',
  '현대차': '005380.KS', 'LG에너지솔루션': '373220.KS', '한화에어로스페이스': '012450.KS',
  'HD현대일렉트릭': '267260.KS', 'POSCO퓨처엠': '003670.KS', '두산에너빌리티': '034020.KS',
  'HD한국조선해양': '009540.KS', 'POSCO홀딩스': '005490.KS', 'LG화학': '051910.KS',
  'SK텔레콤': '017670.KS', '카카오': '035720.KS', '네이버': '035420.KS', 'NAVER': '035420.KS',
  '셀트리온': '068270.KS', 'BGF리테일': '282330.KS', '기아': '000270.KS', 'LG전자': '066570.KS',
  '삼성SDI': '006400.KS', '에코프로': '086520.KS',

  // KOSDAQ added
  '에코프로비엠': '247540.KQ', '셀트리온헬스케어': '091990.KQ', '천보': '278280.KQ',
  '리노공업': '058470.KQ', 'JYP엔터테인먼트': '035900.KQ', '알테오젠': '196170.KQ',
  '레인보우로보틱스': '277810.KQ', 'HLB': '028300.KQ', '지아이이노베이션': '358570.KQ',
  '펩트론': '087010.KQ', '펄어비스': '263750.KQ', '아이오케이': '078860.KQ',
  'CJ ENM': '035760.KQ',

  // US stocks
  'Microsoft': 'MSFT', 'Apple': 'AAPL', 'NVIDIA': 'NVDA', 'Amazon': 'AMZN',
  'Meta Platforms': 'META', 'Alphabet': 'GOOGL', 'Tesla': 'TSLA', 'Netflix': 'NFLX',
  'Super Micro Computer': 'SMCI', 'Palantir': 'PLTR', 'Arm Holdings': 'ARM',
  'Micron Technology': 'MU', 'UiPath': 'PATH', 'CrowdStrike': 'CRWD',
  'Berkshire Hathaway (B)': 'BRK-B', 'Johnson & Johnson': 'JNJ',
  'Procter & Gamble': 'PG', 'Visa': 'V', 'Coca-Cola': 'KO',
  'ServiceNow': 'NOW', 'Eli Lilly': 'LLY', 'Uber Technologies': 'UBER',
  'NRG Energy': 'NRG', 'JPMorgan Chase': 'JPM', 'UnitedHealth': 'UNH',
  'Moderna': 'MRNA', 'Zoom': 'ZM', 'MongoDB': 'MDB', 'Snowflake': 'SNOW'
};

// Normalizer to match buildPoolsTrendy
function normalizeKey(s) {
  if (s == null) return '';
  let t = String(s).normalize('NFKC');
  try { t = t.replace(/\p{Cf}/gu, ''); } catch {}
  t = t.replace(/[\u00AD\u034F\u061C\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069]/g, '');
  t = t.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').replace(/\uFEFF/g,'');
  t = t.replace(/\u2212/g, '-');
  t = t.replace(/\u00A0|\u1680|[\u2000-\u200A]|\u202F|\u205F|\u3000/g, '');
  t = t.replace(/\s+/g, '').trim();
  return t.toUpperCase();
}

// ---------- Index lookups ----------
let indexes = {};
try {
  indexes = JSON.parse(await readFile(new URL('./src/maps.indexes.json', import.meta.url), 'utf8'));
} catch {}

const rows = [
  ...(indexes.sp500 || []),
  ...(indexes.nasdaq100 || []),
  ...(indexes.kospi200 || []),
  ...(indexes.kosdaq100 || []),
];

const SYMBOL_TO_NAME = Object.fromEntries(rows.filter(r => r.symbol && r.name).map(r => [r.symbol, r.name]));

const SECTOR_NORMALIZE = {
  'Information Technology': 'Technology',
  'Health Care': 'Healthcare',
  'Communication Services': 'Communication Services',
  'Consumer Discretionary': 'Consumer Discretionary',
  'Consumer Staples': 'Consumer Staples',
  'Financials': 'Financial Services',
  'Industrials': 'Industrials',
  'Materials': 'Materials',
  'Utilities': 'Utilities',
  'Real Estate': 'Real Estate',
  'Energy': 'Energy',
};
const INDEX_SECTOR = Object.fromEntries(
  rows
    .filter(r => r.symbol && r.sector)
    .map(r => [r.symbol, SECTOR_NORMALIZE[r.sector] || r.sector])
);

const INDEX_SYMBOL_SET = new Set(Object.keys(SYMBOL_TO_NAME));

// Helpful canonicalizer for tickers with class separators
function canonSymbol(s) {
  if (!s) return s;
  return String(s).toUpperCase().replace('/', '.').replace('-', '.');
}

// Merge your hard-coded TICKER_MAP with index map names so both directions exist.
const STATIC_MAP = (() => {
  const merged = { ...TICKER_MAP };
  for (const [sym, nm] of Object.entries(SYMBOL_TO_NAME)) {
    if (nm) merged[nm] = sym;
  }
  const out = {};
  for (const [k, v] of Object.entries(merged)) out[normalizeKey(k)] = v;
  return out;
})();

// Extended static sector mapping (consistent naming)
const STATIC_SECTORS = {
  // KOSPI
  '005930.KS': 'Technology', '000660.KS': 'Technology', '005380.KS': 'Consumer Discretionary',
  '051910.KS': 'Materials', '035720.KS': 'Communication Services', '035420.KS': 'Communication Services',
  '005490.KS': 'Materials', '267260.KS': 'Industrials', '012450.KS': 'Industrials',
  '034020.KS': 'Industrials', '282330.KS': 'Consumer Staples', '000270.KS': 'Consumer Discretionary',
  '066570.KS': 'Technology', '006400.KS': 'Technology', '086520.KS': 'Materials',
  '003670.KS': 'Materials', '068270.KS': 'Healthcare', '207940.KS': 'Healthcare',

  // KOSDAQ
  '247540.KQ': 'Materials', '091990.KQ': 'Healthcare', '278280.KQ': 'Industrials',
  '058470.KQ': 'Industrials', '035900.KQ': 'Communication Services', '196170.KQ': 'Healthcare',
  '277810.KQ': 'Industrials', '028300.KQ': 'Healthcare', '358570.KQ': 'Technology',
  '087010.KQ': 'Healthcare', '263750.KQ': 'Communication Services', '078860.KQ': 'Technology',
  '035760.KQ': 'Communication Services',

  // US
  'MSFT': 'Technology', 'AAPL': 'Technology', 'NVDA': 'Technology', 'AMZN': 'Consumer Discretionary',
  'META': 'Communication Services', 'GOOGL': 'Communication Services', 'TSLA': 'Consumer Discretionary',
  'NFLX': 'Communication Services', 'SMCI': 'Technology', 'AMD': 'Technology', 'PEP': 'Consumer Staples', 'PLTR': 'Technology', 'ARM': 'Technology',
  'MU': 'Technology', 'PATH': 'Technology', 'CRWD': 'Technology', 'BRK-B': 'Financial Services',
  'JNJ': 'Healthcare', 'PG': 'Consumer Staples', 'V': 'Financial Services', 'KO': 'Consumer Staples',
  'NOW': 'Technology', 'LLY': 'Healthcare', 'UBER': 'Technology', 'NRG': 'Utilities',
  'JPM': 'Financial Services', 'UNH': 'Healthcare', 'MRNA': 'Healthcare', 'ZM': 'Technology',
  'MDB': 'Technology', 'SNOW': 'Technology'
};

// Cache related functions
async function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(await fs.readFile(CACHE_FILE, 'utf-8')); }
  catch { return {}; }
}

async function saveCache(cache) {
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn('[CACHE] Failed to save:', e.message);
  }
}

const SECTOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function cacheGetSector(cache, symbol) {
  const e = cache._sectors?.[symbol];
  if (!e) return undefined;
  if (Date.now() - e.ts > SECTOR_TTL_MS) return undefined;
  return e.value;
}

function cachePutSector(cache, symbol, sector) {
  cache._sectors = cache._sectors || {};
  cache._sectors[symbol] = { value: sector, ts: Date.now() };
}

function cacheGetSearchUrl(cache, name) {
  const nk = normalizeKey(name);
  const e = cache._searchUrls?.[nk];
  if (!e) return undefined;
  if (Date.now() - e.ts > NEWS_TTL_MS) return undefined;
  return e.value; // string URL
}

function cachePutSearchUrl(cache, name, url) {
  const nk = normalizeKey(name);
  cache._searchUrls = cache._searchUrls || {};
  cache._searchUrls[nk] = { value: url, ts: Date.now() };
}

const looksKorean = s => /[가-힣]/.test(s);

// Improved Naver scraping with multiple patterns
async function naverSectorKR(symbol) {
  const m = String(symbol).match(/^(\d{6}).K[QS]$/);
  if (!m) return null;

  const code = m[1];
  const url = `https://finance.naver.com/item/main.naver?code=${code}`;

  try {
    const res = await fetchWithRetry(url, { headers: HEADERS_HTML });
    const html = await res.text();

    const patterns = [
      />업종<\/th>\s*<td[^>]*>([^<]+)/i,
      />업종명<\/dt>\s*<dd[^>]*>([^<]+)/i,
      /"sector"\s*:\s*"([^"]+)"/i,
      /업종\s*<\/span>\s*<span[^>]*>([^<]+)/i
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const sector = match[1].trim();
        if (sector && sector !== '-' && sector !== 'N/A') {
          console.log(`[NAVER] ${symbol}: ${sector}`);
          return sector;
        }
      }
    }
    return null;
  } catch (e) {
    console.warn(`[NAVER] ${symbol}: ${e.message}`);
    return null;
  }
}

async function naverNewsSearchPresence(query) {
  if (!NAVER_ENABLED) return false;
  const params = new URLSearchParams({
    query,
    display: '1',
    start: '1',
    sort: 'date'
  });
  try {
    const res = await fetchWithRetry(`${NAVER_NEWS_ENDPOINT}?${params}`, {
      headers: {
        'X-Naver-Client-Id': NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
        'Accept': 'application/json'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json?.items) && json.items.length > 0;
  } catch (e) {
    console.warn(`[NAVER_NEWS_PRESENCE] ${query}: ${e.message}`);
    noteStatus(e);
    return false;
  }
}

const buildNaverNewsSERP = q =>
  `https://search.naver.com/search.naver?where=news&sm=tab_jum&query=${encodeURIComponent(q)}`;

const buildGoogleNewsSERP = q =>
  `https://www.google.com/search?tbm=nws&q=${encodeURIComponent(q)}`;

const buildYahooNewsSERP = q =>
  `https://news.search.yahoo.com/search?p=${encodeURIComponent(q)}`;

function makeSearchQuery(name, ticker) {
  // Include ticker if resolved; simple and language-agnostic
  return ticker ? `${name} ${ticker}` : name;
}

async function fetchSearchUrl(name, ticker, cache) {
  // 1) cache
  const cached = cacheGetSearchUrl(cache, name);
  if (cached !== undefined) return cached;

  const query = makeSearchQuery(name, ticker);

  // 2) prefer Naver if API confirms presence
  let url = null;
  try {
    const ok = await naverNewsSearchPresence(query);
    if (ok) {
      url = buildNaverNewsSERP(query);
    }
  } catch (e) {
    // already logged in presence checker
  }

  // 3) fallbacks
  if (!url) url = buildGoogleNewsSERP(query);
  if (!url) url = buildYahooNewsSERP(query); // practically never hit, but keeps the intent clear

  cachePutSearchUrl(cache, name, url);
  await saveCache(cache);
  return url;
}

// Improved Yahoo search
async function yahooSearchSymbol(name, lang, region) {
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(name)}&lang=${lang}&region=${region}`;
    const res = await fetchWithRetry(url, { headers: HEADERS_JSON });
    return await res.json();
  } catch (e) {
    console.warn(`[YAHOO_SEARCH] ${name}: ${e.message}`);
    throw e;
  }
}

// More lenient symbol selection
function pickSymbol(name, searchJson) {
  const quotes = searchJson?.quotes || [];
  if (!quotes.length) return null;

  // For Korean stocks, prioritize KRX
  if (looksKorean(name)) {
    const krx = quotes.find(q => /.K[QS]$/.test(q.symbol));
    if (krx) return krx.symbol;
  }

  // Prioritize EQUITY type, fallback to first result
  const equity = quotes.find(q => q.quoteType === 'EQUITY');
  if (equity && equity.symbol) return equity.symbol;

  // Just use first result
  return quotes[0]?.symbol || null;
}

function looksLikeTickerShape(x) {
  return /^[A-Z]{1,5}(\.[A-Z]{1,3})?$/.test(x) || /^\d{6}\.K[QS]$/.test(x);
}

async function resolveTicker(name, cache) {
  const raw = String(name);
  const nk = normalizeKey(raw);

  // 1) If it's literally a KR/US ticker we already know from index or static, pass through (canon form).
  const maybeTicker = canonSymbol(raw);
  const isTickerShape = looksLikeTickerShape(maybeTicker);
  if (isTickerShape && (INDEX_SYMBOL_SET.has(maybeTicker) || STATIC_SECTORS[maybeTicker] || TICKER_MAP[raw] || TICKER_MAP[nk])) {
    return maybeTicker;
  }

  // 2) Static name->ticker first (your static + index map merged)
  if (STATIC_MAP[nk]) return canonSymbol(STATIC_MAP[nk]);

  // 3) Cache by normalized key
  if (cache[nk]) return canonSymbol(cache[nk]);

  // 4) Yahoo fallback (name -> best ticker)
  try {
    const lang = looksKorean(raw) ? 'ko-KR' : 'en-US';
    const region = looksKorean(raw) ? 'KR' : 'US';
    const data = await yahooSearchSymbol(raw, lang, region);
    const symbol = canonSymbol(pickSymbol(raw, data));
    if (!symbol) throw new Error(`Could not resolve ticker for "${raw}"`);
    cache[nk] = symbol;
    await saveCache(cache);
    console.log(`[RESOLVE] ${raw} -> ${symbol}`);
    return symbol;
  } catch (e) {
    console.warn(`[RESOLVE] ${raw}: ${e.message}`);
    throw e;
  }
}

// Sector fetching with index and static mapping priority
async function fetchSectorByTicker(ticker, cache) {
  const sym = canonSymbol(ticker);

  // Check cache first
  const cached = cacheGetSector(cache, sym);
  if (cached !== undefined) return cached;

  // 0) index sector first
  if (INDEX_SECTOR[sym]) {
    cachePutSector(cache, sym, INDEX_SECTOR[sym]);
    await saveCache(cache);
    return INDEX_SECTOR[sym];
  }

  // 1) static mapping
  if (STATIC_SECTORS[sym]) {
    const sector = STATIC_SECTORS[sym];
    cachePutSector(cache, sym, sector);
    await saveCache(cache);
    return sector;
  }

  // 2) NAVER for KR
  if (/.K[QS]$/.test(sym)) {
    const sector = await naverSectorKR(sym).catch(() => null);
    if (sector) {
      cachePutSector(cache, sym, sector);
      await saveCache(cache);
      return sector;
    }
  }

  cachePutSector(cache, sym, null);
  await saveCache(cache);
  return null;
}

async function fetchSector(name, cache) {
  try {
    const ticker = await resolveTicker(name, cache);
    const sector = await fetchSectorByTicker(ticker, cache);
    return { sector, ticker };
  } catch (e) {
    console.warn(`[FETCH_SECTOR] ${name}: ${e.message}`);
    return { sector: null, ticker: null };
  }
}

// Utility functions
function looksLikeTicker(s) {
  return looksLikeTickerShape(canonSymbol(s || ''));
}

function inStatic(name) {
  return !!STATIC_MAP[normalizeKey(name)];
}

function findMissingStaticMappings(recos) {
  const missing = new Set();
  for (const mkt of Object.keys(recos)) {
    const grp = recos[mkt];
    if (!grp?.safe || !grp?.aggressive) continue;
    for (const bucket of ['safe', 'aggressive']) {
      for (const entry of grp[bucket]) {
        const name = typeof entry === 'string' ? entry : entry.name;
        if (!name) continue;
        // Don’t flag plain tickers; check merged static map
        if (!looksLikeTicker(name) && !inStatic(name)) missing.add(name);
      }
    }
  }
  return [...missing];
}

function sortData(data) {
  const out = {};
  for (const market of Object.keys(data).sort()) {
    const buckets = data[market] || {};
    out[market] = {};
    for (const bucket of ['safe', 'aggressive']) {
      const arr = Array.isArray(buckets[bucket]) ? buckets[bucket].slice() : [];
      arr.sort((a, b) => a.name.localeCompare(b.name));
      out[market][bucket] = arr;
    }
  }
  return out;
}

function ensureNonEmpty(out) {
  const n = totalCount(out);
  if (n === 0) {
    console.error('[ERROR] No recommendations produced (all markets empty)');
    process.exit(1);
  }
}

function validateRecommendations(out) {
  if (!out.lastUpdated || totalCount(out) === 0) {
    throw new Error('Invalid recommendations structure');
  }
}

// Main data fetching function
async function tryFetchAndEnrich() {
  const POOLS = await loadPools();
  const seed = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const data = {};
  const log = {};

  // Select stocks for each market
  for (const [market, buckets] of Object.entries(POOLS)) {
    if (!hasAnyCandidates(buckets)) continue;
    data[market] = {};
    const safeSource = buckets.safe || [];
    const safeKey = `${seed}:${market}:safe`;
    const chosenSafe = process.env.FIXED_RECS === '1' ? safeSource.slice(0, 5) : pickDeterministic(safeSource, 5, safeKey);
    data[market].safe = chosenSafe.map(n => (typeof n === 'string' ? { name: n } : n));
    const safeSet = new Set(chosenSafe.map(n => (typeof n === 'string' ? n : n.name)));

    let aggrSource = buckets.aggressive || [];
    aggrSource = aggrSource.filter(n => !safeSet.has(typeof n === 'string' ? n : n.name));
    const aggrKey = `${seed}:${market}:aggressive`;
    const chosenAggr = process.env.FIXED_RECS === '1' ? aggrSource.slice(0, 5) : pickDeterministic(aggrSource, 5, aggrKey);
    data[market].aggressive = chosenAggr.map(n => (typeof n === 'string' ? { name: n } : n));

    log[market] = {
      safe: data[market].safe?.map(x => x.name) || [],
      aggressive: data[market].aggressive?.map(x => x.name) || []
    };
  }

  console.log('[SELECTED]', JSON.stringify(log, null, 2));

  // Log missing static mappings for future improvement
  const missingStatic = findMissingStaticMappings(data);
  if (missingStatic.length) {
    console.log('[INFO] Missing from static map (will auto-resolve):', missingStatic.join(', '));
  }

  const cache = await loadCache();
  let successCount = 0;

  // Collect sector and search URL information
  for (const market of Object.keys(data)) {
    const bucket = data[market];
    for (const group of ['safe', 'aggressive']) {
      const entries = bucket[group];
      if (!Array.isArray(entries)) continue;

      const updated = [];
      for (const entry of entries) {
        const name = typeof entry === 'string' ? entry : entry.name;
        const prevSector = typeof entry === 'object' ? (entry.sector ?? null) : null;

        try {
          const { sector, ticker } = await fetchSector(name, cache);

          // Build a SERP URL with fallback: Naver → Google → Yahoo
          let searchUrl = null;
          try {
            searchUrl = await fetchSearchUrl(name, ticker, cache);
          } catch (e) {
            console.warn(`[SEARCH_URL_FAIL] ${name}: ${e.message}`);
          }

          const displayName = (ticker && SYMBOL_TO_NAME[ticker]) || name;

          updated.push({
            name: displayName,
            sector: sector || prevSector || null,
            ticker: ticker || null,
            searchUrl: searchUrl || null,
            rawScore: calcRawScore(market, group, displayName, ticker)
          });

          if (sector) successCount++;
        } catch (err) {
          console.error(`[ERROR] ${name}: ${err.message}`);
          updated.push({ name, sector: prevSector || null, ticker: null, searchUrl: null, rawScore: calcRawScore(market, group, name, null) });
          noteStatus(err);

          if (consecutive429 >= 5) {
            throw new Error('Too many consecutive 429s, aborting');
          }
        }

        // Adaptive delay based on consecutive 429s
        const delay = consecutive429 >= 3 ? nextDelay() * 2 : nextDelay();
        await sleep(delay);
      }

      scaleScores(updated, group);
      data[market][group] = updated;
    }
  }

  return { data, successCount };
}

// Main function
async function main() {
  if (FORCE) {
    console.log('[FORCE] Rebuilding recommendations');
  }

  let fresh = false;
  if (!FORCE) {
    fresh = await isFreshFile(OUT_FILE);
    if (fresh && SKIP_FRESH) {
      console.log('[SKIP] <6h, unchanged');
      return;
    }
    if (fresh) {
      console.log('[FRESH] <6h, rebuilding');
    }
  }

  try {
    const { data, successCount } = await tryFetchAndEnrich();

    const sorted = sortData(data);
    let out = { ...sorted, lastUpdated: nowKSTISO() };
    pruneEmptyMarkets(out);
    ensureNonEmpty(out);
    validateRecommendations(out);

    await writeAtomically(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`[SUCCESS] Wrote recommendations at ${out.lastUpdated} (sectors resolved: ${successCount})`);
  } catch (e) {
    console.warn('[FETCH ERROR]:', e?.message || e);

    // Fallback: rotation from existing data
    let prev = null;
    try {
      prev = JSON.parse(await fs.readFile(OUT_FILE, 'utf8'));
    } catch {}

    const pools = await loadPools();
    const rotated = sortData(rotateFromPools(pools, prev));
    for (const [market, bucket] of Object.entries(rotated)) {
      for (const tier of ['safe', 'aggressive']) {
        const arr = bucket[tier] || [];
        for (const entry of arr) {
          entry.rawScore = calcRawScore(market, tier, entry.name, null);
        }
        scaleScores(arr, tier);
      }
    }
    let out = { ...rotated, lastUpdated: nowKSTISO() };
    pruneEmptyMarkets(out);
    ensureNonEmpty(out);
    validateRecommendations(out);

    await writeAtomically(OUT_FILE, JSON.stringify(out, null, 2));
    console.log('[FALLBACK] Used rotated selection due to fetch error');
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

