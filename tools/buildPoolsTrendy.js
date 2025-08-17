// tools/buildPoolsTrendy.js
// Builds trend-aware pools using Finnhub (primary) and TwelveData (fallback for quotes).
// Writes: pools.json (names only) and pools-metrics.json (diagnostics).
// Safe: if no API keys or endpoints fail, it logs and leaves pools.json unchanged.

import fs from 'fs/promises';
import { yahooTrending, yahooPredefined } from '../src/sources/yahoo.js';
import { TICKER_MAP } from '../src/maps.js';

const FINNHUB = process.env.FINNHUB_API_KEY || '';
const TWELVE = process.env.TWELVEDATA_API_KEY || '';

const POOLS_FILE = 'pools.json';
const METRICS_FILE = 'pools-metrics.json';
const FEEDBACK_FILE = 'feedback.json';
const TRENDING_CACHE_FILE = 'trending-cache.json';

let trendingCache = {};
try {
  trendingCache = JSON.parse(await fs.readFile(TRENDING_CACHE_FILE, 'utf8'));
} catch {}

// Include NYSE and NASDAQ 100 so all markets get pools
const MARKETS = ["KOSPI","KOSDAQ","NASDAQ","S&P 500","NYSE","NASDAQ 100"];
const PICK_COUNT = 5;

// ---- flags
const ARGS = new Set(process.argv.slice(2));
const OFFLINE = ARGS.has('--offline');                // skip all network
const COVERAGE_MIN = Number(process.env.COVERAGE_MIN || 0.3); // need ≥30% metrics to replace pools
const GLOBAL_BUDGET_MS = Number(process.env.GLOBAL_BUDGET_MS || 90000); // 90s soft budget
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 3);       // lower for demo keys
const DEMO_MODE = !process.env.FINNHUB_API_KEY || process.env.FINNHUB_API_KEY === 'demo';

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

