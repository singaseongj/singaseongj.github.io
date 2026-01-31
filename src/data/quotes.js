// ESM helper: multi-source quotes with merging & de-duplication.
// Provides: fetchByTickers(tickers, { prefer })
// Sources: Yahoo (no key), Finnhub (token), TwelveData (token)
// Notes:
//  - Purely additive; does not replace existing data paths.
//  - Keep concurrency small to respect provider limits.
//  - Normalizes to a compact shape used by fetchStockInfo's enhanced path.

const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 2);
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || 12000);

function toTicker(s) { return String(s || '').trim().toUpperCase(); }

function normalizeQuote(raw) {
  if (!raw) return null;
  const q = raw.quote || raw;
  const out = {
    symbol: toTicker(q.symbol || q.ticker),
    name: q.longName || q.shortName || q.name || null,
    sector: q.sector || q.industry || null,
    regularMarketPrice: Number(q.regularMarketPrice ?? q.price ?? q.c ?? 0),
    regularMarketPreviousClose: Number(q.regularMarketPreviousClose ?? q.previousClose ?? q.pc ?? 0),
    marketCap: Number(q.marketCap ?? q.market_cap ?? q.mktCap ?? 0),
  };
  return out;
}

function mergeQuotes(list) {
  const by = new Map();
  for (const item of (list || []).filter(Boolean)) {
    const q = normalizeQuote(item);
    if (!q || !q.symbol) continue;
    const ex = by.get(q.symbol) || {};
    by.set(q.symbol, { ...ex, ...q });
  }
  return [...by.values()];
}

function abortableFetch(url, opts = {}, timeoutMs = REQ_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function fetchJSON(url, { retries = 2, timeoutMs = REQ_TIMEOUT_MS, retryOn = s => s === 429 || s >= 500 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await abortableFetch(url, {}, timeoutMs);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status} for ${url}: ${body.slice(0, 160)}`);
        err.status = res.status;
        throw err;
      }
      const ct = res.headers.get('content-type') || '';
      if (/json|javascript/i.test(ct)) return res.json();
      const text = await res.text();
      try { return JSON.parse(text); } catch { throw new Error(`Non-JSON from ${url}`); }
    } catch (e) {
      last = e;
      if (i < retries && retryOn(e.status || 0)) {
        const backoff = Math.pow(2, i) * 300 + Math.random() * 100;
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      break;
    }
  }
  throw last;
}

async function yahooQuotes(tickers) {
  if (!tickers.length) return [];
  const url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' +
              encodeURIComponent(tickers.join(','));
  const json = await fetchJSON(url);
  const items = (json?.quoteResponse?.result) || [];
  return items.map(q => ({ quote: q }));
}

async function finnhubQuotes(tickers) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || !tickers.length) return [];
  const allowKrx = process.env.FINNHUB_ALLOW_KRX === '1';
  const filtered = allowKrx ? tickers : tickers.filter(t => !/\.K[QS]$/i.test(t || ''));
  if (!allowKrx && filtered.length !== tickers.length) {
    console.warn('[finnhub] skipped KRX tickers; set FINNHUB_ALLOW_KRX=1 to include');
  }
  if (!filtered.length) return [];
  const out = [];
  // simple p-map with low concurrency
  let i = 0;
  async function worker() {
    while (i < filtered.length) {
      const t = filtered[i++]; // take next
      try {
        const j = await fetchJSON(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(t)}&token=${key}`);
        out.push({ quote: { symbol: toTicker(t), c: j.c, pc: j.pc } });
      } catch (e) {
        console.warn(`[finnhub] ${t} failed: ${e.message || e}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, tickers.length || 1) }, worker));
  return out;
}

async function twelvedataQuotes(tickers) {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key || !tickers.length) return [];
  const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(tickers.join(','))}&apikey=${key}`;
  const json = await fetchJSON(url);
  const out = [];
  if (Array.isArray(json?.data)) {
    for (const it of json.data) out.push({ quote: { symbol: toTicker(it.symbol), price: Number(it.price) } });
  } else if (json && typeof json === 'object') {
    for (const [sym, val] of Object.entries(json)) {
      if (val && val.price != null) out.push({ quote: { symbol: toTicker(sym), price: Number(val.price) } });
    }
  }
  return out;
}

/**
 * Multi-source fetch with merging & de-duplication.
 * @param {string[]} tickers
 * @param {{prefer?: ('yahoo'|'finnhub'|'twelvedata')[]}} opts
 * @returns {Promise<Array<{symbol:string,name?:string,sector?:string,regularMarketPrice?:number,regularMarketPreviousClose?:number,marketCap?:number}>>}
 */
export async function fetchByTickers(tickers, { prefer = ['yahoo', 'finnhub', 'twelvedata'] } = {}) {
  const unique = [...new Set(tickers.map(toTicker))].filter(Boolean);
  if (!unique.length) return [];
  const results = [];
  for (const src of prefer) {
    try {
      if (src === 'yahoo') results.push(...await yahooQuotes(unique));
      else if (src === 'finnhub') results.push(...await finnhubQuotes(unique));
      else if (src === 'twelvedata') results.push(...await twelvedataQuotes(unique));
    } catch (e) {
      console.warn(`[fetchByTickers] ${src} failed: ${e.message || e}`);
    }
  }
  return mergeQuotes(results);
}

export { toTicker, mergeQuotes, normalizeQuote };
