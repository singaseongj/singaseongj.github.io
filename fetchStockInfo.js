// fetchStockInfo.js — improved version with fallbacks and KOSDAQ stocks
// === ADDITIVE ENHANCEMENT (ESM) ============================================
// Usage:
//   node fetchStockInfo.js --enhanced [--force]
// Behavior:
//   - Reads symbolNames.json to get the universe
//   - If recommendations.json is stale (> RECO_TTL_HOURS), refresh using fetchByTickers
//   - Writes recommendations.json { lastUpdated, items:[{symbol,name,...quoteFields}] }
// Notes:
//   - Does NOT remove or alter your existing logic; this block runs only with --enhanced.
// ==========================================================================
import fs, { writeFile, rename, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'node:path';
import { nowKSTISO } from './utils/time.js';
import { fetchByTickers } from './src/data/quotes.js';
import {
  hasKisCredentials,
  fetchDomesticPriceOnDate,
  fetchDomesticSnapshot,
  fetchOverseasPriceOnDate,
  fetchOverseasPriceDetail,
  expandOverseasSymbolCandidates
} from './utils/kis.js';

async function readJSON(p, fallback=null){
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch { return fallback; }
}
function isFresh(obj, ttlMs){
  const ts = obj?.lastUpdated && Date.parse(obj.lastUpdated);
  return !!ts && (Date.now() - ts < ttlMs);
}

export async function enhancedBuildStockInfo() {
  const names = await readJSON('./symbolNames.json', {});
  const tickers = Object.keys(names || {});
  if (!tickers.length) {
    console.warn('[enhancedStockInfo] No symbols in symbolNames.json — skipping enhanced path');
    return;
  }
  const outFile = './recommendations.json';
  const current = await readJSON(outFile, null);
  const TTL_MS = Number(process.env.RECO_TTL_HOURS || 6) * 3600_000;
  const force = process.argv.includes('--force');
  if (current && isFresh(current, TTL_MS) && !force) {
    console.log('[enhancedStockInfo] cache is fresh; skip');
    return;
  }
  const quotes = await fetchByTickers(tickers);
  const by = Object.fromEntries(quotes.map(q => [q.symbol, q]));
  const items = tickers.map(t => ({
    symbol: t,
    name: names[t] || t,
    ...(by[t] || {})
  }));
  const payload = { lastUpdated: new Date().toISOString(), items };
  await fs.writeFile(outFile, JSON.stringify(payload, null, 2));
  console.log(`[enhancedStockInfo] wrote ${items.length} items`);
}

if (process.argv.includes('--enhanced')) {
  enhancedBuildStockInfo().catch(e => {
    console.error('[enhancedStockInfo] failed:', e?.message || e);
    process.exitCode = 1;
  });
}

const poolsMetricsRaw = JSON.parse(
  await readFile(new URL('./pools-metrics.json', import.meta.url), 'utf8')
);
const newsFeatures = JSON.parse(
  await readFile(new URL('./data/news-features.json', import.meta.url), 'utf8')
);
const naverTrends = JSON.parse(
  await readFile(new URL('./data/naver-trends.json', import.meta.url), 'utf8')
);
let dynamicTickerMap = {};
try {
  dynamicTickerMap = JSON.parse(
    await readFile(new URL('./dynamicTickerMap.json', import.meta.url), 'utf8')
  );
} catch {}

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
const DAY_MS = 24 * 60 * 60 * 1000;
const PRICE_LOOKBACK_DAYS = Number(process.env.PRICE_LOOKBACK_DAYS || 365);
const PRICE_WINDOW_DAYS = Number(process.env.PRICE_WINDOW_DAYS || 10);
const PRICE_HISTORY_CONCURRENCY = Number(process.env.PRICE_HISTORY_CONCURRENCY || 3);
const DEFAULT_OVERSEAS_EXCHANGES = (process.env.KIS_FALLBACK_EXCHANGES || 'NAS,NYS,AMS')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);
const USER_PREFERRED_EXCHANGES = (process.env.KIS_PREFERRED_EXCHANGES || '')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);
const KIS_EXCHANGE_TTL_MS = Number(process.env.KIS_EXCHANGE_TTL_MS || 30 * DAY_MS);
const KIS_DOMESTIC_WINDOW_DAYS = Number(process.env.KIS_DOMESTIC_WINDOW_DAYS || 12);
const KIS_OVERSEAS_WINDOW_DAYS = Number(process.env.KIS_OVERSEAS_WINDOW_DAYS || 20);
const KIS_RECENT_FALLBACK_DAYS = Number(process.env.KIS_RECENT_FALLBACK_DAYS || 3);
const KIS_BUDGET_MS = Number(process.env.KIS_BUDGET_MS || 25000);
const KIS_MAX_ERRORS = Number(process.env.KIS_MAX_ERRORS || 6);
const KIS_OVERSEAS_HINTS = {
  'BRK-B': 'NYS',
  'BRK-A': 'NYS',
  'PLTR': 'NYS',
  'PATH': 'NYS',
  'JNJ': 'NYS',
  'PG': 'NYS',
  'V': 'NYS',
  'KO': 'NYS',
  'NOW': 'NYS',
  'LLY': 'NYS',
  'UBER': 'NYS',
  'NRG': 'NYS',
  'JPM': 'NYS',
  'UNH': 'NYS',
  'SNOW': 'NYS',
  'SHOP': 'NYS'
};

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

