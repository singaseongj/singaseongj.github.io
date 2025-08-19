import fs from 'fs/promises';
import path from 'path';

const FINNHUB = process.env.FINNHUB_API_KEY || '';
const TWELVE = process.env.TWELVEDATA_API_KEY || '';
const FMP = process.env.FMP_KEY || '';

const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || 8000);
const CIRCUIT_MAX_ERRORS = Number(process.env.CIRCUIT_MAX_ERRORS || 8);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 3600000);
const COOLOFF_MS = Number(process.env.COOLOFF_MS || 60000);

const CACHE_DIR = path.join('data','cache','candles');

const state = {
  finnhub:    { errors: 0, coolUntil: 0, count: 0, ok: 0, err: 0, '429': 0 },
  twelvedata: { errors: 0, coolUntil: 0, count: 0, ok: 0, err: 0, '429': 0 },
  fmp:        { errors: 0, coolUntil: 0, count: 0, ok: 0, err: 0, '429': 0 },
};

function toTwelveSymbol(sym){
  const m = String(sym).match(/^(\d{6})\.(K[QS])$/);
  return m ? `${m[1]}:${m[2]}` : sym;
}

async function writeAtomic(file, data){
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

async function withCache(provider, symbol, ttl, fetcher){
  const file = path.join(CACHE_DIR, provider, `${symbol}.json`);
  try {
    const stat = await fs.stat(file);
    const age = Date.now() - stat.mtimeMs;
    const txt = await fs.readFile(file, 'utf8');
    const data = JSON.parse(txt);
    if (age < ttl) return data;
    fetcher()
      .then(res => writeAtomic(file, JSON.stringify(res)))
      .catch(e => {
        if (process.env.DEBUG_CACHE) console.warn('[cache] refresh failed:', e.message);
      });
    return data;
  } catch {
    const data = await fetcher();
    if (data) await writeAtomic(file, JSON.stringify(data));
    return data;
  }
}

async function fetchJSON(url, { timeout=REQ_TIMEOUT_MS, retries=2 }={}){
  let lastErr;
  for (let i=0;i<=retries;i++){
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), timeout);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok){
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch(e){
      clearTimeout(timer);
      lastErr = e;
      if (i < retries){
        const backoff = Math.pow(2,i)*200 + Math.random()*200;
        await new Promise(r=>setTimeout(r, backoff));
        continue;
      }
    }
  }
  throw lastErr;
}

async function finnhubCandles(symbol){
  const to = Math.floor(Date.now()/1000);
  const from = to - 60*60*24*40;
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${FINNHUB}`;
  const j = await fetchJSON(url);
  if (j?.s !== 'ok') throw new Error('bad finnhub response');
  return { c: j.c, v: j.v };
}

async function twelveCandles(symbol){
  const tsym = toTwelveSymbol(symbol);
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tsym)}&interval=1day&outputsize=40&apikey=${TWELVE}`;
  const j = await fetchJSON(url);
  const data = j?.values;
  if (!Array.isArray(data)) throw new Error('bad twelve data');
  const c=[],v=[];
  for (let i=data.length-1;i>=0;i--){
    c.push(Number(data[i].close));
    v.push(Number(data[i].volume||0));
  }
  return { c, v };
}

async function fmpCandles(symbol){
  const priceUrl = `https://financialmodelingprep.com/api/v3/historical-price-full/${encodeURIComponent(symbol)}?serietype=line&timeseries=40&apikey=${FMP}`;
  const price = await fetchJSON(priceUrl);
  const hist = price?.historical;
  if (!Array.isArray(hist) || hist.length===0) throw new Error('bad fmp');
  const close = hist.slice(0,40).map(d=>Number(d.close)).reverse();
  const volUrl = `https://financialmodelingprep.com/api/v3/historical-price-full/${encodeURIComponent(symbol)}?timeseries=40&apikey=${FMP}`;
  const vol = await fetchJSON(volUrl);
  const volHist = vol?.historical || [];
  const volumes = volHist.slice(0,40).map(d=>Number(d.volume||0)).reverse();
  return { c: close, v: volumes };
}

const adapters = { finnhub: finnhubCandles, twelvedata: twelveCandles, fmp: fmpCandles };

function hasKey(provider){
  if (provider === 'finnhub') return !!FINNHUB;
  if (provider === 'twelvedata') return !!TWELVE;
  if (provider === 'fmp') return !!FMP;
  return false;
}

export async function getCandles(symbol, opts={}){
  const isKR = /\.K[QS]$/.test(symbol);
  const order = isKR ? ['twelvedata','fmp'] : ['finnhub','twelvedata','fmp'];
  const attempts = [];
  const ttl = Number(opts.cacheTtlMs || CACHE_TTL_MS);
  const maxPer = Number.isFinite(opts.maxPerProvider) ? opts.maxPerProvider : Infinity;
  const cooloffMs = Number(opts.cooloffMs || COOLOFF_MS);
  for (const p of order){
    if (!hasKey(p)) continue;
    const s = state[p];
    if (Date.now() < s.coolUntil) continue;
    if (s.count >= maxPer) continue;
    attempts.push(p);
    try {
      const start = Date.now();
      const data = await withCache(p, symbol, ttl, ()=>adapters[p](symbol));
      s.count++;
      s.ok++;
      return { ...data, source: p, attempts, fetchMs: Date.now()-start };
    } catch(e){
      s.errors++;
      s.err++;
      if (e.status===429){ s['429']++; }
      if (e.status===429 || e.status===403 || s.errors >= CIRCUIT_MAX_ERRORS){
        s.coolUntil = Date.now() + cooloffMs;
        s.errors = 0;
      }
      continue;
    }
  }
  return null;
}

export const providerState = state;
