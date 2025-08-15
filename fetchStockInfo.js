// fetchStockInfo.js — unified trending + classification + enrichment + fallback
// Includes: richer error logs, batched-parallel metrics, whole-run timeout
// Flags: --force, --skip-fresh, --delay=ms
// Output: recommendations.json (atomic write). Caches: ticker-cache.json, metrics-cache.json

import fs, { writeFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { nowKSTISO } from './utils/time.js';

// ------------ Constants & CLI ------------
const OUT_FILE = path.resolve(process.cwd(), 'recommendations.json');
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

const ARGS = new Set(process.argv.slice(2));
const FORCE = ARGS.has('--force');
const SKIP_FRESH = ARGS.has('--skip-fresh');
const DELAY_ARG = Number((process.argv.find(a => a.startsWith('--delay=')) || '').split('=')[1]);

const CACHE_FILE = path.resolve(process.cwd(), 'ticker-cache.json');         // symbol/name/sector cache
const METRICS_CACHE_FILE = path.resolve(process.cwd(), 'metrics-cache.json'); // vol/mcap/beta cache

const RUN_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes overall

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------ Adaptive throttle ------------
let consecutive429 = 0;
function noteStatus(err) {
  if ((/HTTP 429|status 429|Too Many Requests/i).test(String(err))) {
    consecutive429++;
    if (consecutive429 >= 3) console.log(`[THROTTLE] ${consecutive429}x 429 detected, slowing down`);
  } else {
    consecutive429 = 0;
  }
}
function nextDelay() {
  if (Number.isFinite(DELAY_ARG) && DELAY_ARG > 0) return DELAY_ARG;
  const base = FORCE ? 500 : 1200;
  const jitter = Math.floor(Math.random() * (FORCE ? 200 : 800));
  const penalty = Math.min(consecutive429 * 500, 5000);
  return base + jitter + penalty;
}

// Per-request timeout (prevents hangs consuming whole budget)
async function fetchWithTimeout(url, options = {}, ms = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchWithRetry(url, options = {}, { retries = 3, base = 900, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    noteStatus(lastErr);
    if (attempt < retries) {
      const backoff = base * Math.pow(2, attempt) + Math.floor(Math.random() * base);
      console.log(`[RETRY] ${attempt + 1}/${retries} after ${backoff}ms: ${url}`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// ------------ Helpers ------------
async function isFreshFile(p) {
  try { const s = await fs.stat(p); return (Date.now() - s.mtimeMs) < MAX_AGE_MS; }
  catch { return false; }
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
  return a.slice(0, Math.min(k, a.length));
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
  let n = 0;
  for (const m of Object.keys(out)) {
    if (m === 'lastUpdated') continue;
    n += (out[m]?.safe?.length || 0) + (out[m]?.aggressive?.length || 0);
    if (n > 0) break;
  }
  if (n === 0) {
    console.error('[ERROR] No recommendations produced (all markets empty)');
    process.exit(1);
  }
}
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function withTimeout(promise, ms, onTimeout) {
  let timeoutId;
  const timeoutP = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      try { onTimeout?.(); } catch {}
      reject(new Error('RUN_TIMEOUT'));
    }, ms);
  });
  return Promise.race([promise, timeoutP]).finally(() => clearTimeout(timeoutId));
}

// ------------ Headers ------------
const HEADERS_HTML = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'Connection': 'keep-alive'
};
const HEADERS_JSON = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'Connection': 'keep-alive'
};

// ------------ Static maps (fast path) ------------
const TICKER_MAP = {
  // KOSPI
  '삼성전자': '005930.KS', 'SK하이닉스': '000660.KS', '삼성바이오로직스': '207940.KS',
  '현대차': '005380.KS', 'LG에너지솔루션': '373220.KS', '한화에어로스페이스': '012450.KS',
  'HD현대일렉트릭': '267260.KS', 'POSCO퓨처엠': '003670.KS', '두산에너빌리티': '034020.KS',
  'HD한국조선해양': '009540.KS', 'POSCO홀딩스': '005490.KS', 'LG화학': '051910.KS',
  'SK텔레콤': '017670.KS', '카카오': '035720.KS', '네이버': '035420.KS', 'NAVER': '035420.KS',
  '셀트리온': '068270.KS', 'BGF리테일': '282330.KS', '기아': '000270.KS', 'LG전자': '066570.KS',
  '삼성SDI': '006400.KS', '에코프로': '086520.KS',
  // KOSDAQ
  '에코프로비엠': '247540.KQ', '셀트리온헬스케어': '091990.KQ', '천보': '278280.KQ',
  '리노공업': '058470.KQ', 'JYP엔터테인먼트': '035900.KQ', '알테오젠': '196170.KQ',
  '레인보우로보틱스': '277810.KQ', 'HLB': '028300.KQ', '지아이이노베이션': '358570.KQ',
  '펩트론': '087010.KQ', '펄어비스': '263750.KQ', '아이오케이': '078860.KQ', 'CJ ENM': '035760.KQ',
  // US
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
const STATIC_SECTORS = {
  // KOSPI
  '005930.KS': 'Technology', '000660.KS': 'Technology', '005380.KS': 'Consumer Discretionary',
  '051910.KS': 'Materials', '035720.KS': 'Communication Services', '035420.KS': 'Communication Services',
  '005490.KS': 'Materials', '267260.KS': 'Industrials', '012450.KS': 'Industrials',
  '034020.KS': 'Industrials', '282330.KS': 'Consumer Staples', '000270.KS': 'Consumer Discretionary',
  '066570.KS': 'Technology', '006400.KS': 'Technology', '086520.KS': 'Materials',
  // KOSDAQ
  '247540.KQ': 'Materials', '091990.KQ': 'Healthcare', '278280.KQ': 'Industrials',
  '058470.KQ': 'Industrials', '035900.KQ': 'Communication Services', '196170.KQ': 'Healthcare',
  '277810.KQ': 'Industrials', '028300.KQ': 'Healthcare', '358570.KQ': 'Technology',
  '087010.KQ': 'Healthcare', '263750.KQ': 'Communication Services', '078860.KQ': 'Technology',
  '035760.KQ': 'Communication Services',
  // US (subset)
  'MSFT': 'Technology', 'AAPL': 'Technology', 'NVDA': 'Technology', 'AMZN': 'Consumer Discretionary',
  'META': 'Communication Services', 'GOOGL': 'Communication Services', 'TSLA': 'Consumer Discretionary',
  'NFLX': 'Communication Services', 'SMCI': 'Technology', 'PLTR': 'Technology', 'ARM': 'Technology',
  'MU': 'Technology', 'PATH': 'Technology', 'CRWD': 'Technology', 'BRK-B': 'Financial Services',
  'JNJ': 'Healthcare', 'PG': 'Consumer Staples', 'V': 'Financial Services', 'KO': 'Consumer Staples',
  'NOW': 'Technology', 'LLY': 'Healthcare', 'UBER': 'Technology', 'NRG': 'Utilities',
  'JPM': 'Financial Services', 'UNH': 'Healthcare', 'MRNA': 'Healthcare', 'ZM': 'Technology',
  'MDB': 'Technology', 'SNOW': 'Technology'
};

// ------------ Caches ------------
async function loadJSON(p, fallback = {}) {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return fallback; }
}
async function saveJSON(p, data) {
  try { await fs.writeFile(p, JSON.stringify(data, null, 2)); } catch {}
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

// ------------ Name/Symbol helpers ------------
const looksKorean = s => /[가-힣]/.test(s);
const looksSymbol = s => /^[A-Z.\-]+$/.test(s) || /^\d{6}\.K[QS]$/.test(s);

// Naver KR sector scrape (.KS/.KQ) — with richer error context
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
    for (const rx of patterns) {
      const match = html.match(rx);
      if (match?.[1]) {
        const sector = match[1].trim();
        if (sector && sector !== '-' && sector !== 'N/A') return sector;
      }
    }
    return null;
  } catch (e) {
    console.warn(`[NAVER] ${symbol} (${url}): ${e?.message || e}`);
    return null;
  }
}

