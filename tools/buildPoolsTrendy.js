// tools/buildPoolsTrendy.js
// Builds trend-aware pools using Finnhub (primary) and TwelveData (fallback for quotes).
// Writes: pools.json (names only) and pools-metrics.json (diagnostics).
// Safe: if no API keys or endpoints fail, it logs and leaves pools.json unchanged.

import fs from 'fs/promises';

const FINNHUB = process.env.FINNHUB_API_KEY || '';
const TWELVE = process.env.TWELVEDATA_API_KEY || '';

const POOLS_FILE = 'pools.json';
const METRICS_FILE = 'pools-metrics.json';
const FEEDBACK_FILE = 'feedback.json';

const MARKETS = ["KOSPI","KOSDAQ","NASDAQ","S&P 500"];
const PICK_COUNT = 5;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const REQ_TIMEOUT_MS = 8000;   // 8 seconds per HTTP request
const RETRIES = 3;
const BACKOFF_BASE_MS = 600;

async function getJSON(url, headers = {}, retries = RETRIES, base = BACKOFF_BASE_MS) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQ_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) {
        const backoff = base * Math.pow(2, attempt);
        console.log(`[net] retry ${attempt + 1}/${retries} after ${backoff}ms :: ${url}`);
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
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=40&apikey=${TWELVE}`;
  const j = await getJSON(url);
  const data = j?.values;
  if (!Array.isArray(data)) return null;
  // Normalize to { c[], v[] } descending chronological order → reverse to oldest..newest
  const closes = [], vols = [];
  for (let i=data.length-1; i>=0; i--){
    closes.push(Number(data[i].close));
    vols.push(Number(data[i].volume || 0));
  }
  return { c: closes, v: vols };
}

async function getCandles(symbol){
  if (FINNHUB){
    const j = await finnhubCandles(symbol).catch(()=>null);
    if (j) return { c: j.c, v: j.v };
  }
  if (TWELVE){
    const j = await twelveCandles(symbol).catch(()=>null);
    if (j) return j;
  }
  return null;
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
  let i = 0, active = 0;
  return await new Promise((resolve, reject) => {
    const next = () => {
      while (active < limit && i < items.length) {
        const idx = i++;
        active++;
        Promise.resolve(worker(items[idx], idx))
          .then(val => { out[idx] = val; active--; next(); })
          .catch(err => reject(err));
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
  if (!FINNHUB && !TWELVE){
    console.log('[buildPools] No API endpoints configured; skipping generation');
    process.exit(0);
  }

  console.log(`[buildPools] start :: FINNHUB=${!!FINNHUB} TWELVE=${!!TWELVE}`);

  const feedback = await loadJson(FEEDBACK_FILE, { version:1, weights:{}, decay:{ half_life_days:14, last_decay_ts:null }});
  const metricsOut = {};

  for (const market of MARKETS){
    const buckets = pools[market];
    if (!buckets) continue;
    const names = Array.from(new Set([...(buckets.safe||[]), ...(buckets.aggressive||[])].map(x => typeof x==='string'? x : x.name).filter(Boolean)));
    console.log(`[buildPools] market=${market} names=${names.length}`);
    if (names.length === 0) continue;

    // Fetch signals per "symbol" best-effort (names may not be symbols; we compute where possible)
    const byName = {};
    await mapLimit(names, 4, async (name) => {
      console.log(`[buildPools] ${market} :: ${name}`);
      const looksSymbol =
        /^[A-Z.\-]{1,7}(\.[A-Z]{1,3})?$/.test(name) || /^\d{6}\.K[QS]$/.test(name);

      let c=null, v=null; let ret5=null, ret20=null, vol20=null, turnover=null; let news72=0; let earn=false;

      if (looksSymbol) {
        const candles = await getCandles(name).catch(()=>null);
        if (candles) { c = candles.c; v = candles.v; }
        if (c && v) {
          const m = computeMetrics(c,v);
          ret5=m.ret5; ret20=m.ret20; vol20=m.vol20; turnover=m.turnover;
        }
        if (FINNHUB) {
          news72 = await finnhubNewsCount(name).catch(()=>0);
          earn   = await finnhubRecentEarnings(name).catch(()=>false);
        }
      }

      byName[name] = { ret5, ret20, vol20, turnover, news72, earn };
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
      const safe = 0.35*nNews[i] + 0.35*nRet20[i] + 0.20*nRet5[i] + 0.10*(1 - nVol[i]) + earnBonus;
      const aggr = 0.45*nNews[i] + 0.35*nRet5[i]  + 0.20*nTurn[i]                        + earnBonus;
      scoreSafeRaw[n] = clamp01(safe);
      scoreAggrRaw[n] = clamp01(aggr);
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
