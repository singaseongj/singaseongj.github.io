// fetchStockInfo.js — static map + auto-resolver + Yahoo profile fallback + throttling
// Node >= 18 (built-in fetch), ESM
import fs, { writeFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'node:path';
import { nowKSTISO } from './utils/time.js';

const OUT_FILE = path.resolve(process.cwd(), 'recommendations.json');
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const ARGS = new Set(process.argv.slice(2));
const FORCE = ARGS.has('--force');
const SKIP_FRESH = ARGS.has('--skip-fresh');
const DELAY_ARG = Number((process.argv.find(a => a.startsWith('--delay=')) || '').split('=')[1]);
const CACHE_FILE = path.resolve(process.cwd(), 'ticker-cache.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const nextDelay = () => {
  if (Number.isFinite(DELAY_ARG) && DELAY_ARG > 0) return DELAY_ARG;
  if (FORCE) return 250 + Math.floor(Math.random() * 100); // faster on --force
  return 900 + Math.floor(Math.random() * 301);
};

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
  const out = structuredClone(prevData || {});
  for (const [market, buckets] of Object.entries(POOLS)) {
    if (!hasAnyCandidates(buckets)) continue; // NEW: skip empty market
    out[market] = out[market] || {};
    for (const bucket of ['safe','aggressive']) {
      const src = buckets[bucket] || [];
      if (src.length === 0) continue;
      const picked = pickDeterministic(src, 5, `${seed}:${market}:${bucket}`);
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

const normalizeForYahoo = s => s.replace(/\./g, '-');

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
  'NAVER': '035420.KS',
  '셀트리온': '068270.KS',
  'BGF리테일': '282330.KS',

  'Samsung Electronics': '005930.KS',
  'SK Hynix': '000660.KS',
  'Samsung Biologics': '207940.KS',
  'Hyundai Motor': '005380.KS',
  'LG Energy Solution': '373220.KS',
  'Hanwha Aerospace': '012450.KS',
  'HD Hyundai Electric': '267260.KS',
  'POSCO Future M': '003670.KS',
  'Doosan Enerbility': '034020.KS',
  'HD Korea Shipbuilding': '009540.KS',
  'POSCO Holdings': '005490.KS',
  'LG Chem': '051910.KS',
  'SK Telecom': '017670.KS',
  'Kakao': '035720.KS',
  'Naver': '035420.KS',
  'Celltrion': '068270.KS',
  'BGF Retail': '282330.KS',
  'Samsung SDI': '006400.KS',
  'Hyundai Mobis': '012330.KS',
  'Kia': '000270.KS',
  'LG Electronics': '066570.KS',
  'KB Financial': '105560.KS',
  'KakaoBank': '323410.KS',

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

  'EcoPro BM': '247540.KQ',
  'Celltrion Healthcare': '091990.KQ',
  'JYP Entertainment': '035900.KQ',
  'Rainbow Robotics': '277810.KQ',
  'GI Innovation': '358570.KQ',
  'Peptron': '087010.KQ',

  // --- US (NASDAQ/NYSE) ---
  'Microsoft': 'MSFT',
  'Apple': 'AAPL',
  'NVIDIA': 'NVDA',
  'Amazon': 'AMZN',
  'Meta Platforms': 'META',
  'Alphabet': 'GOOGL',
  'Super Micro Computer': 'SMCI',
  'Advanced Micro Devices': 'AMD',
  'Arm Holdings': 'ARM',
  'Micron Technology': 'MU',
  'UiPath': 'PATH',
  'CrowdStrike': 'CRWD',
  'Berkshire Hathaway (B)': 'BRK-B',
  'Johnson & Johnson': 'JNJ',
  'Procter & Gamble': 'PG',
  'Visa': 'V',
  'Palantir': 'PLTR',
  'Coca-Cola': 'KO',
  'ServiceNow': 'NOW',
  'Eli Lilly': 'LLY',
  'Uber Technologies': 'UBER',
  'NRG Energy': 'NRG',
  'Tesla': 'TSLA',
  'TSLA': 'TSLA',
  'Netflix': 'NFLX',
  'NFLX': 'NFLX',
  'Google': 'GOOGL',
  'Alphabet Inc.': 'GOOGL',
  'Meta': 'META',
  'Facebook': 'META',
  'SMCI': 'SMCI',
  'Supermicro': 'SMCI',
  'AMD': 'AMD',
  'Intel': 'INTC',
  'INTC': 'INTC',
  'Broadcom': 'AVGO',
  'AVGO': 'AVGO',
  'Adobe': 'ADBE',
  'ADBE': 'ADBE',
  'Salesforce': 'CRM',
  'CRM': 'CRM',
  'Oracle': 'ORCL',
  'ORCL': 'ORCL',
  'Cisco': 'CSCO',
  'CSCO': 'CSCO',
  'IBM': 'IBM',
  'PayPal': 'PYPL',
  'PYPL': 'PYPL',
  'Shopify': 'SHOP',
  'SHOP': 'SHOP',
  'JPMorgan Chase': 'JPM',
  'JPM': 'JPM'
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
  if (!e) return undefined;
  if (Date.now() - e.ts > SECTOR_TTL_MS) return undefined;
  return e.value;
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
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(normalizeForYahoo(symbol))}?modules=assetProfile`;
  const res = await fetchWithRetry(url, { headers: HEADERS_JSON });
  const json = await res.json();
  const sector = json?.quoteSummary?.result?.[0]?.assetProfile?.sector ?? null;
  if (!sector) throw new Error('no sector in quoteSummary');
  return sector;
}
async function yahooProfileEmbeddedSector(symbol) {
  const url = `https://finance.yahoo.com/quote/${encodeURIComponent(normalizeForYahoo(symbol))}/profile`;
  const res = await fetchWithRetry(url, { headers: HEADERS_HTML });
  const html = await res.text();
  const marker = 'root.App.main = ';
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error('root.App.main not found');
  const start = idx + marker.length;
  const end = html.indexOf('</script>', start);
  if (end === -1) throw new Error('root.App.main script end not found');
  const jsonStr = html.slice(start, end).replace(/;\s*$/, '');
  let data;
  try { data = JSON.parse(jsonStr); }
  catch { throw new Error('root.App.main JSON parse error'); }
  function findSector(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.sector === 'string') return obj.sector;
    if (obj.assetProfile && typeof obj.assetProfile.sector === 'string') return obj.assetProfile.sector;
    for (const v of Object.values(obj)) {
      const found = findSector(v);
      if (found) return found;
    }
    return null;
  }
  const sector = findSector(data);
  if (!sector) throw new Error('no sector in embedded JSON');
  return sector;
}