// Fetch trending tickers and convert them to display names
async function getTrendingNamesForMarket(market) {
  if (OFFLINE) return trendingCache[market] || [];
  let tickers = [];
  try {
    if (market === 'KOSPI' || market === 'KOSDAQ') {
      tickers = await yahooTrending('KR');
    } else if (market === 'NYSE') {
      tickers = [
        ...(await yahooTrending('NYSE')),
        ...(await yahooPredefined('day_gainers_nyse'))
      ];
    } else if (market === 'NASDAQ 100') {
      tickers = [
        ...(await yahooTrending('NASDAQ 100')),
        ...(await yahooPredefined('day_gainers_nasdaq100'))
      ];
    } else if (market === 'NASDAQ') {
      tickers = [
        ...(await yahooTrending('NASDAQ')),
        ...(await yahooPredefined('day_gainers'))
      ];
    } else {
      tickers = [
        ...(await yahooTrending('US')),
        ...(await yahooPredefined('day_gainers'))
      ];
    }
  } catch (e) {
    console.warn(`[buildPools] trending unavailable for ${market}:`, e.message);
    return trendingCache[market] || [];
  }
  const names = new Set();
  for (const t of tickers) {
    const name = SYMBOL_TO_NAME[t] || t;
    names.add(name);
  }
  return Array.from(names);
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

function todayYMD(offsetDays=0){
  const d = new Date(Date.now() + offsetDays*86400000);
  return d.toISOString().slice(0,10);
}

// ---------- Data fetchers ----------

// Finnhub candles (primary for quotes/vol)
async function finnhubCandles(symbol){
  const to = Math.floor(Date.now()/1000);
  const from = to - 60*60*24*40; // ~40 days
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${FINNHUB}`;
  const j = await getJSON(url);
  // j: { s: 'ok', c:[], v:[], t:[] }
  if (j?.s !== 'ok') return null;
  return j;
}

// TwelveData time series (fallback)
async function twelveCandles(symbol){
  const tsym = toTwelveSymbol(symbol);
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tsym)}&interval=1day&outputsize=40&apikey=${TWELVE}`;
  const j = await getJSON(url);
  const data = j?.values;
  if (!Array.isArray(data)) return null;
  const closes = [], vols = [];
  for (let i = data.length - 1; i >= 0; i--) {
    closes.push(Number(data[i].close));
    vols.push(Number(data[i].volume || 0));
  }
  return { c: closes, v: vols, _tsym: tsym };
}

async function getCandles(symbol){
  if (isKR(symbol)) {
    if (TWELVE) {
      const j = await twelveCandles(symbol).catch(() => null);
      if (j) return j; // { c, v, _tsym }
    }
    // Do NOT try Finnhub for KR; return null to avoid error storms
    return null;
  } else {
    // US/other: prefer Finnhub, then TwelveData
    if (FINNHUB) {
      const j = await finnhubCandles(symbol).catch(() => null);
      if (j) return { c: j.c, v: j.v, _tsym: symbol };
    }
    if (TWELVE) {
      const j = await twelveCandles(symbol).catch(() => null);
      if (j) return j;
    }
    return null;
  }
}

// Finnhub company news count (72h)
async function finnhubNewsCount(symbol){
  const from = todayYMD(-3), to = todayYMD(0);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${FINNHUB}`;
  const arr = await getJSON(url).catch(()=>null);
  return Array.isArray(arr) ? arr.length : 0;
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
  if (!Array.isArray(c) || c.length < 21) return { ret5: null, ret20: null, vol20: null, turnover: null };
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
  const v5 = avg(v, n-5, n), v20 = avg(v, n-20, n);
  const turnover = v20 ? (v5 / v20) : null;
  return { ret5, ret20, vol20, turnover };
}

function coverageRatio(metrics) {
  // count entries with at least one non-null metric or news/earn flag
  const vals = Object.values(metrics || {});
  if (!vals.length) return 0;
  const ok = vals.filter(m => {
    return [m.ret5, m.ret20, m.vol20, m.turnover].some(x => Number.isFinite(x)) || m.news72 > 0 || m.earn === true;
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

  for (const market of MARKETS){
    const buckets = pools[market];
    if (!buckets) continue;
    const baseNames = [...(buckets.safe || []), ...(buckets.aggressive || [])]
      .map(x => typeof x === 'string' ? x : x.name)
      .filter(Boolean);
    const extraNames = await getTrendingNamesForMarket(market);
    trendingCache[market] = extraNames;
    await fs.writeFile(TRENDING_CACHE_FILE, JSON.stringify(trendingCache, null, 2));
    const names = Array.from(new Set([...baseNames, ...extraNames]));
    console.log(`[buildPools] market=${market} names=${names.length}`);
    if (names.length === 0) continue;

    // Fetch signals per name best-effort
    const byName = {};
    await mapLimit(names, Math.max(1, Math.min(MAX_CONCURRENCY, DEMO_MODE ? 2 : MAX_CONCURRENCY)), async (name) => {
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

      let ret5=null, ret20=null, vol20=null, turnover=null; let news72=0; let earn=false;
      try {
        const candles = (sym && budgetOk(REQ_TIMEOUT_MS)) ? await getCandles(sym).catch(e => { tripOnError(e); return null; }) : null;
        if (candles && Array.isArray(candles.c) && Array.isArray(candles.v)) {
          const m = computeMetrics(candles.c, candles.v);
          ret5 = m.ret5; ret20 = m.ret20; vol20 = m.vol20; turnover = m.turnover;
        }
        if (FINNHUB && sym && isUS(sym) && budgetOk(REQ_TIMEOUT_MS)) {
          news72 = await finnhubNewsCount(sym).catch(e => { tripOnError(e); return 0; });
          earn   = await finnhubRecentEarnings(sym).catch(e => { tripOnError(e); return false; });
        } else {
          // KR or no Finnhub: skip these to avoid 4xx floods
          news72 = 0;
          earn = false;
        }
      } catch (e) {
        tripOnError(e);
      }

      byName[name] = { ret5, ret20, vol20, turnover, news72, earn, sym };
    });

    // Normalize within market
    const nRet5   = rank01(names.map(n => byName[n].ret5));
    const nRet20  = rank01(names.map(n => byName[n].ret20));
    const nTurn   = rank01(names.map(n => byName[n].turnover));
    const nVol    = rank01(names.map(n => byName[n].vol20));   // higher vol = riskier
    const nNews   = rank01(names.map(n => byName[n].news72));

    // Scores
    const scoreSafeRaw = {};
    const scoreAggrRaw = {};
    names.forEach((n, i) => {
      const earnBonus = byName[n].earn ? 0.10 : 0;
      const sym = byName[n].sym;
      const isKRName = sym ? isKR(sym) : false;
      const baseKR = isKRName ? 0.05 : 0;

      const safe = clamp01(baseKR + 0.35*nNews[i] + 0.35*nRet20[i] + 0.20*nRet5[i] + 0.10*(1 - nVol[i]) + earnBonus);
      const aggr = clamp01(baseKR + 0.45*nNews[i] + 0.35*nRet5[i]  + 0.20*nTurn[i]                        + earnBonus);
      scoreSafeRaw[n] = safe;
      scoreAggrRaw[n] = aggr;
    });

    // Apply feedback nudges
    const scoreSafe = applyFeedback(scoreSafeRaw, feedback, market);
    const scoreAggr = applyFeedback(scoreAggrRaw, feedback, market);

    // Pick top K distinct names for each bucket
    function topK(scores, k){
      return Object.entries(scores).sort((a,b)=>b[1]-a[1]).slice(0,k).map(([n])=>n);
    }
    const chosenSafe = topK(scoreSafe, PICK_COUNT);
    const chosenAggr = topK(scoreAggr, PICK_COUNT);

    pools[market] = {
      safe: chosenSafe,
      aggressive: chosenAggr
    };

    metricsOut[market] = names.reduce((acc, n, i) => {
      acc[n] = {
        ret5: byName[n].ret5, ret20: byName[n].ret20, vol20: byName[n].vol20, turnover: byName[n].turnover,
        news72h: byName[n].news72, recentEarnings: byName[n].earn,
        norm: { ret5: nRet5[i], ret20: nRet20[i], vol20: nVol[i], turnover: nTurn[i], news72h: nNews[i] },
        score: { safe: scoreSafe[n], aggressive: scoreAggr[n] }
      };
      return acc;
    }, {});

    marketCoverage[market] = coverageRatio(byName);
  }

  const covs = Object.values(marketCoverage);
  const avgCoverage = covs.length ? covs.reduce((a,b)=>a+b,0)/covs.length : 0;
  console.log(`[buildPools] avg coverage=${(avgCoverage*100).toFixed(1)}% (min=${(Math.min(...covs)*100||0).toFixed(1)}%)`);

  if (OFFLINE || avgCoverage < COVERAGE_MIN) {
    console.warn(`[buildPools] insufficient coverage or offline (avg=${(avgCoverage*100).toFixed(1)}%), leaving pools.json unchanged`);
    // still write metrics file for debugging
    await writeAtomic(METRICS_FILE, JSON.stringify(metricsOut, null, 2));
    console.log('[buildPools] wrote pools-metrics.json (pools.json unchanged)');
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
