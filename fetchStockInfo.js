// fetchStockInfo.js — static map + auto-resolver + Yahoo profile fallback + throttling
// Node >= 18 (built-in fetch), ESM
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'node:path';
import { nowKSTISO } from './utils/time.js';

const OUT_FILE = path.resolve(process.cwd(), 'recommendations.json');
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FORCE = process.argv.includes('--force');
const SLEEP_MS = Number((process.argv.find(a => a.startsWith('--delay=')) || '').split('=')[1]) || 300;
const CACHE_FILE = path.resolve(process.cwd(), 'ticker-cache.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, options={}, {retries=3, base=400, jitter=true}={}) {
  let lastErr;
  for (let attempt=0; attempt<=retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (![429,500,502,503,504].includes(res.status)) throw new Error(`HTTP ${res.status}`);
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) { lastErr = e; }
    if (attempt < retries) {
      const backoff = base * 2**attempt + (jitter ? Math.floor(Math.random()*base) : 0);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

let consecutive429 = 0;
function noteStatus(err){ if ((/HTTP 429/).test(String(err))) consecutive429++; else consecutive429=0; }

async function isFreshFile(p) {
  try { const s = await fs.stat(p); return (Date.now() - s.mtimeMs) < MAX_AGE_MS; }
  catch { return false; }
}

function seededRandom(seed){let h=2166136261>>>0;for(let i=0;i<seed.length;i++)h=Math.imul(h^seed.charCodeAt(i),16777619);return()=> (h=Math.imul(h^(h>>>15),2246822507)^Math.imul(h^(h>>>13),3266489909),(h>>>0)/2**32);}
function pickDeterministic(arr,k,seed){const rnd=seededRandom(seed),a=arr.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a.slice(0,k);}

// Define POOLS with larger candidate sets per market/bucket.
const POOLS = {
  KOSPI: { safe: ['삼성전자','SK하이닉스','현대차','POSCO홀딩스','LG화학','NAVER','카카오'], aggressive: ['HD현대일렉트릭','두산에너빌리티','한화에어로스페이스','POSCO퓨처엠','BGF리테일'] },
  KOSDAQ: { safe: [], aggressive: [] },
  NASDAQ: { safe: ['Microsoft','Apple','NVIDIA','Amazon','Meta Platforms','Alphabet'], aggressive: ['Super Micro Computer','Palantir','Arm Holdings','Micron Technology','UiPath'] },
  'S&P 500': { safe: ['Berkshire Hathaway (B)','Johnson & Johnson','Procter & Gamble','Visa','Coca-Cola'], aggressive: ['Eli Lilly','Uber Technologies','NRG Energy','CrowdStrike','ServiceNow'] }
};

function rotateFromPools(prevData) {
  const seed = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const out = structuredClone(prevData || { KOSPI:{}, KOSDAQ:{}, NASDAQ:{}, 'S&P 500':{} });
  for (const [market, buckets] of Object.entries(POOLS)) {
    for (const bucket of ['safe','aggressive']) {
      const src = buckets[bucket] || [];
      if (src.length === 0) continue;
      const picked = pickDeterministic(src, 5, `${seed}:${market}:${bucket}`);
      out[market][bucket] = picked.map(n => ({ name: n }));
    }
  }
  return out;
}

// Request headers (JSON API + HTML fallback)
const HEADERS_JSON = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.8,ko-KR;q=0.7',
  'Connection': 'keep-alive'
};
const HEADERS_HTML = {
  ...HEADERS_JSON,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': 'https://finance.yahoo.com/'
};

// KST timestamp helper is provided by utils/time.js

// -------- Static ticker map (first priority) --------
const TICKER_MAP = {
  // --- KOSPI (KS) ---
  '삼성전자': '005930.KS',
  'SK하이닉스': '000660.KS',
  '삼성바이오로직스': '207940.KS',
  '현대차': '005380.KS',
  'LG에너지솔루션': '373220.KS',
  '한화에어로스페이스': '012450.KS',
  'HD현대일렉트릭': '267260.KS',
  'POSCO퓨처엠': '003670.KS',
  '두산에너빌리티': '034020.KS',
  'HD한국조선해양': '009540.KS',
  'POSCO홀딩스': '005490.KS',
  'LG화학': '051910.KS',
  'SK텔레콤': '017670.KS',
  '카카오': '035720.KS',
  '네이버': '035420.KS',
  '셀트리온': '068270.KS',

  // --- KOSDAQ (KQ) ---
  '에코프로비엠': '247540.KQ',
  '셀트리온헬스케어': '091990.KQ',
  '천보': '278280.KQ',
  '리노공업': '058470.KQ',
  'JYP엔터테인먼트': '035900.KQ',
  '알테오젠': '196170.KQ',
  '레인보우로보틱스': '277810.KQ',
  'HLB': '028300.KQ',
  '지아이이노베이션': '358570.KQ',
  '펩트론': '087010.KQ',

  // --- US (NASDAQ/NYSE) ---
  'Microsoft': 'MSFT',
  'Apple': 'AAPL',
  'NVIDIA': 'NVDA',
  'Amazon': 'AMZN',
  'Alphabet': 'GOOGL',
  'Super Micro Computer': 'SMCI',
  'Advanced Micro Devices': 'AMD',
  'Arm Holdings': 'ARM',
  'Micron Technology': 'MU',
  'CrowdStrike': 'CRWD',
  'Berkshire Hathaway (B)': 'BRK-B',
  'Johnson & Johnson': 'JNJ',
  'Procter & Gamble': 'PG',
  'Visa': 'V',
  'Palantir': 'PLTR',
  'Eli Lilly': 'LLY',
  'Uber Technologies': 'UBER',
  'NRG Energy': 'NRG'
};

// -------- Cache helpers --------
async function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(await fs.readFile(CACHE_FILE, 'utf-8')); }
  catch { return {}; }
}
async function saveCache(cache) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

const SECTOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function cacheGetSector(cache, symbol) {
  const e = cache._sectors?.[symbol];
  if (!e) return null;
  if (Date.now() - e.ts > SECTOR_TTL_MS) return null;
  return e.value || null;
}
function cachePutSector(cache, symbol, sector) {
  cache._sectors = cache._sectors || {};
  cache._sectors[symbol] = { value: sector, ts: Date.now() };
}
const looksKorean = s => /[가-힣]/.test(s);

async function yahooSearchSymbol(name, lang, region) {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(name)}&lang=${lang}&region=${region}`;
  const res = await fetchWithRetry(url, { headers: HEADERS_JSON });
  return res.json();
}
async function yahooQuoteSummarySector(symbol) {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=assetProfile`;
  const res = await fetchWithRetry(url, { headers: HEADERS_JSON });
  const json = await res.json();
  const sector = json?.quoteSummary?.result?.[0]?.assetProfile?.sector ?? null;
  if (!sector) throw new Error('no sector in quoteSummary');
  return sector;
}
async function yahooProfileSectorScrape(symbol) {
  const url = `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/profile`;
  const res = await fetchWithRetry(url, { headers: HEADERS_HTML });
  const html = await res.text();
  let m = html.match(/"sector":"([^"]+)"/) || html.match(/Sector\(s\)<\/span>\s*<span[^>]*>([^<]+)/i);
  return (m && (m[1] || m[2])) ? (m[1] || m[2]).trim() : null;
}

async function alphaVantageSector(symbol) {
  const key = process.env.ALPHA_VANTAGE_KEY;
  if (!key) return null;
  const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${key}`;
  const res = await fetchWithRetry(url, { headers: HEADERS_JSON });
  const j = await res.json(); return j?.Sector || null;
}
async function finnhubSector(symbol) {
  const key = process.env.FINNHUB_KEY;
  if (!key) return null;
  const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${key}`;
  const res = await fetchWithRetry(url, { headers: HEADERS_JSON });
  const j = await res.json(); return j?.finnhubIndustry || j?.sector || null;
}
async function twelveDataSector(symbol) {
  const key = process.env.TWELVEDATA_KEY;
  if (!key) return null;
  const url = `https://api.twelvedata.com/profile?symbol=${encodeURIComponent(symbol)}&apikey=${key}`;
  const res = await fetchWithRetry(url, { headers: HEADERS_JSON });
  const j = await res.json(); return j?.sector || null;
}

// -------- Ticker resolution (map -> cache -> Yahoo search) --------
function pickSymbol(name, searchJson) {
  const quotes = searchJson?.quotes || [];
  if (!quotes.length) return null;

  if (looksKorean(name)) {
    const krx = quotes.find(q => /\.K[QS]$/.test(q.symbol));
    if (krx) return krx.symbol;
  }
  const eq = quotes.find(q => q.quoteType === 'EQUITY' || q.isYahooFinance);
  return (eq && eq.symbol) || quotes[0].symbol || null;
}

async function resolveTicker(name, cache) {
  if (TICKER_MAP[name]) return TICKER_MAP[name];
  if (cache[name]) return cache[name];

  const lang = looksKorean(name) ? 'ko-KR' : 'en-US';
  const region = looksKorean(name) ? 'KR' : 'US';
  const data = await yahooSearchSymbol(name, lang, region);

  const symbol = pickSymbol(name, data);
  if (!symbol) throw new Error(`Could not resolve ticker for "${name}"`);

  cache[name] = symbol;
  await saveCache(cache);
  console.log(`[auto-resolve] ${name} -> ${symbol}`);
  return symbol;
}

