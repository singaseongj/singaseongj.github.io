// tools/buildPoolsTrendy.js
// Builds trend-aware pools using Finnhub (primary) and TwelveData or FMP as fallbacks for quotes.
// Writes: pools.json (names only) and pools-metrics.json (diagnostics).
// Safe: if no API keys or endpoints fail, it logs and leaves pools.json unchanged.

import fs from 'fs/promises';
import { execSync } from 'node:child_process';
import { TICKER_MAP } from '../src/maps.js';
import { getCandles, providerState } from '../src/data/candles.js';
import { buildUniverse } from '../src/universe/index.js';
import { buildNewsFeatures } from '../src/news/fetchByTicker.js';
import { fetchNaverTrends, buildBasketsFromUniverse } from '../src/trends/naverDatalab.js';
import { buildKeywordDict } from '../src/trends/keywordBuilder.js';

const FINNHUB = process.env.FINNHUB_API_KEY || '';
const TWELVE = process.env.TWELVEDATA_API_KEY || '';
const FMP = process.env.FMP_KEY || '';

const POOLS_FILE = 'pools.json';
const METRICS_FILE = 'pools-metrics.json';
const FEEDBACK_FILE = 'feedback.json';
const NEWS_FEATURES_FILE = 'data/news-features.json';
const NAVER_TRENDS_FILE = 'data/naver-trends.json';

const MARKETS = ["KOSPI", "KOSDAQ", "S&P 500", "NASDAQ 100"];
const PICK_COUNT = 12;
// Track picks from earlier markets in this run
const USED = {};

let NEWS_FEATURES = {};
try {
  NEWS_FEATURES = JSON.parse(await fs.readFile(NEWS_FEATURES_FILE, 'utf8'));
} catch {}

async function enrichWithNewsFeatures(symbols) {
  const feats = await buildNewsFeatures(symbols);
  try {
    await fs.mkdir('data', { recursive: true });
    await fs.writeFile(NEWS_FEATURES_FILE, JSON.stringify(feats, null, 2));
  } catch (e) {
    console.warn('Failed to persist news-features.json:', e.message);
  }
  return feats;
}

async function enrichWithNaverTrends(universe, keywordDict){
  try{
    const baskets = buildBasketsFromUniverse({
      universe,
      nameToSymbol,
      keywordDict
    });
    if (baskets.length === 0) return {};
    // pick a safe 12-month window to compute baseline
    const today = new Date();
    const end = today.toISOString().slice(0,10);
    const startDt = new Date(today.getTime() - 365*24*3600*1000);
    const start = startDt.toISOString().slice(0,10);

    const { perSymbol, raw } = await fetchNaverTrends({
      baskets, startDate: start, endDate: end, timeUnit: 'date',
      cacheTtlMs: Number(process.env.NAVER_TRENDS_CACHE_TTL_MS || 6*60*60*1000),
      budgetLeftMs: timeLeft()
    });
    try {
      await fs.writeFile(NAVER_TRENDS_FILE, JSON.stringify({ perSymbol, rawMeta: Object.keys(raw) }, null, 2));
    } catch {}
    const out = {};
    for (const [sym, t] of Object.entries(perSymbol)){
      out[sym] = {
        naverPopularity: t.naverPopularity,
        naverSpike: t.spike,
        naverPersist: t.persist,
        naverAsvi: t.lastAsvi
      };
    }
    return out;
  }catch(e){
    console.warn('[naver] trends enrichment failed:', e.message);
    return {};
  }
}

async function readPrevPools() {
  try {
    const txt = execSync('git show HEAD~1:pools.json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

// ---- flags
const ARGS = new Set(process.argv.slice(2));
const OFFLINE = ARGS.has('--offline');                // skip all network
const DRY_RUN = ARGS.has('--dry-run');
let MAX_PER_PROVIDER = Infinity;
let CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 3600000);
let COOLOFF_MS = Number(process.env.COOLOFF_MS || 60000);
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--max-per-provider=')) MAX_PER_PROVIDER = Number(a.split('=')[1]);
  if (a.startsWith('--cache-ttl-ms=')) CACHE_TTL_MS = Number(a.split('=')[1]);
  if (a.startsWith('--cooloff-ms=')) COOLOFF_MS = Number(a.split('=')[1]);
}
const COVERAGE_MIN = Number(process.env.COVERAGE_MIN || 0.1); // need ≥10% metrics to replace pools
const GLOBAL_BUDGET_MS = Number(process.env.GLOBAL_BUDGET_MS || 90000); // 90s soft budget
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 3);       // lower for demo keys
const DEMO_MODE = !process.env.FINNHUB_API_KEY || process.env.FINNHUB_API_KEY === 'demo';
const MIN_ADV_US = Number(process.env.MIN_ADV_US || 200000);
const MIN_ADV_KR = Number(process.env.MIN_ADV_KR || 50000);
const MIN_PRICE_USD = Number(process.env.MIN_PRICE_USD || 2);
const MIN_PRICE_KRW = Number(process.env.MIN_PRICE_KRW || 1000);
const ALLOWLIST = new Set(Object.values(TICKER_MAP));

// ---- time budget
const START_TS = Date.now();
function timeLeft() { return Math.max(0, GLOBAL_BUDGET_MS - (Date.now() - START_TS)); }
function budgetOk(ms=0) { return timeLeft() > ms; }

// ---- circuit breaker
let consecutiveErrors = 0;
const CIRCUIT_MAX_ERRORS = Number(process.env.CIRCUIT_MAX_ERRORS || 8);
function tripOnError(e) {
  const msg = String(e?.message || e || '');
  // If this came from KR news/earnings (which we now skip), do not escalate
  if (/company-news|calendar\/earnings/i.test(msg) && /K[QS]\b/.test(msg)) {
    console.warn(`[soft] ${msg}`);
    return false;
  }
  consecutiveErrors++;
  if (consecutiveErrors >= CIRCUIT_MAX_ERRORS) {
    console.warn(`[circuit] too many errors (${consecutiveErrors}), entering offline fallback`);
    return true;
  }
  return false;
}
function resetErrors(){ consecutiveErrors = 0; }

// try to import existing map if available (non-fatal if missing)
let NAME_TO_SYMBOL = {};
try {
  NAME_TO_SYMBOL = (await import('../data/tickerMap.js')).NAME_TO_SYMBOL || {};
} catch {}

NAME_TO_SYMBOL = {
  ...NAME_TO_SYMBOL,
  '삼성전자':'005930.KS','SK하이닉스':'000660.KS','현대차':'005380.KS','POSCO홀딩스':'005490.KS','LG화학':'051910.KS',
  'NAVER':'035420.KS','네이버':'035420.KS','카카오':'035720.KS','기아':'000270.KS','LG전자':'066570.KS','삼성SDI':'006400.KS',
  '에코프로':'086520.KS','셀트리온':'068270.KS','두산에너빌리티':'034020.KS','HD현대일렉트릭':'267260.KS','POSCO퓨처엠':'003670.KS',
  '셀트리온헬스케어':'091990.KQ','에코프로비엠':'247540.KQ','천보':'278280.KQ','리노공업':'058470.KQ','JYP엔터테인먼트':'035900.KQ',
  '알테오젠':'196170.KQ','레인보우로보틱스':'277810.KQ','HLB':'028300.KQ','펩트론':'087010.KQ','펄어비스':'263750.KQ','아이오케이':'078860.KQ',
  'CJ ENM':'035760.KQ',
  'Apple':'AAPL','Microsoft':'MSFT','NVIDIA':'NVDA','Amazon':'AMZN','Meta Platforms':'META','Alphabet':'GOOGL','Tesla':'TSLA','Netflix':'NFLX',
  'Super Micro Computer':'SMCI','Palantir':'PLTR','Arm Holdings':'ARM','Micron Technology':'MU','UiPath':'PATH','CrowdStrike':'CRWD',
  'Berkshire Hathaway (B)':'BRK-B','Johnson & Johnson':'JNJ','Procter & Gamble':'PG','Visa':'V','Coca-Cola':'KO','JPMorgan Chase':'JPM','UnitedHealth':'UNH',
  'Eli Lilly':'LLY','Uber Technologies':'UBER','NRG Energy':'NRG','ServiceNow':'NOW','Moderna':'MRNA','Zoom':'ZM','MongoDB':'MDB','Snowflake':'SNOW'
};

Object.assign(NAME_TO_SYMBOL, {
  '한화에어로스페이스': '012450.KS',
  'BGF리테일': '282330.KS',
  '삼성바이오로직스': '207940.KS'
});

// Build reverse lookup to convert tickers back to display names
const SYMBOL_TO_NAME = {};
for (const [name, symbol] of Object.entries({ ...NAME_TO_SYMBOL, ...TICKER_MAP })) {
  SYMBOL_TO_NAME[symbol] = name;
}

function nameToSymbol(name){
  if (NAME_TO_SYMBOL[name]) return NAME_TO_SYMBOL[name];
  if (/^[A-Z.\-]{1,7}(\.[A-Z]{1,3})?$/.test(name) || /^\d{6}\.K[QS]$/.test(name)) return name;
  return null;
}

// Small seed list; everything else (aliases/brands/news/templates) is auto-expanded
const NAVER_SEED_KEYWORDS = {
  '005930.KS': ['삼성전자','갤럭시','반도체','삼성전자 주가'],
  '000660.KS': ['SK하이닉스','하이닉스','HBM','반도체','주가'],
  '005380.KS': ['현대차','현대자동차','아이오닉','전기차','주가'],
  '035420.KS': ['네이버','NAVER','네이버 주가','클로바'],
  '035720.KS': ['카카오','카카오 주가','톡','카카오페이'],
  'AAPL': ['애플','Apple','아이폰','애플 주가'],
  'MSFT': ['마이크로소프트','Microsoft','윈도우','MS 주가'],
  'TSLA': ['테슬라','Tesla','테슬라 주가','사이버트럭'],
};

function isKR(symbolOrName) {
  // KR symbols end with .KS (KOSPI) or .KQ (KOSDAQ)
  return /\.K[QS]$/.test(String(symbolOrName));
}
function isUS(symbolOrName) {
  // US-ish symbols: letters, optional dot/dash, but not KR suffix
  return /^[A-Z][A-Z.\-]{0,6}$/.test(String(symbolOrName)) && !/\.K[QS]$/.test(String(symbolOrName));
}

// TwelveData expects colon format for KRX (e.g., 005930:KS, 091990:KQ)
function toTwelveSymbol(sym) {
  const m = String(sym).match(/^(\d{6})\.(K[QS])$/);
  return m ? `${m[1]}:${m[2]}` : sym;
}


const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || (DEMO_MODE ? 5000 : 8000));
const RETRIES = Number(process.env.RETRIES || (DEMO_MODE ? 1 : 3));
const BACKOFF_BASE_MS = Number(process.env.BACKOFF_BASE_MS || (DEMO_MODE ? 400 : 600));

async function getJSON(url, headers = {}, retries = RETRIES, base = BACKOFF_BASE_MS) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (!budgetOk()) throw new Error('global budget exhausted');
    const controller = new AbortController();
    const perReq = Math.min(REQ_TIMEOUT_MS, timeLeft());
    const timer = setTimeout(() => controller.abort(), perReq);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      resetErrors();
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (tripOnError(e)) throw lastErr;
      if (attempt < retries && budgetOk()) {
        const backoff = base * Math.pow(2, attempt);
        const redacted = url.replace(/token=[^&]+/i, 'token=***').replace(/apikey=[^&]+/i, 'apikey=***');
        console.log(`[net] retry ${attempt + 1}/${retries} in ${backoff}ms :: ${redacted}`);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
    }
  }
  throw lastErr;
}

async function writeAtomic(p, data) {
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, p);
}

async function loadJson(p, fallback=null) {
  try { return JSON.parse(await fs.readFile(p,'utf8')); } catch { return fallback; }
}