// --- NEW: Naver sector for KRX tickers ---
async function naverSectorKR(symbol) {
  // Expect '005930.KS' → '005930'
  const m = String(symbol).match(/^(\d{6})\.K[QS]$/);
  if (!m) return null;
  const code = m[1];
  const url = `https://finance.naver.com/item/main.nhn?code=${code}`;
  const res = await fetchWithRetry(url, { headers: HEADERS_HTML });
  const html = await res.text();

  // Pattern 1: summary table “업종”
  let rx = />(?:업종|업종명)<\/(?:th|dt)>\s*<(?:td|dd)[^>]*>.*?>([^<]+)</i;
  let m1 = html.match(rx);
  if (m1 && m1[1]) return m1[1].trim();

  // Pattern 2: embedded JSON fallback
  rx = /"sector"\s*:\s*"([^"]+)"/i;
  let m2 = html.match(rx);
  if (m2 && m2[1]) return m2[1].trim();

  return null;
}

// --- NEW: US sector via FMP (demo key works for many large caps) ---
async function fmpSectorUS(symbol) {
  const key = process.env.FMP_KEY || 'demo';
  const url = `https://financialmodelingprep.com/api/v3/profile/${encodeURIComponent(symbol)}?apikey=${key}`;
  const res = await fetchWithRetry(url, { headers: HEADERS_JSON });
  const j = await res.json();
  const row = Array.isArray(j) ? j[0] : null;
  return row?.sector || null;
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
  if (cached !== undefined) return cached;

  const providers = [];

  // Prefer KR Naver for KRX tickers
  if (/\.K[QS]$/.test(ticker)) providers.push(() => naverSectorKR(ticker));

  // Prefer FMP for US tickers (demo/KEY)
  if (!/\.K[QS]$/.test(ticker)) providers.push(() => fmpSectorUS(ticker));

  // Keep Yahoo HTML embed (works better than JSON on CI)
  providers.push(() => yahooProfileEmbeddedSector(ticker));

  // Yahoo JSON last (often 401 in CI)
  providers.push(() => yahooQuoteSummarySector(ticker));

  if (process.env.ALPHA_VANTAGE_KEY) providers.push(() => alphaVantageSector(ticker));
  if (process.env.FINNHUB_KEY)       providers.push(() => finnhubSector(ticker));
  if (process.env.TWELVEDATA_KEY)    providers.push(() => twelveDataSector(ticker));

  for (const p of providers) {
    try {
      const sector = await p();
      if (sector) {
        cachePutSector(cache, ticker, sector);
        await saveCache(cache);
        console.log(`[SECTOR] ${ticker}: ${sector}`);
        return sector;
      }
    } catch {}
  }

  // Optional tiny static fallback for top names (won't block output)
  const STATIC_SECTOR = {
    '005930.KS': 'Information Technology',
    '000660.KS': 'Information Technology',
    '005380.KS': 'Consumer Discretionary',
    '051910.KS': 'Materials',
    '035720.KS': 'Communication Services',
    'MSFT': 'Information Technology',
    'AAPL': 'Information Technology',
    'NVDA': 'Information Technology',
    'AMZN': 'Consumer Discretionary',
    'GOOGL': 'Communication Services',
    'META': 'Communication Services',
    'V': 'Financials',
    'PG': 'Consumer Staples',
    'JNJ': 'Health Care',
    'KO': 'Consumer Staples'
  };
  if (STATIC_SECTOR[ticker]) {
    cachePutSector(cache, ticker, STATIC_SECTOR[ticker]);
    await saveCache(cache);
    console.log(`[SECTOR:STATIC] ${ticker}: ${STATIC_SECTOR[ticker]}`);
    return STATIC_SECTOR[ticker];
  }

  cachePutSector(cache, ticker, null);
  await saveCache(cache);
  return null;
}