// -------- Sector lookup with multi-provider chain --------
async function fetchSectorByTicker(ticker, cache) {
  const cached = cacheGetSector(cache, ticker);
  if (cached) return cached;
  const providers = [
    () => yahooQuoteSummarySector(ticker),
    () => alphaVantageSector(ticker),
    () => finnhubSector(ticker),
    () => twelveDataSector(ticker),
    () => yahooProfileSectorScrape(ticker),
  ];
  for (const p of providers) {
    try {
      const sector = await p();
      if (sector) {
        cachePutSector(cache, ticker, sector);
        await saveCache(cache);
        return sector;
      }
    } catch (e) {
      // continue to next provider
    }
  }
  return null;
}

async function fetchSector(name, cache) {
  const ticker = await resolveTicker(name, cache);
  const sector = await fetchSectorByTicker(ticker, cache);
  if (!sector) throw new Error(`Sector not found for ${name} (${ticker})`);
  return sector;
}

// -------- Utility --------
function findMissingStaticMappings(recos) {
  const missing = new Set();
  for (const mkt of Object.keys(recos)) {
    const grp = recos[mkt];
    if (!grp?.safe || !grp?.aggressive) continue;
    for (const bucket of ['safe', 'aggressive']) {
      for (const entry of grp[bucket]) {
        const name = typeof entry === 'string' ? entry : entry.name;
        if (name && !TICKER_MAP[name]) missing.add(name);
      }
    }
  }
  return [...missing];
}

// -------- Main flow --------
async function tryFetchAndEnrich() {
  const seed = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const data = {};
  const log = {};
  for (const [market, buckets] of Object.entries(POOLS)) {
    data[market] = {};
    for (const bucket of ['safe', 'aggressive']) {
      const source = buckets[bucket] || [];
      if (source.length === 0) continue;
      const chosen = process.env.FIXED_RECS === '1'
        ? source.slice(0, 5)
        : pickDeterministic(source, 5, `${seed}:${market}:${bucket}`);
      data[market][bucket] = chosen.map(n => (typeof n === 'string' ? { name: n } : n));
    }
    log[market] = {
      safe: data[market].safe?.map(x => x.name) || [],
      aggressive: data[market].aggressive?.map(x => x.name) || []
    };
  }
  console.log('[SELECTED]', JSON.stringify(log, null, 2));

  const missingStatic = findMissingStaticMappings(data);
  if (missingStatic.length) {
    console.warn('[INFO] Not in static map (will auto-resolve):', missingStatic.join(', '));
  }

  const cache = await loadCache();

  let successCount = 0;
  for (const market of Object.keys(data)) {
    const bucket = data[market];
    for (const group of ['safe', 'aggressive']) {
      const entries = bucket[group];
      if (!Array.isArray(entries)) continue;

      const updated = [];
      for (const entry of entries) {
        const name = typeof entry === 'string' ? entry : entry.name;
        const prevSector = typeof entry === 'object' ? entry.sector ?? null : null;

        try {
          const sector = await fetchSector(name, cache);
          updated.push({ name, sector: sector ?? prevSector ?? null });
          successCount++;
        } catch (err) {
          console.error(`[WARN] ${name}: ${err.message}`);
          updated.push({ name, sector: prevSector });
          noteStatus(err);
          if (consecutive429 >= 5) throw new Error('Too many 429s');
        }

        await sleep(SLEEP_MS);
      }

      data[market][group] = updated;
    }
  }

  if (successCount === 0) {
    throw new Error('No sectors fetched');
  }

  return data;
}

async function main() {
  const fresh = await isFreshFile(OUT_FILE);
  if (fresh && !FORCE) {
    // Fresh: no network, no rotation — just touch timestamp
    const prev = JSON.parse(await fs.readFile(OUT_FILE, 'utf8'));
    prev.lastUpdated = nowKSTISO();
    await fs.writeFile(OUT_FILE, JSON.stringify(prev, null, 2));
    console.log(`[FRESH] <6h, touched timestamp at ${prev.lastUpdated}`);
    return;
  }

  // Stale or forced: try heavy fetch/enrich
  let base = null;
  try {
    base = await tryFetchAndEnrich(); // returns full recommendations object WITHOUT lastUpdated
    const out = { ...base, lastUpdated: nowKSTISO() };
    await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`[FETCH] success at ${out.lastUpdated}`);
  } catch (e) {
    console.warn('[FETCH] failed, using rotation fallback:', e?.message || e);
    // Load previous if exists to preserve structure; else start empty
    let prev = null;
    try { prev = JSON.parse(await fs.readFile(OUT_FILE, 'utf8')); } catch {}
    const rotated = rotateFromPools(prev);
    const out = { ...rotated, lastUpdated: nowKSTISO() };
    await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`[FALLBACK] rotated selection written at ${out.lastUpdated}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });

