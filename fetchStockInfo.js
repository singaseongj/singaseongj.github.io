// fetchStockInfo.js — static map + auto-resolver + Yahoo profile fallback + throttling
// Node >= 18 (built-in fetch), ESM
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const SIX_HOURS = 6 * 60 * 60 * 1000;
const FORCE = process.argv.includes('--force');
const SLEEP_MS = Number((process.argv.find(a => a.startsWith('--delay=')) || '').split('=')[1]) || 300;

const CACHE_FILE = path.join(__dirname, 'ticker-cache.json');
const RECS_FILE  = path.join(__dirname, 'recommendations.json');

// --- KST timestamp helper ---
function toKSTISOString(d = new Date()) {
  const utc = d.getTime();
  const kst = new Date(utc + 9 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const yyyy = kst.getUTCFullYear();
  const mm   = pad(kst.getUTCMonth() + 1);
  const dd   = pad(kst.getUTCDate());
  const hh   = pad(kst.getUTCHours());
  const mi   = pad(kst.getUTCMinutes());
  const ss   = pad(kst.getUTCSeconds());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+09:00`;
}

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
const looksKorean = s => /[가-힣]/.test(s);

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
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(name)}&lang=${lang}&region=${region}`;

  const res = await fetch(url, { headers: HEADERS_JSON });
  if (!res.ok) throw new Error(`Search HTTP ${res.status}`);
  const data = await res.json();

  const symbol = pickSymbol(name, data);
  if (!symbol) throw new Error(`Could not resolve ticker for "${name}"`);

  cache[name] = symbol;
  await saveCache(cache);
  console.log(`[auto-resolve] ${name} -> ${symbol}`);
  return symbol;
}

// -------- Sector lookup (JSON first, then HTML profile fallback) --------
async function fetchSectorFromProfile(ticker) {
  const url = `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/profile`;
  const res = await fetch(url, { headers: HEADERS_HTML });
  if (!res.ok) throw new Error(`profile HTTP ${res.status}`);
  const html = await res.text();

  // Embedded JSON often contains "sector":"..."
  let m = html.match(/"sector":"([^"]+)"/);
  if (m && m[1]) return m[1];

  // Visible text fallback: Sector(s) ... <span>Technology</span>
  m = html.match(/Sector\(s\)<\/span>\s*<span[^>]*>([^<]+)/i);
  if (m && m[1]) return m[1].trim();

  return null;
}

async function fetchSectorByTicker(ticker) {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=assetProfile`;
  const res = await fetch(url, { headers: HEADERS_JSON });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return await fetchSectorFromProfile(ticker);
    }
    throw new Error(`quoteSummary HTTP ${res.status}`);
  }

  const json = await res.json();
  const qsum = json?.quoteSummary;
  if (qsum?.error) {
    if (qsum.error.code === 'Unauthorized' || qsum.error.code === 'Forbidden') {
      return await fetchSectorFromProfile(ticker);
    }
    throw new Error(`quoteSummary error: ${qsum.error.code || 'unknown'}`);
  }

  const sector = qsum?.result?.[0]?.assetProfile?.sector ?? null;
  return sector ?? await fetchSectorFromProfile(ticker);
}

async function fetchSector(name, cache) {
  const ticker = await resolveTicker(name, cache);
  const sector = await fetchSectorByTicker(ticker);
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

// -------- Main --------
async function updateRecommendations() {
  let data;
  try {
    data = JSON.parse(await fs.readFile(RECS_FILE, 'utf-8'));
  } catch {
    console.error(`${RECS_FILE} not found. Save your JSON file first.`);
    process.exit(1);
  }

  if (data.lastUpdated && !FORCE) {
    const age = Date.now() - new Date(data.lastUpdated).getTime();
    if (age < SIX_HOURS) {
      console.log(`${RECS_FILE} is up to date (<6h). Use --force to override.`);
      return;
    }
  }

  const missingStatic = findMissingStaticMappings(data);
  if (missingStatic.length) {
    console.warn('[INFO] Not in static map (will auto-resolve):', missingStatic.join(', '));
  }

  const cache = await loadCache();
  const markets = Object.keys(data).filter(k => typeof data[k] === 'object' && data[k] !== null);

  for (const market of markets) {
    const bucket = data[market];
    if (!bucket?.safe || !bucket?.aggressive) continue;

    for (const group of ['safe', 'aggressive']) {
      const entries = bucket[group];
      if (!Array.isArray(entries)) continue;

      // Sequential with throttle to avoid rate limits
      const updated = [];
      for (const entry of entries) {
        const name = typeof entry === 'string' ? entry : entry.name;
        const prevSector = typeof entry === 'object' ? entry.sector ?? null : null;

        try {
          const sector = await fetchSector(name, cache);
          updated.push({ name, sector: sector ?? prevSector ?? null });
        } catch (err) {
          console.error(`[WARN] ${name}: ${err.message}`);
          updated.push({ name, sector: prevSector });
        }

        await sleep(SLEEP_MS);
      }

      data[market][group] = updated;
    }
  }

  data.lastUpdated = toKSTISOString(new Date());
  await fs.writeFile(RECS_FILE, JSON.stringify(data, null, 2));
  console.log(`Updated ${RECS_FILE}`);
}

updateRecommendations().catch(err => {
  console.error(err);
  process.exit(1);
});