// Yahoo symbol search
async function yahooSearchSymbol(name, lang, region) {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(name)}&lang=${lang}&region=${region}`;
  const res = await fetchWithRetry(url, { headers: HEADERS_JSON });
  return await res.json();
}
function pickSymbol(name, searchJson) {
  const quotes = searchJson?.quotes || [];
  if (!quotes.length) return null;
  if (looksKorean(name)) {
    const krx = quotes.find(q => /.K[QS]$/.test(q.symbol));
    if (krx) return krx.symbol;
  }
  const equity = quotes.find(q => q.quoteType === 'EQUITY');
  return equity?.symbol || quotes[0]?.symbol || null;
}

// Resolve ticker from name OR pass-through if already a symbol
async function resolveTicker(name, cache) {
  if (looksSymbol(name)) return name; // already symbol
  if (TICKER_MAP[name]) return TICKER_MAP[name];
  if (cache[name]) return cache[name];
  try {
    const lang = looksKorean(name) ? 'ko-KR' : 'en-US';
    const region = looksKorean(name) ? 'KR' : 'US';
    const data = await yahooSearchSymbol(name, lang, region);
    const symbol = pickSymbol(name, data);
    if (!symbol) throw new Error(`Could not resolve ticker for "${name}"`);
    cache[name] = symbol;
    await saveJSON(CACHE_FILE, cache);
    console.log(`[RESOLVE] ${name} -> ${symbol}`);
    return symbol;
  } catch (e) {
    console.warn(`[RESOLVE] ${name}: ${e.message}`);
    throw e;
  }
}

// Sector by ticker (cache → static → Naver for KR → null)
async function fetchSectorByTicker(ticker, cache) {
  const cached = cacheGetSector(cache, ticker);
  if (cached !== undefined) return cached;
  if (STATIC_SECTORS[ticker]) {
    const sector = STATIC_SECTORS[ticker];
    cachePutSector(cache, ticker, sector);
    await saveJSON(CACHE_FILE, cache);
    console.log(`[STATIC] ${ticker}: ${sector}`);
    return sector;
  }
  if (/.K[QS]$/.test(ticker)) {
    try {
      const sector = await naverSectorKR(ticker);
      if (sector) {
        cachePutSector(cache, ticker, sector);
        await saveJSON(CACHE_FILE, cache);
        return sector;
      }
    } catch (e) {
      console.warn(`[NAVER_FAIL] ${ticker}: ${e.message}`);
    }
  }
  cachePutSector(cache, ticker, null);
  await saveJSON(CACHE_FILE, cache);
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

// ------------ Trending sources ------------
async function yahooTrending(region = 'US', count = 60) {
  const url = `https://query2.finance.yahoo.com/v1/finance/trending/${region}?count=${count}`;
  const res = await fetchWithRetry(url, { headers: HEADERS_JSON });
  const json = await res.json();
  const quotes = json?.finance?.result?.[0]?.quotes || [];
  return quotes.map(q => q.symbol).filter(Boolean);
}
async function yahooPredefined(scrId = 'day_gainers', count = 60) {
  const url = `https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?count=${count}&scrIds=${encodeURIComponent(scrId)}`;
  const res = await fetchWithRetry(url, { headers: HEADERS_JSON });
  const json = await res.json();
  const quotes = json?.finance?.result?.[0]?.quotes || [];
  return quotes.map(q => q.symbol).filter(Boolean);
}
async function yahooQuoteSummary(symbol) {
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=price,summaryDetail,defaultKeyStatistics`;
  const res = await fetchWithRetry(url, { headers: HEADERS_JSON });
  const j = await res.json();
  const r = j?.quoteSummary?.result?.[0];
  const price = r?.price;
  const stats = r?.defaultKeyStatistics;
  const mcap = price?.marketCap?.raw ?? stats?.enterpriseValue?.raw ?? null;
  const beta = stats?.beta?.raw ?? null;
  const displayName = price?.shortName || price?.longName || symbol;
  return { marketCap: mcap, beta, displayName };
}
async function yahooChartCloses(symbol, range = '3mo', interval = '1d') {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetchWithRetry(url, { headers: HEADERS_JSON });
  const j = await res.json();
  const arr = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
  return arr.filter(x => typeof x === 'number' && Number.isFinite(x));
}

// Naver 인기검색종목 (top searched)
async function naverPopularKR(limitPages = 3) {
  const out = [];
  for (let page = 1; page <= limitPages; page++) {
    const url = `https://finance.naver.com/sise/lastsearch2.naver?page=${page}`;
    const res = await fetchWithRetry(url, { headers: HEADERS_HTML });
    const html = await res.text();
    const $ = cheerio.load(html);
    $('table.type_5 tbody tr').each((_, tr) => {
      const a = $(tr).find('td:eq(1) a');
      const name = a.text().trim();
      const code = (a.attr('href') || '').match(/code=(\d+)/)?.[1];
      if (name && code) out.push(code);
    });
    await sleep(200);
  }
  return [...new Set(out)];
}
const krVariants = code => [`${code}.KS`, `${code}.KQ`];

// ------------ Metrics & classification ------------
function annualizedVol(closes) {
  if (!closes || closes.length < 40) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    if (Number.isFinite(r)) rets.push(r);
  }
  if (rets.length < 30) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const var_ = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(var_) * Math.sqrt(252);
}
function classify({ vol, marketCap }) {
  const VOL_AGG = 0.35;   // >=35% annualized vol => aggressive
  const USD_SMALL = 2e9;  // < $2B market cap => aggressive
  const USD_MEGA  = 2e11; // > $200B and not volatile => safe
  if (vol != null && vol >= VOL_AGG) return 'aggressive';
  if (marketCap != null && marketCap < USD_SMALL) return 'aggressive';
  if (marketCap != null && marketCap >= USD_MEGA && (vol == null || vol < VOL_AGG)) return 'safe';
  return 'safe';
}

// Ensure metrics with 3-day TTL; also cache display name
async function ensureMetrics(symbol, tcache, mcache) {
  const TTL = 1000 * 60 * 60 * 24 * 3;
  const me = mcache[symbol];
  if (me && (Date.now() - (me.ts || 0)) < TTL) return me;

  let closes = [];
  try { closes = await yahooChartCloses(symbol); } catch (e) { noteStatus(e); }
  await sleep(nextDelay());

  let marketCap = null, beta = null, displayName = symbol;
  try {
    const snap = await yahooQuoteSummary(symbol);
    marketCap = snap.marketCap ?? null;
    beta = snap.beta ?? null;
    displayName = snap.displayName || symbol;
  } catch (e) { noteStatus(e); }

  const vol = annualizedVol(closes);
  const entry = { vol, marketCap, beta, name: displayName, ts: Date.now() };
  mcache[symbol] = entry;

  // store name map for later (optional)
  tcache._names = tcache._names || {};
  if (displayName) tcache._names[symbol] = displayName;

  return entry;
}

// Build trend-driven pools (returns arrays of { name } using display names)
async function buildTrendingPools() {
  const tickerCache = await loadJSON(CACHE_FILE, {});
  const metricsCache = await loadJSON(METRICS_CACHE_FILE, {});

  // 1) Source signals (Yahoo + Naver)
  const [ytUS, ygUS, ylUS] = await Promise.all([
    yahooTrending('US', 60).catch(() => []),
    yahooPredefined('day_gainers', 60).catch(() => []),
    yahooPredefined('day_losers', 60).catch(() => []),
  ]);
  const ytKR = await yahooTrending('KR', 60).catch(() => []);
  const nvCodes = await naverPopularKR(3).catch(() => []);

  // Guess KR symbols for Naver codes
  const krSet = new Set(ytKR);
  for (const code of nvCodes) {
    let chosen = null;
    for (const s of krVariants(code)) {
      try {
        const closes = await yahooChartCloses(s);
        if (closes?.length) { chosen = s; break; }
      } catch {}
    }
    if (!chosen) chosen = `${code}.KS`;
    krSet.add(chosen);
    await sleep(120);
  }

  const US = [...new Set([...ytUS, ...ygUS, ...ylUS].filter(s => /^[A-Z.\-]+$/.test(s)))];
  const KR = [...new Set([...krSet].filter(s => /\.(KS|KQ)$/.test(s)))];

  // 2) Fetch metrics & classify — batched parallel (tunable)
  const BATCH = 4; // 3–5 recommended
  const safeUS = [], aggUS = [];
  const safeKR = [], aggKR = [];

  const tickerCacheRef = await loadJSON(CACHE_FILE, {}); // ensure latest ref
  const metricsCacheRef = await loadJSON(METRICS_CACHE_FILE, {});

  async function processSymbols(symbols, safeArr, aggArr) {
    for (const chunk of chunkArray(symbols, BATCH)) {
      const results = await Promise.allSettled(
        chunk.map(s => ensureMetrics(s, tickerCacheRef, metricsCacheRef))
      );
      results.forEach((r, i) => {
        const sym = chunk[i];
        if (r.status === 'fulfilled') {
          const m = r.value;
          const bucket = classify(m);
          const disp = m.name || sym;
          if (bucket === 'aggressive') aggArr.push({ name: disp });
          else safeArr.push({ name: disp });
        } else {
          noteStatus(r.reason);
        }
      });
      await sleep(nextDelay());
      if (consecutive429 >= 6) break;
    }
  }

  await Promise.all([
    processSymbols(US, safeUS, aggUS),
    processSymbols(KR, safeKR, aggKR)
  ]);

  await Promise.all([
    saveJSON(CACHE_FILE, tickerCacheRef),
    saveJSON(METRICS_CACHE_FILE, metricsCacheRef)
  ]);

  // 3) Choose 5 per bucket by KST-seeded shuffle
  const seed = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const pick5 = (arr, key) => pickDeterministic(arr, 5, `${seed}:${key}`).map(x => ({ name: x.name }));

  return {
    KOSPI: {
      safe:       pick5(safeKR, 'KR:KS:safe'),
      aggressive: pick5(aggKR,  'KR:KS:agg')
    },
    KOSDAQ: {
      safe:       pick5(safeKR, 'KR:KQ:safe'),
      aggressive: pick5(aggKR,  'KR:KQ:agg')
    },
    NASDAQ: {
      safe:       pick5(safeUS, 'US:safe'),
      aggressive: pick5(aggUS,  'US:agg')
    }
  };
}

// ------------ Enrichment pipeline (uses trend pools) ------------
async function tryFetchAndEnrich() {
  // 1) Build pools from trends
  const pools = await buildTrendingPools();

  // 2) Enrich with sectors (and sort)
  const cache = await loadJSON(CACHE_FILE, {});
  let successCount = 0;
  const data = {};

  for (const [market, buckets] of Object.entries(pools)) {
    data[market] = { safe: [], aggressive: [] };
    for (const group of ['safe', 'aggressive']) {
      const entries = buckets[group] || [];
      const updated = [];
      for (const entry of entries) {
        const name = typeof entry === 'string' ? entry : entry.name;
        const prevSector = typeof entry === 'object' ? (entry.sector ?? null) : null;
        try {
          const { sector } = await fetchSector(name, cache);
          if (sector) {
            updated.push({ name, sector });
            successCount++;
          } else {
            console.warn(`[WARN] ${name}: sector not resolved`);
            updated.push({ name, sector: prevSector });
          }
        } catch (err) {
          console.error(`[ERROR] ${name}: ${err.message}`);
          updated.push({ name, sector: prevSector });
          noteStatus(err);
          if (consecutive429 >= 5) throw new Error('Too many consecutive 429s, aborting');
        }
        const delay = consecutive429 >= 3 ? nextDelay() * 2 : nextDelay();
        await sleep(delay);
      }
      data[market][group] = updated;
    }
  }

  return { data, successCount };
}