async function fetchSector(name, cache) {
  const ticker = await resolveTicker(name, cache);
  const sector = await fetchSectorByTicker(ticker, cache);
  return { sector, ticker };
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

async function writeAtomically(dest, data) {
  const tmp = `${dest}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, dest);
}

function ensureNonEmpty(out) {
  const n = totalCount(out);
  if (n === 0) {
    console.error('[ERROR] No recommendations produced (all markets empty)');
    process.exit(1);
  }
}

// -------- Main flow --------
async function tryFetchAndEnrich() {
  const seed = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const data = {};
  const log = {};

  for (const [market, buckets] of Object.entries(POOLS)) {
    // Skip markets that have no source candidates at all (e.g., empty KOSDAQ)
    if (!hasAnyCandidates(buckets)) continue;

    data[market] = {};
    for (const bucket of ['safe', 'aggressive']) {
      const source = buckets[bucket] || [];
      if (source.length === 0) continue;

      const seedKey = `${seed}:${market}:${bucket}`;
      const chosen = process.env.FIXED_RECS === '1' ? source.slice(0, 5) : pickDeterministic(source, 5, seedKey);
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
          const { sector } = await fetchSector(name, cache);
          if (!sector) {
            console.warn(`[WARN] ${name}: sector not resolved`);
            updated.push({ name, sector: prevSector ?? null });
          } else {
            updated.push({ name, sector });
            successCount++;
          }
        } catch (err) {
          console.error(`[WARN] ${name}: ${err.message}`);
          updated.push({ name, sector: prevSector ?? null });
          noteStatus(err);
          if (consecutive429 >= 5) throw new Error('Too many 429s');
        }

        await sleep(nextDelay());
      }

      data[market][group] = updated;
    }
  }

  if (successCount === 0) {
    console.warn('[WARN] No sectors fetched');
  }

  return { data, successCount };
}

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
    if (successCount === 0) {
      console.warn('[WARN] No sectors fetched from providers; writing names only.');
    }
    const sorted = sortData(data);
    let out = { ...sorted, lastUpdated: nowKSTISO() };
    pruneEmptyMarkets(out);
    ensureNonEmpty(out);
    await writeAtomically(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`[FETCH] wrote recommendations at ${out.lastUpdated} (sectors resolved: ${successCount})`);
  } catch (e) {
    console.warn('[FETCH] error:', e?.message || e);
    let prev = null;
    try { prev = JSON.parse(await fs.readFile(OUT_FILE, 'utf8')); } catch {}
    const rotated = sortData(rotateFromPools(prev));
    let out = { ...rotated, lastUpdated: nowKSTISO() };
    pruneEmptyMarkets(out);
    ensureNonEmpty(out);
    await writeAtomically(OUT_FILE, JSON.stringify(out, null, 2));
    console.log('[FALLBACK] rotated selection due to fetch error/empty selection');
  }
}

main().catch(err => { console.error(err); process.exit(1); });