function rank01(values) {
  // values: array of numbers (may include null). Return normalized map of idx -> 0..1 with null -> 0.
  const arr = values.map(v => (Number.isFinite(v) ? v : null));
  const nums = arr.filter(v => v !== null);
  if (nums.length === 0) return values.map(_ => 0);
  const min = Math.min(...nums), max = Math.max(...nums);
  if (min === max) return values.map(v => (v === null ? 0 : 0.5));
  return arr.map(v => (v === null ? 0 : (v - min) / (max - min)));
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function namesOnlyRank(universe, features) {
  const out = {};
  for (const m of MARKETS) {
    const names = universe[m] || [];
    const total = names.length;
    const kSafe = Math.min(8, Math.ceil(total * 0.7));
    const kAggr = Math.min(4, Math.max(0, total - kSafe));

    const scored = names.map(n => {
      const sym = nameToSymbol(n) || n;
      const nf = features[sym] || {};
      const count = Math.min(nf.count || 0, 30) / 30;
      const sentiment = ((nf.sentiment ?? 0) + 1) / 2;
      const pop = nf.naverPopularity ?? 0;
      const score = count * 0.12 + (sentiment - 0.5) * 0.08 + (/\.K[QS]$/.test(sym) ? pop * 0.20 : 0);
      return { name: n, score };
    }).sort((a,b)=>b.score-a.score).map(s=>s.name);
    out[m] = { safe: scored.slice(0, kSafe), aggressive: scored.slice(kSafe, kSafe + kAggr) };
  }
  return out;
}

function todayYMD(offsetDays=0){
  const d = new Date(Date.now() + offsetDays*86400000);
  return d.toISOString().slice(0,10);
}

// Finnhub earnings window ±10d
async function finnhubRecentEarnings(symbol){
  const from = todayYMD(-10), to = todayYMD(+10);
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(symbol)}&token=${FINNHUB}`;
  const j = await getJSON(url).catch(()=>null);
  const rows = j?.earningsCalendar || [];
  return rows.some(x => (x.symbol || x.ticker) === symbol);
}

// ---------- Metrics from candles ----------
function computeMetrics(c, v){
  // c: closes oldest..newest, v: volumes oldest..newest
  if (!Array.isArray(c) || c.length < 21) return { ret5: null, ret20: null, vol20: null, turnover: null, adv20: null, close: null };
  const n = c.length;
  const ret5  = (c[n-1] - c[n-6]) / c[n-6] * 100;   // %
  const ret20 = (c[n-1] - c[n-21]) / c[n-21] * 100; // %
  // simple volatility: stdev of last 20 daily returns
  const rets = [];
  for (let i=n-20; i<n; i++){
    const r = (c[i] - c[i-1]) / c[i-1];
    rets.push(r);
  }
  const mean = rets.reduce((a,b)=>a+b,0)/rets.length;
  const variance = rets.reduce((a,b)=>a+(b-mean)*(b-mean),0)/rets.length;
  const vol20 = Math.sqrt(variance); // daily stdev
  // turnover proxy: avg volume last 5 relative to last 20
  const avg = (arr, s, e)=>arr.slice(s,e).reduce((a,b)=>a+b,0)/(e-s);
  const v5 = avg(v, n-5, n), v20avg = avg(v, n-20, n);
  const turnover = v20avg ? (v5 / v20avg) : null;
  const adv20 = v20avg || null;
  const close = c[n-1];
  return { ret5, ret20, vol20, turnover, adv20, close };
}

function coverageRatio(metrics) {
  // count entries with at least one non-null metric or news/earn flag
  const vals = Object.values(metrics || {});
  if (!vals.length) return 0;
  const ok = vals.filter(m => {
    return [m.ret5, m.ret20, m.vol20, m.turnover].some(x => Number.isFinite(x)) || m.newsCount > 0 || m.earn === true;
  }).length;
  return ok / vals.length;
}

// ---------- Universe & name→symbol mapping ----------
/*
  We will reuse your existing TICKER_MAP and Yahoo resolution inside fetchStockInfo.js for KR/US names.
  For the pool generator, we only need NAMES. fetchStockInfo.js later resolves symbols when enriching.
  So here we operate on names, and for Finnhub/TwelveData calls we TRY simple symbol = name if it looks like a ticker,
  else skip candle/news/earnings (metrics become null). This keeps the generator resilient.
*/

// ---------- Feedback handling ----------
function applyFeedback(scoresByName, feedback, market){
  const weights = feedback?.weights?.[market] || {};
  const out = {};
  for (const [name, score] of Object.entries(scoresByName)){
    const w = Number.isFinite(weights[name]) ? weights[name] : 0;
    out[name] = clamp01(score + w);
  }
  return out;
}

function maybeDecayFeedback(feedback){
  try{
    const half = feedback?.decay?.half_life_days ?? 14;
    const last = feedback?.decay?.last_decay_ts ? Date.parse(feedback.decay.last_decay_ts) : 0;
    if (Date.now() - last < half*86400000) return feedback;
    const f2 = JSON.parse(JSON.stringify(feedback));
    for (const m of Object.keys(f2.weights||{})){
      for (const k of Object.keys(f2.weights[m]||{})){
        f2.weights[m][k] = Number(f2.weights[m][k]) * 0.5;
      }
    }
    f2.decay = f2.decay || {};
    f2.decay.last_decay_ts = new Date().toISOString();
    return f2;
  }catch{ return feedback; }
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0, active = 0, aborted = false;
  return await new Promise((resolve, reject) => {
    const next = () => {
      if (aborted) return;
      while (active < limit && i < items.length) {
        const idx = i++;
        active++;
        Promise.resolve(worker(items[idx], idx))
          .then(val => { out[idx] = val; active--; next(); })
          .catch(err => { aborted = true; reject(err); });
      }
      if (i >= items.length && active === 0) resolve(out);
    };
    next();
  });
}

function enforceRotationForMarket({ market, chosenSafe, chosenAggr, scoreSafe, scoreAggr, prevSet, minSwaps = Number(process.env.ROTATE_MIN_SWAPS || 1) }) {
  const safeRanked = Object.entries(scoreSafe).sort((a,b)=>b[1]-a[1]).map(([n])=>n);
  const aggrRanked = Object.entries(scoreAggr).sort((a,b)=>b[1]-a[1]).map(([n])=>n);

  let swaps = 0;

  function swapIn(arr, ranked) {
    // find first candidate not already present that’s in the ranked list
    const curSet = new Set(arr);
    for (const cand of ranked) {
      if (!curSet.has(cand)) {
        // replace the last element (lowest score) to minimize disruption
        arr[arr.length - 1] = cand;
        swaps++;
        return true;
      }
    }
    return false;
  }

  const combined = new Set([...chosenSafe, ...chosenAggr]);
  let identical = true;
  for (const n of combined) if (!prevSet.has(n)) { identical = false; break; }

  if (!identical) return { chosenSafe, chosenAggr, swaps };

  // try to introduce at least one outsider
  swapIn(chosenAggr, aggrRanked) || swapIn(chosenSafe, safeRanked);

  // If more swaps requested, keep swapping aggr first, then safe
  while (swaps < minSwaps && (swapIn(chosenAggr, aggrRanked) || swapIn(chosenSafe, safeRanked))) {}

  return { chosenSafe, chosenAggr, swaps };
}

// ---------- Main ----------
async function main(){
  const pools = await loadJson(POOLS_FILE);
  if (!pools){
    console.log('[buildPools] No pools.json; nothing to do.');
    process.exit(0);
  }
  console.log(`[buildPools] start :: FINNHUB=${!!process.env.FINNHUB_API_KEY} TWELVE=${!!process.env.TWELVEDATA_API_KEY} OFFLINE=${OFFLINE} DEMO=${DEMO_MODE} budget=${GLOBAL_BUDGET_MS}ms`);

  // Ensure pools object has entries for all markets
  for (const m of MARKETS) {
    if (!pools[m]) pools[m] = { safe: [], aggressive: [] };
  }

  const feedback = await loadJson(FEEDBACK_FILE, { version:1, weights:{}, decay:{ half_life_days:14, last_decay_ts:null }});
  const metricsOut = {};
  const marketCoverage = {};

  const universe = OFFLINE
    ? Object.fromEntries(MARKETS.map(m => [m, Array.from(new Set([...(pools[m]?.safe || []), ...(pools[m]?.aggressive || [])]))]))
    : await buildUniverse(pools, { limitPerMarket: Number(process.env.UNIVERSE_LIMIT || 100) });

  const symbolSet = new Set();
  for (const names of Object.values(universe)) {
    for (const n of names) {
      const sym = nameToSymbol(n);
      if (sym) symbolSet.add(sym);
    }
  }
  // Build scalable Naver keywords (seeds + aliases/brands + mined news + templates)
  const symbols = Array.from(symbolSet);
  const KEYWORDS = await buildKeywordDict({
    symbols,
    seeds: NAVER_SEED_KEYWORDS,
    symbolToName: SYMBOL_TO_NAME,
    newsFeatures: NEWS_FEATURES,
  });
  // Persist for visibility/debugging
  try {
    await fs.mkdir('data', { recursive: true });
    await fs.writeFile('data/naver-keywords.json', JSON.stringify(KEYWORDS, null, 2));
  } catch {}

  if (!OFFLINE) {
    NEWS_FEATURES = await enrichWithNewsFeatures(Array.from(symbolSet));
    const NAVER_TRENDS = await enrichWithNaverTrends(universe, KEYWORDS);
    // Merge trends into NEWS_FEATURES (non-destructive)
    for (const [k, v] of Object.entries(NAVER_TRENDS)){
      NEWS_FEATURES[k] = { ...(NEWS_FEATURES[k] || {}), ...v };
    }
  } else {
    console.warn('[buildPools] offline mode, using cached news features');
  }
  const prevPools = await readPrevPools();

  for (const market of MARKETS){
    if (Number.isFinite(MAX_PER_PROVIDER)) {
      for (const s of Object.values(providerState)) s.count = 0;
    }
    const buckets = pools[market];
    if (!buckets) continue;
    const names = universe[market] || [];
    console.log(`[buildPools] market=${market} names=${names.length}`);
    if (names.length === 0) continue;

    // Fetch signals per name best-effort
    const byName = {};
    await mapLimit(names, Math.max(1, Math.min(MAX_CONCURRENCY, DEMO_MODE ? 2 : MAX_CONCURRENCY)), async (name) => {
      if (timeLeft() < GLOBAL_BUDGET_MS * 0.1) return; // 90% budget used
      if (!budgetOk(200)) return; // skip if no time left
      let sym = OFFLINE ? null : nameToSymbol(name);
      // ensure KR names use map if available
      if (!sym && NAME_TO_SYMBOL[name]) sym = NAME_TO_SYMBOL[name];

      let route = 'no-symbol';
      let routeDetail = '';
      if (sym) {
        if (isKR(sym)) {
          const tsym = toTwelveSymbol(sym);
          route = 'KR→TwelveData';
          routeDetail = ` (${tsym})`;
        } else if (isUS(sym)) {
          route = 'US→Finnhub';
          routeDetail = ` (${sym})`;
        } else {
          route = 'Other';
          routeDetail = ` (${sym})`;
        }
      }
      console.log(`[buildPools] ${market} :: ${name} ${route}${routeDetail}`);

      let ret5=null, ret20=null, vol20=null, turnover=null, adv20=null, close=null; let newsCount=0; let sentiment=null; let naverPopularity=0; let blogMentions=0; let earn=false; let candles=null;
      try {
        candles = (sym && budgetOk(REQ_TIMEOUT_MS)) ? await getCandles(sym, { cacheTtlMs: CACHE_TTL_MS, cooloffMs: COOLOFF_MS, maxPerProvider: MAX_PER_PROVIDER }).catch(e => { tripOnError(e); return null; }) : null;
        if (candles && Array.isArray(candles.c) && Array.isArray(candles.v)) {
          const m = computeMetrics(candles.c, candles.v);
          ret5 = m.ret5; ret20 = m.ret20; vol20 = m.vol20; turnover = m.turnover; adv20 = m.adv20; close = m.close;
        }
        const nf = NEWS_FEATURES[sym] || NEWS_FEATURES[name];
        if (nf) {
          newsCount = nf.count || 0;
          sentiment = typeof nf.sentiment === 'number' ? nf.sentiment : null;
          naverPopularity = typeof nf.naverPopularity === 'number' ? nf.naverPopularity : 0;
          blogMentions = typeof nf.blogMentions === 'number' ? nf.blogMentions : 0;
        }
        if (FINNHUB && sym && isUS(sym) && budgetOk(REQ_TIMEOUT_MS)) {
          earn   = await finnhubRecentEarnings(sym).catch(e => { tripOnError(e); return false; });
        } else {
          earn = false;
        }
      } catch (e) {
        tripOnError(e);
      }

      byName[name] = { ret5, ret20, vol20, turnover, adv20, close, newsCount, sentiment, naverPopularity, blogMentions, earn, sym: sym || null, source: candles?.source || null, attempts: candles?.attempts || [], fetchMs: candles?.fetchMs || 0 };
    });
    const filteredNames = names.filter(n => {
      const m = byName[n];
      const sym = m.sym;
      const isKRName = sym ? isKR(sym) : false;
      const advOk = m.adv20 == null || m.adv20 >= (isKRName ? MIN_ADV_KR : MIN_ADV_US) || (sym && ALLOWLIST.has(sym));
      const priceOk = m.close == null || m.close >= (isKRName ? MIN_PRICE_KRW : MIN_PRICE_USD);
      return advOk && priceOk;
    });

    // Normalize within market
    const nRet5   = rank01(filteredNames.map(n => byName[n].ret5));
    const nRet20  = rank01(filteredNames.map(n => byName[n].ret20));
    const nTurn   = rank01(filteredNames.map(n => byName[n].turnover));
    const nVol    = rank01(filteredNames.map(n => byName[n].vol20));   // higher vol = riskier
    const nBlog   = rank01(filteredNames.map(n => byName[n].blogMentions));

    // Scores
    const scoreSafeRaw = {};
    const scoreAggrRaw = {};
    filteredNames.forEach((n, i) => {
      const earnBonus = byName[n].earn ? 0.10 : 0;
      const sym = byName[n].sym;
      const isKRName = sym ? isKR(sym) : false;
      const baseKR = isKRName ? 0.05 : 0;

      const newsCountNorm = Math.min(byName[n].newsCount || 0, 30) / 30;
      const sentimentNorm = ((byName[n].sentiment ?? 0) + 1) / 2;
      const pop = byName[n].naverPopularity ?? 0;
      const blogNorm = nBlog[i];
      const newsBoost = newsCountNorm * 0.12 + (sentimentNorm - 0.5) * 0.08 + (isKRName ? pop * 0.20 : 0) + blogNorm * 0.05;

      const safe = clamp01(baseKR + 0.40*nRet20[i] + 0.30*(1 - nVol[i]) + newsBoost + 0.10*earnBonus);
      const aggr = clamp01(baseKR + 0.40*nRet5[i]  + 0.30*nTurn[i]     + 0.20*nVol[i] + newsBoost + earnBonus);
      scoreSafeRaw[n] = safe;
      scoreAggrRaw[n] = aggr;
    });

    // Apply feedback nudges
    const scoreSafe = applyFeedback(scoreSafeRaw, feedback, market);
    const scoreAggr = applyFeedback(scoreAggrRaw, feedback, market);

    // -------- Small overlap penalty for later U.S. markets ----------
    // If this is NASDAQ 100, penalize names that already appear in S&P 500 SAFE
    if (market === 'NASDAQ 100' && USED['S&P 500']?.safe?.length) {
      const earlierSafeNames = USED['S&P 500'].safe;
      const earlierSafeSyms = new Set(
        earlierSafeNames.map(n => nameToSymbol(n) || n)
      );
      for (const n of Object.keys(scoreSafe)) {
        const sym = nameToSymbol(n) || n;
        if (earlierSafeSyms.has(sym)) {
          // clamp01 handles floor/ceil
          scoreSafe[n] = clamp01(scoreSafe[n] - 0.15);
          scoreAggr[n] = clamp01(scoreAggr[n] - 0.10);
        }
      }
    }

    // Pick top K distinct names for each bucket
    const total = filteredNames.length;
    let kSafe = Math.min(6, Math.ceil(total * 0.5));
    let kAggr = Math.min(6, total - kSafe);
    if (total >= 2 && kAggr === 0) {
      kAggr = 1;
      if (kSafe > 0) kSafe = Math.min(kSafe, total - kAggr);
    }

    function topK(scores, k){
      return Object.entries(scores).sort((a,b)=>b[1]-a[1]).slice(0,k).map(([n])=>n);
    }

    let chosenSafe = topK(scoreSafe, kSafe);
    const aggrCandidates = topK(scoreAggr, Math.min(kSafe + kAggr * 2, total));
    let chosenAggr = aggrCandidates.filter(n => !chosenSafe.includes(n)).slice(0, kAggr);

    if (chosenAggr.length < kAggr) {
      const need = kAggr - chosenAggr.length;
      const backfill = aggrCandidates.filter(n => !chosenSafe.includes(n) && !chosenAggr.includes(n)).slice(0, need);
      chosenAggr = chosenAggr.concat(backfill);
    }
    if (chosenAggr.length < kAggr) {
      const everything = Object.keys(scoreAggr);
      const need = kAggr - chosenAggr.length;
      const tail = everything.filter(n => !chosenAggr.includes(n)).slice(-need);
      chosenAggr = chosenAggr.concat(tail);
    }
    
    // -------- Cross-market de-duplication guard ----------
    const earlierAll = Object.values(USED).flatMap(u => [...(u.safe||[]), ...(u.aggressive||[])]);
    const earlierSet = new Set(earlierAll.map(n => nameToSymbol(n) || n));

    function dedupAndBackfill(list, scoreMap, k, candidateOrder) {
      const out = [];
      const seen = new Set();
      for (const n of list) {
        const sym = nameToSymbol(n) || n;
        if (!earlierSet.has(sym) && !seen.has(sym)) {
          out.push(n); seen.add(sym);
        }
        if (out.length >= k) break;
      }
      if (out.length < k) {
        for (const cand of candidateOrder) {
          const sym = nameToSymbol(cand) || cand;
          if (!earlierSet.has(sym) && !seen.has(sym)) {
            out.push(cand); seen.add(sym);
          }
          if (out.length >= k) break;
        }
      }
      return out;
    }

    // Build a global descending order for backfill
    const safeOrder = Object.keys(scoreSafe).sort((a,b)=>scoreSafe[b]-scoreSafe[a]);
    const aggrOrder = Object.keys(scoreAggr).sort((a,b)=>scoreAggr[b]-scoreAggr[a]);

    chosenSafe = dedupAndBackfill(chosenSafe, scoreSafe, kSafe, safeOrder);
    chosenAggr = dedupAndBackfill(chosenAggr, scoreAggr, kAggr, aggrCandidates.concat(aggrOrder));

    if (prevPools) {
      const prevSet = new Set([...(prevPools[market]?.safe || []), ...(prevPools[market]?.aggressive || [])]);
      const enforced = enforceRotationForMarket({ market, chosenSafe, chosenAggr, scoreSafe, scoreAggr, prevSet });
      chosenSafe = enforced.chosenSafe;
      chosenAggr = enforced.chosenAggr;
    }

    console.log(`[buildPools] ${market} total=${names.length} filtered=${filteredNames.length} kSafe=${kSafe} kAggr=${kAggr}`);
    console.log(`[buildPools] chosenSafe=${chosenSafe.length} chosenAggr=${chosenAggr.length}`);

    pools[market] = {
      safe: chosenSafe,
      aggressive: chosenAggr
    };

    // Record for later markets (used by penalty & de-dup)
    USED[market] = { safe: chosenSafe.slice(), aggressive: chosenAggr.slice() };

    metricsOut[market] = filteredNames.reduce((acc, n, i) => {
      const newsCountNorm = Math.min(byName[n].newsCount || 0, 30) / 30;
      const sentimentNorm = ((byName[n].sentiment ?? 0) + 1) / 2;
      const pop = byName[n].naverPopularity ?? 0;
      const blogNorm = nBlog[i];
      acc[n] = {
        ret5: byName[n].ret5, ret20: byName[n].ret20, vol20: byName[n].vol20, turnover: byName[n].turnover,
        adv20: byName[n].adv20, close: byName[n].close, newsCount: byName[n].newsCount, sentiment: byName[n].sentiment, naverPopularity: byName[n].naverPopularity, blogMentions: byName[n].blogMentions, recentEarnings: byName[n].earn,
        source: byName[n].source, attempts: byName[n].attempts, fetchMs: byName[n].fetchMs,
        norm: { ret5: nRet5[i], ret20: nRet20[i], vol20: nVol[i], turnover: nTurn[i], newsCount: newsCountNorm, sentiment: sentimentNorm, popularity: pop, blogMentions: blogNorm },
        score: { safe: scoreSafe[n], aggressive: scoreAggr[n] }
      };
      return acc;
    }, {});

    marketCoverage[market] = coverageRatio(byName);
  }

  const covs = Object.values(marketCoverage);
  const avgCoverage = covs.length ? covs.reduce((a,b)=>a+b,0)/covs.length : 0;
  console.log(`[buildPools] avg coverage=${(avgCoverage*100).toFixed(1)}% (min=${(Math.min(...covs)*100||0).toFixed(1)}%)`);

  const providerSummary = {};
  for (const [p, s] of Object.entries(providerState)) {
    providerSummary[p] = { ok: s.ok || 0, err: s.err || 0, '429': s['429'] || 0 };
  }
  const marketSizes = {};
  for (const m of MARKETS) {
    marketSizes[m] = { safe: pools[m].safe.length, aggressive: pools[m].aggressive.length };
  }
  metricsOut.summary = {
    markets: marketSizes,
    providers: providerSummary,
    coverage: { ...marketCoverage, avg: avgCoverage },
    timingMs: { total: Date.now() - START_TS }
  };

  if (OFFLINE) {
    console.warn(`[buildPools] offline mode, leaving pools.json unchanged`);
    await writeAtomic(METRICS_FILE, JSON.stringify(metricsOut, null, 2));
    console.log('[buildPools] wrote pools-metrics.json (pools.json unchanged)');
    return;
  }
  if (DRY_RUN) {
    console.warn(`[buildPools] dry-run, no writes`);
    await writeAtomic(METRICS_FILE, JSON.stringify(metricsOut, null, 2));
    console.log('[buildPools] wrote pools-metrics.json (dry-run)');
    return;
  }
  if (avgCoverage < COVERAGE_MIN) {
    console.warn(`[buildPools] low metric coverage (avg=${(avgCoverage*100).toFixed(1)}%), using names-only ranking`);
    const ranked = namesOnlyRank(universe, NEWS_FEATURES);
    await writeAtomic(POOLS_FILE, JSON.stringify(ranked, null, 2));
    await writeAtomic(METRICS_FILE, JSON.stringify(metricsOut, null, 2));
    console.log('[buildPools] wrote pools.json and pools-metrics.json :: names-only');
    return;
  }

  // Decay feedback periodically
  const decayed = maybeDecayFeedback(feedback);
  if (decayed !== feedback){
    await writeAtomic(FEEDBACK_FILE, JSON.stringify(decayed, null, 2));
    console.log('[buildPools] feedback decayed');
  }

  // Write outputs
  await writeAtomic(POOLS_FILE, JSON.stringify(pools, null, 2));
  await writeAtomic(METRICS_FILE, JSON.stringify(metricsOut, null, 2));
  console.log('[buildPools] wrote pools.json and pools-metrics.json :: done');
}

main().catch(e => { console.error('[buildPools] failed:', e.message); process.exit(0); });
