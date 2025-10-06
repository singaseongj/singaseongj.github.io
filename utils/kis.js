const BASE_URL = (process.env.KIS_BASE_URL || 'https://openapi.koreainvestment.com:9443').replace(/\/$/, '');
const APP_KEY = process.env.KIS_APP_KEY || '';
const APP_SECRET = process.env.KIS_APP_SECRET || '';
const CUST_TYPE = process.env.KIS_CUST_TYPE || 'P';
const HTTP_TIMEOUT_MS = Number(process.env.KIS_TIMEOUT_MS || 12000);
const DOMESTIC_TR_DAILY = process.env.KIS_TR_DAILY || 'FHKST03010100';
const DOMESTIC_TR_SNAPSHOT = process.env.KIS_TR_SNAPSHOT || 'FHKST01010100';
const OVERSEAS_TR_DAILY = process.env.KIS_TR_OVERSEAS_DAILY || 'HHDFS76240000';
const OVERSEAS_TR_DETAIL = process.env.KIS_TR_OVERSEAS_DETAIL || 'HHDFS76200200';
const DEFAULT_AUTH = process.env.KIS_AUTH || '';

const fmtYmdKst = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

const tokenCache = {
  value: null,
  expiry: 0
};

export function hasKisCredentials() {
  return Boolean(APP_KEY && APP_SECRET);
}

function toYmdKst(date) {
  return fmtYmdKst.format(date).replace(/-/g, '');
}

function shiftDays(date, offset) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
}