function createKisGuard(label = 'KIS') {
  const start = Date.now();
  let errors = 0;
  let aborted = false;
  const budget = Number.isFinite(KIS_BUDGET_MS) ? KIS_BUDGET_MS : 0;
  const maxErrors = Number.isFinite(KIS_MAX_ERRORS) ? KIS_MAX_ERRORS : 0;

  function shouldAbort() {
    if (aborted) return true;
    if (maxErrors > 0 && errors >= maxErrors) {
      aborted = true;
      console.warn(`[${label}] aborting after ${errors} errors`);
      return true;
    }
    if (budget > 0 && Date.now() - start > budget) {
      aborted = true;
      console.warn(`[${label}] aborting after ${Date.now() - start}ms budget`);
      return true;
    }
    return false;
  }

  function recordError() {
    errors += 1;
  }

  return { shouldAbort, recordError };
}

async function fetchHistoricalPriceYahoo(ticker, targetDate) {
  const targetMs = targetDate.getTime();
  const period1 = Math.floor((targetMs - PRICE_WINDOW_DAYS * DAY_MS) / 1000);
  const period2 = Math.floor((targetMs + PRICE_WINDOW_DAYS * DAY_MS) / 1000);
  if (!(Number.isFinite(period1) && Number.isFinite(period2) && period2 > period1)) {
    throw new Error('invalid period for historical price');
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${period1}&period2=${period2}`;
  const res = await fetchWithRetry(url, { headers: HEADERS_JSON });
  const json = await res.json();
  if (json?.chart?.error) {
    throw new Error(json.chart.error?.description || 'yahoo chart error');
  }
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('missing chart result');
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = Array.isArray(result.indicators?.quote?.[0]?.close)
    ? result.indicators.quote[0].close
    : [];
  if (!timestamps.length || !closes.length) throw new Error('empty historical data');
  const targetSec = Math.floor(targetMs / 1000);
  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < timestamps.length; i++) {
    const price = Number(closes[i]);
    if (!Number.isFinite(price)) continue;
    const diff = Math.abs(timestamps[i] - targetSec);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  if (bestIdx === -1) throw new Error('no valid historical price');
  return { price: Number(closes[bestIdx]), timestamp: timestamps[bestIdx] * 1000 };
}

async function fetchHistoricalPricesYahooBatch(tickers, targetDate) {
  const unique = [...new Set((tickers || []).filter(Boolean))];
  if (!unique.length) return {};
  const queue = unique.slice();
  const out = {};
  const workers = Math.min(Math.max(1, PRICE_HISTORY_CONCURRENCY), queue.length);

  async function worker() {
    while (true) {
      const sym = queue.shift();
      if (!sym) break;
      try {
        const hist = await fetchHistoricalPriceYahoo(sym, targetDate);
        if (hist) out[sym] = hist;
      } catch (e) {
        console.warn(`[PRICE] ${sym} 1y lookup failed: ${e.message}`);
      }
      await sleep(150);
    }
  }

  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}

function uniqueValues(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    if (!value) continue;
    const normalized = typeof value === 'string' ? value.toUpperCase() : value;
    const key = typeof normalized === 'string' ? normalized : JSON.stringify(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

const isKrxTicker = ticker => /\.K[QS]$/i.test(ticker || '');
const isLikelyUsTicker = ticker => /^[A-Z0-9.\-]+$/.test(ticker || '') && !isKrxTicker(ticker);

function isRecentDate(targetDate, windowDays) {
  if (!(targetDate instanceof Date) || Number.isNaN(targetDate.getTime())) return false;
  return Math.abs(Date.now() - targetDate.getTime()) <= windowDays * DAY_MS;
}

function pickDomesticSnapshotForDate(snapshot, targetDate) {
  if (!snapshot) return null;
  const targetMs = targetDate.getTime();
  const tradeTs = Number(snapshot.timestamp);
  if (!Number.isFinite(tradeTs)) return null;
  if (Number.isFinite(snapshot.previousClose)) {
    const prevTs = tradeTs - DAY_MS;
    if (Math.abs(prevTs - targetMs) <= DAY_MS * 2) {
      return { price: snapshot.previousClose, timestamp: prevTs };
    }
  }
  if (Number.isFinite(snapshot.current) && Math.abs(tradeTs - targetMs) <= DAY_MS * 2) {
    return { price: snapshot.current, timestamp: tradeTs };
  }
  return null;
}

function pickOverseasDetailForDate(detail, targetDate) {
  if (!detail) return null;
  const targetMs = targetDate.getTime();
  const ts = Number(detail.timestamp);
  if (!Number.isFinite(ts)) return null;
  if (Number.isFinite(detail.previousClose)) {
    const prevTs = ts - DAY_MS;
    if (Math.abs(prevTs - targetMs) <= DAY_MS * 2) {
      return { price: detail.previousClose, timestamp: prevTs };
    }
  }
  if (Number.isFinite(detail.current) && Math.abs(ts - targetMs) <= DAY_MS * 2) {
    return { price: detail.current, timestamp: ts };
  }
  return null;
}

async function fetchHistoricalPricesBatch(tickers, targetDate, cache) {
  const uniqueTickers = [...new Set((tickers || []).filter(Boolean))];
  if (!uniqueTickers.length) return {};
  const out = {};
  const fallback = [];
  const kisEnabled = hasKisCredentials();
  const kisGuard = createKisGuard('KIS:history');
  let cacheDirty = false;
  const cacheRef = cache || {};

  if (kisEnabled) {
    for (let idx = 0; idx < uniqueTickers.length; idx++) {
      const symbol = uniqueTickers[idx];
      if (kisGuard.shouldAbort()) {
        fallback.push(...uniqueTickers.slice(idx));
        break;
      }
      if (isKrxTicker(symbol)) {
        let resolved = false;
        try {
          const res = await fetchDomesticPriceOnDate(symbol, targetDate, { windowDays: KIS_DOMESTIC_WINDOW_DAYS });
          if (res && Number.isFinite(res.price)) {
            out[symbol] = { price: res.price, timestamp: res.timestamp };
            resolved = true;
          }
        } catch (err) {
          console.warn(`[KIS:KR] ${symbol} ${err.message}`);
          noteStatus(err);
          kisGuard.recordError();
        }
        if (!resolved && isRecentDate(targetDate, KIS_RECENT_FALLBACK_DAYS)) {
          try {
            const snap = await fetchDomesticSnapshot(symbol);
            const approx = pickDomesticSnapshotForDate(snap, targetDate);
            if (approx) {
              out[symbol] = approx;
              resolved = true;
            }
          } catch (err) {
            console.warn(`[KIS:KR:snapshot] ${symbol} ${err.message}`);
            noteStatus(err);
            kisGuard.recordError();
          }
        }
        if (!resolved) fallback.push(symbol);
        continue;
      }

      if (isLikelyUsTicker(symbol)) {
        const cachedExchange = cacheGetKisExchange(cacheRef, symbol);
        const hintExchange = KIS_OVERSEAS_HINTS[symbol];
        const exchanges = uniqueValues([
          cachedExchange,
          hintExchange,
          ...USER_PREFERRED_EXCHANGES,
          ...DEFAULT_OVERSEAS_EXCHANGES
        ]);
        if (!exchanges.length) exchanges.push(...DEFAULT_OVERSEAS_EXCHANGES);
        const symbolCandidates = expandOverseasSymbolCandidates(symbol);
        let resolved = false;
        let lastError;
        for (const exchange of exchanges) {
          if (kisGuard.shouldAbort()) break;
          try {
            const res = await fetchOverseasPriceOnDate(symbol, targetDate, {
              exchange,
              symbolCandidates,
              windowDays: KIS_OVERSEAS_WINDOW_DAYS
            });
            if (res && Number.isFinite(res.price)) {
              out[symbol] = { price: res.price, timestamp: res.timestamp };
              if (exchange && exchange !== cachedExchange) {
                cachePutKisExchange(cacheRef, symbol, exchange);
                cacheDirty = true;
              }
              resolved = true;
              break;
            }
          } catch (err) {
            lastError = err;
            noteStatus(err);
            kisGuard.recordError();
          }
        }
        if (!resolved && isRecentDate(targetDate, KIS_RECENT_FALLBACK_DAYS)) {
          for (const exchange of exchanges) {
            if (kisGuard.shouldAbort()) break;
            try {
              const detail = await fetchOverseasPriceDetail(symbol, exchange, { symbolCandidates });
              const approx = pickOverseasDetailForDate(detail, targetDate);
              if (approx) {
                out[symbol] = approx;
                if (exchange && exchange !== cachedExchange) {
                  cachePutKisExchange(cacheRef, symbol, exchange);
                  cacheDirty = true;
                }
                resolved = true;
                break;
              }
            } catch (err) {
              lastError = err;
              noteStatus(err);
              kisGuard.recordError();
            }
          }
        }
        if (!resolved) {
          if (lastError) console.warn(`[KIS:US] ${symbol} ${lastError.message}`);
          fallback.push(symbol);
        }
        continue;
      }

      fallback.push(symbol);
    }
  } else {
    fallback.push(...uniqueTickers);
  }

  if (cacheDirty) {
    try {
      await saveCache(cacheRef);
    } catch (err) {
      console.warn('[CACHE] Failed to persist KIS metadata:', err.message);
    }
  }

  const remaining = uniqueTickers.filter(sym => !out[sym]);
  const fallbackSymbols = uniqueValues([...fallback, ...remaining]);
  if (fallbackSymbols.length) {
    const yahoo = await fetchHistoricalPricesYahooBatch(fallbackSymbols, targetDate);
    Object.assign(out, yahoo);
  }
  return out;
}

function deriveCurrency(ticker) {
  if (/\.K[QS]$/i.test(ticker || '')) return 'KRW';
  return 'USD';
}

async function attachPrices(data, cache) {
  const tickers = new Set();
  for (const market of Object.keys(data || {})) {
    for (const bucket of ['safe', 'aggressive']) {
      const entries = data[market]?.[bucket];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry?.ticker) tickers.add(entry.ticker);
      }
    }
  }
  const list = [...tickers].filter(Boolean);
  if (!list.length) return;

  const now = new Date();
  const cacheRef = cache || {};
  const kisEnabled = hasKisCredentials();
  let cacheDirty = false;
  let quotes = [];
  try {
    quotes = await fetchByTickers(list);
  } catch (e) {
    console.warn('[PRICE] failed to fetch quotes:', e.message || e);
  }
  const priceMap = {};
  for (const q of quotes) {
    if (!q?.symbol) continue;
    const symbol = q.symbol;
    const current = Number.isFinite(q.regularMarketPrice)
      ? Number(q.regularMarketPrice)
      : (Number.isFinite(q.regularMarketPreviousClose) ? Number(q.regularMarketPreviousClose) : null);
    const prevClose = Number.isFinite(q.regularMarketPreviousClose)
      ? Number(q.regularMarketPreviousClose)
      : null;
    priceMap[symbol] = {
      currentPrice: current,
      previousClose: prevClose,
      priceAsOf: now.toISOString(),
      currency: deriveCurrency(symbol)
    };
  }

  if (kisEnabled) {
    const kisGuard = createKisGuard('KIS:realtime');
    for (let idx = 0; idx < list.length; idx++) {
      const symbol = list[idx];
      if (kisGuard.shouldAbort()) {
        console.warn(`[KIS:realtime] skipping ${list.length - idx} remaining symbols`);
        break;
      }
      const existing = priceMap[symbol];
      const baseCurrency = existing?.currency || deriveCurrency(symbol);

      const ensureEntry = () => {
        if (!priceMap[symbol]) {
          priceMap[symbol] = { priceAsOf: now.toISOString(), currency: baseCurrency };
        } else if (!priceMap[symbol].currency) {
          priceMap[symbol].currency = baseCurrency;
        }
      };

      if (isKrxTicker(symbol)) {
        const needsCurrent = !(existing && Number.isFinite(existing.currentPrice));
        const needsPrevious = !(existing && Number.isFinite(existing.previousClose));
        const needsAsOf = !(existing && existing.priceAsOf);
        if (!needsCurrent && !needsPrevious && !needsAsOf) continue;
        let snapshot;
        try {
          snapshot = await fetchDomesticSnapshot(symbol);
        } catch (err) {
          console.warn(`[KIS:KR:quote] ${symbol} ${err.message}`);
          noteStatus(err);
          kisGuard.recordError();
        }

        if (snapshot) {
          const priceAsOf = Number.isFinite(snapshot.timestamp)
            ? new Date(snapshot.timestamp).toISOString()
            : now.toISOString();
          ensureEntry();
          priceMap[symbol].priceAsOf = priceAsOf;
          priceMap[symbol].currency = 'KRW';
          if (Number.isFinite(snapshot.current)) {
            priceMap[symbol].currentPrice = Number(snapshot.current);
          }
          if (Number.isFinite(snapshot.previousClose)) {
            priceMap[symbol].previousClose = Number(snapshot.previousClose);
          }
        }

        const entry = priceMap[symbol];
        const stillNeedsCurrent = !(entry && Number.isFinite(entry.currentPrice));
        const stillNeedsAsOf = !(entry && entry.priceAsOf);
        if (stillNeedsCurrent || stillNeedsAsOf) {
          try {
            const latest = await fetchDomesticPriceOnDate(symbol, now, { windowDays: KIS_DOMESTIC_WINDOW_DAYS });
            if (latest && Number.isFinite(latest.price)) {
              ensureEntry();
              const asOf = Number.isFinite(latest.timestamp)
                ? new Date(latest.timestamp).toISOString()
                : (priceMap[symbol].priceAsOf || now.toISOString());
              priceMap[symbol].priceAsOf = asOf;
              priceMap[symbol].currency = 'KRW';
              if (!Number.isFinite(priceMap[symbol].currentPrice)) {
                priceMap[symbol].currentPrice = Number(latest.price);
              }
            }
          } catch (err) {
            console.warn(`[KIS:KR:recent] ${symbol} ${err.message}`);
            noteStatus(err);
            kisGuard.recordError();
          }
        }
        continue;
      }

      if (!isLikelyUsTicker(symbol)) continue;
      const needsCurrent = !(existing && Number.isFinite(existing.currentPrice));
      const needsPrevious = !(existing && Number.isFinite(existing.previousClose));
      const needsAsOf = !(existing && existing.priceAsOf);
      if (!needsCurrent && !needsPrevious && !needsAsOf) continue;

      const cachedExchange = cacheGetKisExchange(cacheRef, symbol);
      const hintExchange = KIS_OVERSEAS_HINTS[symbol];
      const exchanges = uniqueValues([
        cachedExchange,
        hintExchange,
        ...USER_PREFERRED_EXCHANGES,
        ...DEFAULT_OVERSEAS_EXCHANGES
      ]);
      if (!exchanges.length) exchanges.push(...DEFAULT_OVERSEAS_EXCHANGES);
      const symbolCandidates = expandOverseasSymbolCandidates(symbol);
      let resolved = false;

      for (const exchange of exchanges) {
        if (kisGuard.shouldAbort()) break;
        let detail;
        try {
          detail = await fetchOverseasPriceDetail(symbol, exchange, { symbolCandidates });
        } catch (err) {
          console.warn(`[KIS:US:detail] ${symbol}/${exchange} ${err.message}`);
          noteStatus(err);
          kisGuard.recordError();
        }

        if (detail) {
          const priceAsOf = Number.isFinite(detail.timestamp)
            ? new Date(detail.timestamp).toISOString()
            : now.toISOString();
          ensureEntry();
          priceMap[symbol].priceAsOf = priceAsOf;
          if (!priceMap[symbol].currency) {
            priceMap[symbol].currency = baseCurrency;
          }
          if (Number.isFinite(detail.current)) {
            priceMap[symbol].currentPrice = Number(detail.current);
          }
          if (Number.isFinite(detail.previousClose)) {
            priceMap[symbol].previousClose = Number(detail.previousClose);
          }
        }

        const entry = priceMap[symbol];
        const needsDaily = !entry || !Number.isFinite(entry.currentPrice) || !entry.priceAsOf;
        if (needsDaily) {
          try {
            const latest = await fetchOverseasPriceOnDate(symbol, now, { exchange, symbolCandidates, windowDays: KIS_OVERSEAS_WINDOW_DAYS });
            if (latest && Number.isFinite(latest.price)) {
              ensureEntry();
              const asOf = Number.isFinite(latest.timestamp)
                ? new Date(latest.timestamp).toISOString()
                : (priceMap[symbol].priceAsOf || now.toISOString());
              priceMap[symbol].priceAsOf = asOf;
              if (!Number.isFinite(priceMap[symbol].currentPrice)) {
                priceMap[symbol].currentPrice = Number(latest.price);
              }
            }
          } catch (err) {
            console.warn(`[KIS:US:recent] ${symbol}/${exchange} ${err.message}`);
            noteStatus(err);
            kisGuard.recordError();
          }
        }

        const updated = priceMap[symbol];
        const satisfiedCurrent = !needsCurrent || Number.isFinite(updated?.currentPrice);
        const satisfiedPrevious = !needsPrevious || Number.isFinite(updated?.previousClose);
        const satisfiedAsOf = !needsAsOf || Boolean(updated?.priceAsOf);
        if (satisfiedCurrent && satisfiedPrevious && satisfiedAsOf) {
          if (exchange && exchange !== cachedExchange) {
            cachePutKisExchange(cacheRef, symbol, exchange);
            cacheDirty = true;
          }
          resolved = true;
          break;
        }
      }

      if (!resolved) {
        // leave unresolved symbols untouched so other fallbacks can try later
      }
    }
  }

  const targetDate = new Date(now.getTime() - PRICE_LOOKBACK_DAYS * DAY_MS);
  const historical = await fetchHistoricalPricesBatch(list, targetDate, cache);
  for (const [symbol, info] of Object.entries(historical)) {
    if (!info) continue;
    if (!priceMap[symbol]) {
      priceMap[symbol] = { priceAsOf: now.toISOString(), currency: deriveCurrency(symbol) };
    }
    if (Number.isFinite(info.price)) priceMap[symbol].price1yAgo = Number(info.price);
    if (Number.isFinite(info.timestamp)) priceMap[symbol].price1yDate = new Date(info.timestamp).toISOString();
  }

  for (const market of Object.keys(data || {})) {
    for (const bucket of ['safe', 'aggressive']) {
      const entries = data[market]?.[bucket];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const symbol = entry?.ticker;
        const info = symbol ? priceMap[symbol] : null;
        if (!info) continue;
        if (Number.isFinite(info.currentPrice)) entry.currentPrice = info.currentPrice;
        else if (Number.isFinite(info.previousClose)) entry.currentPrice = info.previousClose;
        if (Number.isFinite(info.price1yAgo)) entry.price1yAgo = info.price1yAgo;
        if (info.price1yDate) entry.price1yDate = info.price1yDate;
        if (info.priceAsOf) entry.priceAsOf = info.priceAsOf;
        if (info.currency) entry.priceCurrency = info.currency;
      }
    }
  }

  if (cacheDirty) {
    try {
      await saveCache(cacheRef);
    } catch (err) {
      console.warn('[CACHE] Failed to persist KIS metadata:', err.message);
    }
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

function metricScoreFor(market, name) {
  const metrics = poolsMetricsRaw?.markets?.[market]?.[name] || poolsMetricsRaw?.[market]?.[name];
  if (typeof metrics?.score === 'number') return metrics.score;
  if (typeof metrics?.score?.total === 'number') return metrics.score.total;
  if (typeof metrics?.score?.safe === 'number') return metrics.score.safe * 100;
  return null;
}

async function writeAtomically(dest, data) {
  const tmp = dest + '.tmp';
  await writeFile(tmp, data);
  await rename(tmp, dest);
}

async function loadJsonSafe(p) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } }
async function isFreshPath(p, ttlMs) { try { const s = await fs.stat(p); return (Date.now() - s.mtimeMs) < ttlMs; } catch { return false; } }

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
  if (POOLS_URL && (REFRESH_POOLS || !(await isFreshPath(POOLS_CACHE, POOLS_TTL_MS)))) {
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
      // Prioritize higher-scoring names, then rotate deterministically within the top window.
      // This avoids selecting too many low-score names when a bucket is large.
      candidates = candidates
        .map((name, idx) => ({ name, idx, score: metricScoreFor(market, name) }))
        .sort((a, b) => {
          const sa = Number.isFinite(a.score) ? a.score : -Infinity;
          const sb = Number.isFinite(b.score) ? b.score : -Infinity;
          if (sb !== sa) return sb - sa;
          return a.idx - b.idx;
        })
        .map(v => v.name);

      const topPoolSize = Math.max(5, Number(process.env.ROTATION_TOP_POOL || 12));
      const topCandidates = candidates.slice(0, topPoolSize);
      const picked = pickDeterministic(topCandidates.length ? topCandidates : candidates, 5, `${seed}:${market}:${bucket}`);
      out[market][bucket] = picked.map(n => {
        const sym = canonSymbol(n);
        const displayName = INDEX_NAME[sym] || n;
        return { name: displayName };
      });
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
const BASE_TICKER_MAP = {
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

const DYNAMIC_TICKER_MAP = Object.fromEntries(
  Object.entries(dynamicTickerMap || {})
    .filter(([name, sym]) => typeof name === 'string' && typeof sym === 'string' && name && sym)
);

const TICKER_MAP = { ...BASE_TICKER_MAP, ...DYNAMIC_TICKER_MAP };

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
  'NFLX': 'Communication Services', 'SMCI': 'Technology', 'AMD': 'Technology', 'PEP': 'Consumer Staples', 'PLTR': 'Technology',
  'ARM': 'Technology',
  'MU': 'Technology', 'PATH': 'Technology', 'CRWD': 'Technology', 'BRK-B': 'Financial Services',
  'JNJ': 'Healthcare', 'PG': 'Consumer Staples', 'V': 'Financial Services', 'KO': 'Consumer Staples',
  'NOW': 'Technology', 'LLY': 'Healthcare', 'UBER': 'Technology', 'NRG': 'Utilities',
  'JPM': 'Financial Services', 'UNH': 'Healthcare', 'MRNA': 'Healthcare', 'ZM': 'Technology',
  'MDB': 'Technology', 'SNOW': 'Technology'
};

// ---------- Index lookups (robust) ----------
let indexes = {};
try {
  indexes = JSON.parse(await readFile(new URL('./src/maps.indexes.json', import.meta.url), 'utf8'));
} catch {}

const GICS_SECTORS = new Set([
  'Communication Services','Consumer Discretionary','Consumer Staples','Energy',
  'Financials','Health Care','Healthcare','Industrials','Information Technology','Technology',
  'Materials','Real Estate','Utilities'
].map(s => s.toUpperCase()));

const SECTOR_NORMALIZE = {
  'Information Technology': 'Technology',
  'Health Care': 'Healthcare',
  'Healthcare': 'Healthcare',
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

// Treat both slash and dash variants as the same symbol
function canonSymbol(s) {
  if (!s) return s;
  return String(s).toUpperCase().replace('/', '.').replace('-', '.');
}
function looksLikeTickerShape(x) {
  return /^[A-Z]{1,5}(\.[A-Z]{1,3})?$/.test(x || '') || /^\d{6}\.K[QS]$/.test(x || '');
}
const looksLikeTicker = s => looksLikeTickerShape(canonSymbol(s || ''));

// Gather candidate rows from all supported lists if present
const rawRows = [
  ...(indexes.sp500 || []),
  ...(indexes.nasdaq100 || []),
  ...(indexes.kospi200 || []),
  ...(indexes.kosdaq100 || []),
];

// Build robust maps from index data that may have swapped fields
const INDEX_NAME = {};   // ticker -> company name
const INDEX_SECTOR = {}; // ticker -> normalized sector

for (const r of rawRows) {
  // Pull and canonicalize
  const s1 = canonSymbol(r.symbol);
  const s2 = canonSymbol(r.name);

  const s1IsTicker = looksLikeTicker(s1);
  const s2IsTicker = looksLikeTicker(s2);

  // Determine ticker
  let ticker = null;
  if (s1IsTicker && !s2IsTicker) ticker = s1;
  else if (!s1IsTicker && s2IsTicker) ticker = s2;
  else if (s1IsTicker && s2IsTicker) {
    // Both look like tickers: pick s1 by default; if static sector knows s2 but not s1, prefer s2
    ticker = s1;
    if (STATIC_SECTORS?.[s2] && !STATIC_SECTORS?.[s1]) ticker = s2;
  } else {
    // Neither clearly ticker → skip; we can’t trust this row
    continue;
  }

  // Determine company name: pick the non-ticker field; if both tickers, try r.sector if it looks like a name
  let company = null;
  if (s1IsTicker && !s2IsTicker) company = r.name?.toString().trim();
  else if (!s1IsTicker && s2IsTicker) company = r.symbol?.toString().trim();
  else if (s1IsTicker && s2IsTicker) {
    const maybeName = (r.sector || '').toString().trim();
    if (maybeName && !GICS_SECTORS.has(maybeName.toUpperCase())) company = maybeName;
  }

  // Determine sector – accept known English sectors or any Korean text
  let sector = r.sector;
  if (sector && typeof sector === 'string') {
    sector = sector.trim();
    const upper = sector.toUpperCase();
    const isKorean = /[\u3131-\uD79D]/.test(sector);
    if (GICS_SECTORS.has(upper)) {
      sector = SECTOR_NORMALIZE[sector] || sector;
    } else if (!isKorean) {
      sector = null;
    }
  } else {
    sector = null;
  }

  if (company && !looksLikeTicker(company) && !GICS_SECTORS.has(company.toUpperCase())) INDEX_NAME[ticker] = company;
  if (sector) INDEX_SECTOR[ticker] = sector;
}

const INDEX_SYMBOL_SET = new Set([...new Set([...Object.keys(INDEX_NAME), ...Object.keys(INDEX_SECTOR)])]);

// Merge your hard-coded TICKER_MAP with index map names so both directions exist.
const STATIC_MAP = (() => {
  const merged = { ...TICKER_MAP };
  for (const [sym, nm] of Object.entries(INDEX_NAME)) {
    if (nm) merged[nm] = sym;
  }
  const out = {};
  for (const [k, v] of Object.entries(merged)) out[normalizeKey(k)] = v;
  return out;
})();


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

function cacheGetKisExchange(cache, symbol) {
  const entry = cache?._kisExchanges?.[symbol];
  if (!entry) return undefined;
  if (Date.now() - entry.ts > KIS_EXCHANGE_TTL_MS) return undefined;
  return entry.value;
}

function cachePutKisExchange(cache, symbol, exchange) {
  if (!exchange) return;
  cache._kisExchanges = cache._kisExchanges || {};
  cache._kisExchanges[symbol] = { value: exchange.toUpperCase(), ts: Date.now() };
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

const buildGoogleSERP = q =>
  `https://www.google.com/search?q=${encodeURIComponent(q)}`;


function makeSearchQuery(name) {
  // Company name only (no ticker / sector)
  return String(name || '').trim();
}

async function fetchSearchUrl(name, cache) {
  // 1) cache
  const cached = cacheGetSearchUrl(cache, name);
  if (cached !== undefined) return cached;

  const query = makeSearchQuery(name);
  // Always use plain Google web search with just the company name
  const url = buildGoogleSERP(query);

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

async function resolveTicker(name, cache) {
  const raw = String(name);
  const nk = normalizeKey(raw);

  // 1) If it's literally a KR/US ticker we already know from index or static, pass through (canon form).
  const maybeTicker = canonSymbol(raw);
  const isTickerShape = looksLikeTickerShape(maybeTicker);
  if (isTickerShape) {
    if (STATIC_MAP[nk]) return canonSymbol(STATIC_MAP[nk]);
    if (TICKER_MAP[raw]) return canonSymbol(TICKER_MAP[raw]);
    if (TICKER_MAP[nk]) return canonSymbol(TICKER_MAP[nk]);
    if (INDEX_SYMBOL_SET.has(maybeTicker) || STATIC_SECTORS[maybeTicker]) return maybeTicker;
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
  const data = {};
  const log = {};

  // Select stocks for each market
  for (const [market, buckets] of Object.entries(POOLS)) {
    if (!hasAnyCandidates(buckets)) continue;
    data[market] = {};
    const safeSource = buckets.safe || [];
    const chosenSafe = safeSource.slice(0, 5);
    data[market].safe = chosenSafe.map(n => (typeof n === 'string' ? { name: n } : n));

    const safeNames = new Set(chosenSafe.map(n => (typeof n === 'string' ? n : n.name)));
    let aggrSource = (buckets.aggressive || []).filter(n => !safeNames.has(typeof n === 'string' ? n : n.name));
    const chosenAggr = aggrSource.slice(0, 5);
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
        const rawName = typeof entry === 'string' ? entry : entry.name;

        try {
          const sym = canonSymbol(rawName);
          let ticker = null;
          let sector = null;
          let displayName = rawName;

          if (INDEX_NAME[sym] || INDEX_SECTOR[sym]) {
            ticker = sym;
            displayName = INDEX_NAME[sym] || rawName;
            sector = INDEX_SECTOR[sym] || null;
          } else {
            const res = await fetchSector(rawName, cache);
            ticker = res.ticker;
            sector = INDEX_SECTOR[ticker] || res.sector;
            displayName = INDEX_NAME[ticker] || (!looksLikeTicker(rawName) ? rawName : undefined) || rawName;
          }

          let searchUrl = null;
          try {
            searchUrl = await fetchSearchUrl(displayName, cache);
          } catch (e) {
            console.warn(`[SEARCH_URL_FAIL] ${rawName}: ${e.message}`);
          }

          const news = ticker ? (newsFeatures[ticker] || {}) : {};
          const trend = ticker ? (naverTrends[ticker] || {}) : {};
          const metrics = poolsMetricsRaw.markets?.[market]?.[rawName] || poolsMetricsRaw[market]?.[rawName];
          let baseScore = null;
          if (typeof metrics?.score === 'number') baseScore = Math.round(metrics.score);
          else if (typeof metrics?.score?.total === 'number') baseScore = Math.round(metrics.score.total);
          else if (typeof metrics?.score?.safe === 'number') baseScore = Math.round(metrics.score.safe * 100);
          if (baseScore == null) baseScore = 50;

          const reputationScore = metrics?.reputationScore ?? news.reputationScore ?? null;
          const topKeywords = (metrics?.topKeywords && metrics.topKeywords.length)
            ? metrics.topKeywords
            : (news.topKeywords || []);
          const sentiment = Number.isFinite(metrics?.sentiment)
            ? +metrics.sentiment.toFixed(2)
            : (Number.isFinite(news.sentiment) ? +news.sentiment.toFixed(2) : 0);
          const blog = Number.isFinite(metrics?.blogScore)
            ? +metrics.blogScore.toFixed(2)
            : (Number.isFinite(metrics?.blogMentions)
                ? +metrics.blogMentions.toFixed(2)
                : (Number.isFinite(news.blogMentions) ? news.blogMentions|0 : 0));
          const naver = Number.isFinite(metrics?.naverScore)
            ? +metrics.naverScore.toFixed(2)
            : (Number.isFinite(metrics?.naverPopularity)
                ? +metrics.naverPopularity.toFixed(2)
                : (Number.isFinite(trend.naverPopularity) ? +trend.naverPopularity.toFixed(2) : 0));

          updated.push({
            name: displayName,
            sector,
            ticker,
            searchUrl,
            score: baseScore,
            reasons: {
              reputationScore,
              topKeywords,
              signals: {
                sentiment,
                blog,
                naver
              }
            }
          });

          if (sector) successCount++;
        } catch (err) {
          console.error(`[ERROR] ${rawName}: ${err.message}`);
          const metrics = poolsMetricsRaw.markets?.[market]?.[rawName] || poolsMetricsRaw[market]?.[rawName];
          let baseScore = null;
          if (typeof metrics?.score === 'number') baseScore = Math.round(metrics.score);
          else if (typeof metrics?.score?.total === 'number') baseScore = Math.round(metrics.score.total);
          else if (typeof metrics?.score?.safe === 'number') baseScore = Math.round(metrics.score.safe * 100);
          if (baseScore == null) baseScore = 50;
          const sentiment = Number.isFinite(metrics?.sentiment) ? +metrics.sentiment.toFixed(2) : 0;
          const blog = Number.isFinite(metrics?.blogScore)
            ? +metrics.blogScore.toFixed(2)
            : (Number.isFinite(metrics?.blogMentions) ? +metrics.blogMentions.toFixed(2) : 0);
          const naver = Number.isFinite(metrics?.naverScore)
            ? +metrics.naverScore.toFixed(2)
            : (Number.isFinite(metrics?.naverPopularity) ? +metrics.naverPopularity.toFixed(2) : 0);
          updated.push({ name: rawName, sector: null, ticker: null, searchUrl: null, score: baseScore, reasons: { reputationScore: null, topKeywords: [], signals: { sentiment, blog, naver } } });
          noteStatus(err);
        }

        if (consecutive429 >= 5) {
          throw new Error('Too many consecutive 429s, aborting');
        }
      }

      // Adaptive delay based on consecutive 429s
      const delay = consecutive429 >= 3 ? nextDelay() * 2 : nextDelay();
      await sleep(delay);

      data[market][group] = updated;
    }
  }

  try {
    await attachPrices(data, cache);
  } catch (e) {
    console.warn('[PRICE] Failed to enrich price data:', e?.message || e);
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
          const metrics = poolsMetricsRaw.markets?.[market]?.[entry.name] || poolsMetricsRaw[market]?.[entry.name];
          if (metrics) {
            if (typeof metrics.score === 'number') entry.score = Math.round(metrics.score);
            else if (typeof metrics.score?.total === 'number') entry.score = Math.round(metrics.score.total);
            else if (typeof metrics.score?.safe === 'number') entry.score = Math.round(metrics.score.safe * 100);
          }
          if (entry.score == null) entry.score = 50;
        }
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

/* === ADDITIVE: enhanced multi-source update path (keeps your existing logic intact) === */
if (import.meta.url === `file://${process.argv[1]}` && process.env.ENHANCED_STOCKINFO !== '0') {
  (async () => {
    try {
      const { readJSON, writeJSONAtomic, isFresh } = await import('./utils/cache.js');
      const { fetchByTickers } = await import('./src/data/quotes.js');
      const symMap = await readJSON('./symbolNames.json', {});
      const tickers = Object.keys(symMap || {});
      if (!tickers.length) {
        console.warn('[fetchStockInfo] No symbols found in symbolNames.json — skipping enhanced path');
        return;
      }
      const outFile = './recommendations.json';
      const current = await readJSON(outFile, null);
      const TTL_MS = Number(process.env.RECO_TTL_HOURS || 6) * 3600_000;
      const force = process.argv.includes('--force');
      if (current && isFresh(current, TTL_MS) && !force) {
        console.log('[fetchStockInfo] cache is fresh; skip (enhanced)');
        return;
      }
      const quotes = await fetchByTickers(tickers);
      const bySymbol = Object.fromEntries(quotes.map(q => [q.symbol, q]));
      const items = tickers.map(t => ({ symbol: t, name: symMap[t], ...(bySymbol[t] || {}) }));
      const payload = { lastUpdated: new Date().toISOString(), items };
      await writeJSONAtomic(outFile, payload);
      console.log(`[fetchStockInfo] wrote ${items.length} items (enhanced)`);
    } catch (e) {
      console.error('[fetchStockInfo] enhanced path failed:', e.message || e);
    }
  })();
}