// ------------ Fallback rotation ------------
const POOLS_STATIC = {
  KOSPI: {
    safe: ['삼성전자','SK하이닉스','현대차','POSCO홀딩스','LG화학','NAVER','카카오','기아','LG전자','삼성SDI'],
    aggressive: ['HD현대일렉트릭','두산에너빌리티','한화에어로스페이스','POSCO퓨처엠','BGF리테일','에코프로','삼성바이오로직스','셀트리온']
  },
  KOSDAQ: {
    safe: ['셀트리온헬스케어','JYP엔터테인먼트','펄어비스','아이오케이','CJ ENM'],
    aggressive: ['에코프로비엠','천보','리노공업','알테오젠','레인보우로보틱스','HLB','지아이이노베이션','펩트론']
  },
  NASDAQ: {
    safe: ['Microsoft','Apple','NVIDIA','Amazon','Meta Platforms','Alphabet','Tesla','Netflix'],
    aggressive: ['Super Micro Computer','Palantir','Arm Holdings','Micron Technology','UiPath','CrowdStrike','MongoDB','Snowflake']
  },
  'S&P 500': {
    safe: ['Berkshire Hathaway (B)','Johnson & Johnson','Procter & Gamble','Visa','Coca-Cola','JPMorgan Chase','UnitedHealth'],
    aggressive: ['Eli Lilly','Uber Technologies','NRG Energy','CrowdStrike','ServiceNow','Moderna','Zoom']
  }
};
function rotateFromPools(prevData) {
  const seed = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const out = structuredClone(prevData || {});
  const pools = POOLS_STATIC;
  for (const [market, buckets] of Object.entries(pools)) {
    out[market] = out[market] || {};
    for (const bucket of ['safe', 'aggressive']) {
      const src = buckets[bucket] || [];
      if (src.length === 0) continue;
      const picked = pickDeterministic(src, Math.min(5, src.length), `${seed}:${market}:${bucket}`);
      out[market][bucket] = picked.map(n => ({ name: n }));
    }
  }
  return out;
}
function pruneEmptyMarkets(out) {
  for (const m of Object.keys(out)) {
    if (m === 'lastUpdated') continue;
    const s = out[m]?.safe?.length || 0;
    const a = out[m]?.aggressive?.length || 0;
    if ((s + a) === 0) delete out[m];
  }
}
async function writeFallbackRotation() {
  let prev = null;
  try { prev = JSON.parse(await fs.readFile(OUT_FILE, 'utf8')); } catch {}
  const rotated = sortData(rotateFromPools(prev));
  let out = { ...rotated, lastUpdated: nowKSTISO() };
  pruneEmptyMarkets(out);
  ensureNonEmpty(out);
  await writeAtomically(OUT_FILE, JSON.stringify(out, null, 2));
  console.log('[FALLBACK] Used rotated selection due to timeout/error');
}

// ------------ Main ------------
async function main() {
  if (FORCE) console.log('[FORCE] Rebuilding recommendations');

  let fresh = false;
  if (!FORCE) {
    fresh = await isFreshFile(OUT_FILE);
    if (fresh && SKIP_FRESH) {
      console.log('[SKIP] <6h, unchanged');
      return;
    }
    if (fresh) console.log('[FRESH] <6h, rebuilding');
  }

  await withTimeout(
    (async () => {
      try {
        const { data, successCount } = await tryFetchAndEnrich();
        const sorted = sortData(data);
        let out = { ...sorted, lastUpdated: nowKSTISO() };
        pruneEmptyMarkets(out);
        ensureNonEmpty(out);
        await writeAtomically(OUT_FILE, JSON.stringify(out, null, 2));
        console.log(`[SUCCESS] Wrote recommendations at ${out.lastUpdated} (sectors resolved: ${successCount})`);
      } catch (e) {
        console.warn('[FETCH ERROR]:', e?.message || e);
        await writeFallbackRotation();
      }
    })(),
    RUN_TIMEOUT_MS,
    () => console.log('[TIMEOUT] Falling back to rotation')
  ).catch(async (e) => {
    if (String(e?.message) === 'RUN_TIMEOUT') {
      await writeFallbackRotation();
    } else {
      console.warn('[RUN ERROR]:', e?.message || e);
      await writeFallbackRotation();
    }
  });
}

main().catch(async err => {
  console.error('[FATAL]', err);
  await writeFallbackRotation();
  process.exit(1);
});