function parseYmd(ymd) {
  if (!/^[0-9]{8}$/.test(ymd || '')) return null;
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

function parseTokenExpiry(json) {
  if (!json) return 0;
  if (json.expires_in) {
    const ms = Number(json.expires_in) * 1000;
    if (Number.isFinite(ms)) return Date.now() + ms;
  }
  const raw = json.access_token_token_expired || json.token_expire_dt;
  if (typeof raw === 'string' && raw.trim()) {
    const normalized = raw.trim().replace(' ', 'T');
    const parsed = Date.parse(/Z$/.test(normalized) ? normalized : `${normalized}+09:00`);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now() + 24 * 60 * 60 * 1000;
}

async function getAccessToken(force = false) {
  if (!hasKisCredentials()) {
    throw new Error('KIS_APP_KEY and KIS_APP_SECRET are required');
  }
  if (!force && tokenCache.value && Date.now() < tokenCache.expiry - 60_000) {
    return tokenCache.value;
  }
  const url = `${BASE_URL}/oauth2/tokenP`;
  const body = JSON.stringify({
    grant_type: 'client_credentials',
    appkey: APP_KEY,
    appsecret: APP_SECRET
  });
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Failed to parse KIS token response: ${text?.slice?.(0, 120) || ''}`);
  }
  if (!res.ok) {
    const msg = json?.msg || json?.error_description || text;
    throw new Error(`KIS token HTTP ${res.status}: ${msg}`);
  }
  const token = json.access_token;
  if (!token) {
    throw new Error('KIS token response missing access_token');
  }
  tokenCache.value = token;
  tokenCache.expiry = parseTokenExpiry(json);
  return token;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error('timeout'));
  }, HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildUrl(path, params) {
  const url = path.startsWith('http') ? new URL(path) : new URL(path, `${BASE_URL}/`);
  if (params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.append(key, String(value));
    }
  }
  return url;
}

async function kisFetch(path, { method = 'GET', params = null, body = null, trId, headers = {} } = {}) {
  if (!trId) throw new Error('KIS request requires trId');
  const token = await getAccessToken();
  const url = buildUrl(path, method === 'GET' ? params : null);
  const reqInit = {
    method,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
      appkey: APP_KEY,
      appsecret: APP_SECRET,
      tr_id: trId,
      custtype: CUST_TYPE,
      ...headers
    }
  };
  if (method !== 'GET') {
    const payload = body ?? params;
    if (payload && Object.keys(payload).length > 0) {
      reqInit.body = JSON.stringify(payload);
    }
  }
  const res = await fetchWithTimeout(url.toString(), reqInit);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`KIS returned non-JSON response for ${path}: ${text?.slice?.(0, 160) || ''}`);
  }
  if (!res.ok) {
    const msg = json?.msg1 || json?.msg || json?.error_description || text;
    throw new Error(`KIS HTTP ${res.status}: ${msg}`);
  }
  if (json?.rt_cd && String(json.rt_cd) !== '0') {
    const msg = json?.msg1 || json?.msg || json?.msg_cd || json?.rt_msg || 'unknown error';
    const code = json?.msg_cd || json?.rt_cd;
    throw new Error(`KIS error ${code}: ${msg}`);
  }
  return json;
}

function pickClosest(rows, targetMs, mapDate, mapPrice) {
  let best = null;
  let bestDiff = Infinity;
  for (const row of rows) {
    const date = mapDate(row);
    const price = mapPrice(row);
    if (!Number.isFinite(date) || !Number.isFinite(price)) continue;
    const diff = Math.abs(date - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = { price, timestamp: date, row };
    }
  }
  return best;
}

export async function fetchDomesticPriceOnDate(ticker, targetDate, { windowDays = 10 } = {}) {
  const match = /^([0-9]{6})\.K[QS]$/i.exec(ticker || '');
  if (!match) throw new Error('Ticker is not a recognized KRX symbol');
  const code = match[1];
  const start = toYmdKst(shiftDays(targetDate, -windowDays));
  const end = toYmdKst(shiftDays(targetDate, windowDays));
  const json = await kisFetch('/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', {
    trId: DOMESTIC_TR_DAILY,
    params: {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: start,
      FID_INPUT_DATE_2: end,
      FID_PERIOD_DIV_CODE: 'D',
      FID_ORG_ADJ_PRC: '1'
    }
  });
  const rows = Array.isArray(json?.output2) ? json.output2 : [];
  if (!rows.length) {
    throw new Error('No historical rows returned');
  }
  const targetMs = targetDate.getTime();
  const result = pickClosest(
    rows,
    targetMs,
    row => {
      const date = parseYmd(row?.stck_bsop_date || row?.bsop_date);
      return date ? date.getTime() : NaN;
    },
    row => Number(row?.stck_clpr ?? row?.clpr)
  );
  if (!result) throw new Error('Unable to locate matching domestic price');
  return result;
}

export async function fetchDomesticSnapshot(ticker) {
  const match = /^([0-9]{6})\.K[QS]$/i.exec(ticker || '');
  if (!match) throw new Error('Ticker is not a recognized KRX symbol');
  const code = match[1];
  const json = await kisFetch('/uapi/domestic-stock/v1/quotations/inquire-price', {
    trId: DOMESTIC_TR_SNAPSHOT,
    params: {
      fid_cond_mrkt_div_code: 'J',
      fid_input_iscd: code
    }
  });
  const row = json?.output || {};
  const tradeDate = parseYmd(row?.stck_bsop_date);
  return {
    current: Number(row?.stck_prpr),
    previousClose: Number(row?.stck_prdy_clpr),
    timestamp: tradeDate ? tradeDate.getTime() : Date.now(),
    raw: row
  };
}

function dedupe(values) {
  const out = [];
  const seen = new Set();
  for (const v of values || []) {
    if (!v) continue;
    const key = typeof v === 'string' ? v : JSON.stringify(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function expandSymbolVariants(symbol) {
  const base = String(symbol || '').trim();
  if (!base) return [];
  const upper = base.toUpperCase();
  const variants = new Set([upper]);
  if (upper.includes('-')) {
    variants.add(upper.replace(/-/g, ''));
    variants.add(upper.replace(/-/g, '.'));
    variants.add(upper.replace(/-/g, ' '));
    variants.add(upper.replace(/-/g, '/'));
  }
  if (upper.includes('.')) {
    variants.add(upper.replace(/\./g, ''));
    variants.add(upper.replace(/\./g, '-'));
    variants.add(upper.replace(/\./g, ' '));
    variants.add(upper.replace(/\./g, '/'));
  }
  return [...variants].filter(Boolean);
}

export function expandOverseasSymbolCandidates(symbol) {
  return dedupe(expandSymbolVariants(symbol));
}

async function requestOverseasDaily(symbol, exchange, targetDate, { windowDays = 20 } = {}) {
  const base = toYmdKst(shiftDays(targetDate, windowDays));
  const json = await kisFetch('/uapi/overseas-price/v1/quotations/dailyprice', {
    trId: OVERSEAS_TR_DAILY,
    params: {
      AUTH: DEFAULT_AUTH,
      EXCD: exchange,
      SYMB: symbol,
      GUBN: '0',
      BYMD: base,
      MODP: '1'
    }
  });
  const lists = [];
  if (Array.isArray(json?.output1)) lists.push(...json.output1);
  else if (json?.output1) lists.push(json.output1);
  if (Array.isArray(json?.output2)) lists.push(...json.output2);
  const rows = lists.filter(Boolean);
  if (!rows.length) throw new Error('No overseas rows returned');
  const targetMs = targetDate.getTime();
  const result = pickClosest(
    rows,
    targetMs,
    row => {
      const date = parseYmd(row?.xymd || row?.trd_dd || row?.bymd);
      return date ? date.getTime() : NaN;
    },
    row => Number(row?.clos ?? row?.stck_clpr ?? row?.close)
  );
  if (!result) throw new Error('Unable to locate overseas price');
  return result;
}

export async function fetchOverseasPriceOnDate(symbol, targetDate, { exchange, symbolCandidates = [], windowDays = 20 } = {}) {
  if (!exchange) throw new Error('Exchange code is required for overseas price');
  const candidates = dedupe(symbolCandidates.length ? symbolCandidates : expandSymbolVariants(symbol));
  if (!candidates.length) candidates.push(String(symbol || '').toUpperCase());
  let lastErr;
  for (const sym of candidates) {
    try {
      const result = await requestOverseasDaily(sym, exchange, targetDate, { windowDays });
      return { ...result, symbol: sym, exchange };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Unable to fetch overseas price');
}

export async function fetchOverseasPriceDetail(symbol, exchange, { symbolCandidates = [] } = {}) {
  if (!exchange) throw new Error('Exchange code is required for overseas price detail');
  const candidates = dedupe(symbolCandidates.length ? symbolCandidates : expandSymbolVariants(symbol));
  if (!candidates.length) candidates.push(String(symbol || '').toUpperCase());
  let lastErr;
  for (const sym of candidates) {
    try {
      const json = await kisFetch('/uapi/overseas-price/v1/quotations/price-detail', {
        trId: OVERSEAS_TR_DETAIL,
        params: {
          AUTH: DEFAULT_AUTH,
          EXCD: exchange,
          SYMB: sym
        }
      });
      const row = Array.isArray(json?.output) ? json.output[0] : json?.output;
      if (!row) throw new Error('No detail payload');
      const current = Number(row?.last);
      const prev = Number(row?.base);
      const ymd = parseYmd(row?.xymd || row?.h52d);
      return {
        current,
        previousClose: prev,
        timestamp: ymd ? ymd.getTime() : Date.now(),
        exchange,
        symbol: sym,
        raw: row
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Unable to fetch overseas price detail');
}

export const __private = {
  toYmdKst,
  shiftDays,
  parseYmd,
  requestOverseasDaily
};
