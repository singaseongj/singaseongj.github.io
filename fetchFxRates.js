import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setDefaultResultOrder } from 'node:dns';
import { nowKSTISO } from './utils/time.js';

try { setDefaultResultOrder('ipv4first'); } catch {}

const execFileAsync = promisify(execFile);

// Write under /stocks/fx_rates/ (dashboard + ticker will read from here)
const OUT_DIR = path.resolve(process.cwd(), 'stocks', 'fx_rates');
const OUT = path.join(OUT_DIR, 'fx_rates.json');
const HISTORY_PREFIX = 'fx_history';
const HISTORY_MANIFEST = path.join(OUT_DIR, `${HISTORY_PREFIX}_manifest.json`);
const LEGACY_HISTORY = path.join(OUT_DIR, 'fx_history.json');

const SERIES_KEYS = ['USD', 'JPY100', 'EUR', 'CNY', 'GBP', 'HKD', 'GOLD', 'BTC'];
const TROY_OUNCE_TO_GRAM = 31.1034768;

const blankSeries = () => Object.fromEntries(SERIES_KEYS.map(key => [key, []]));
const historyFileForYear = (year) => path.join(OUT_DIR, `${HISTORY_PREFIX}${year}.json`);

function normalizeHistoryFilename(value) {
  if (typeof value !== 'string') return null;
  let name = value.trim();
  if (!name) return null;
  const queryIndex = name.search(/[?#]/);
  if (queryIndex !== -1) {
    name = name.slice(0, queryIndex);
  }
  name = name.replace(/^(\.{1,2}\/)+/, '');
  name = name.replace(/^\/+/, '');
  if (name.startsWith('stocks/fx_rates/')) {
    name = name.slice('stocks/fx_rates/'.length);
  }
  if (name.startsWith(`${HISTORY_PREFIX}_manifest`)) return null;
  if (!name.endsWith('.json')) {
    name = `${name}.json`;
  }
  return name || null;
}

function extractYearFromFilename(name) {
  if (typeof name !== 'string') return null;
  const match = name.match(/(\d{4})/);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isFinite(year) ? Math.trunc(year) : null;
}

function sanitizeYears(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const years = [];
  for (const value of values) {
    const num = Number(value);
    if (!Number.isFinite(num)) continue;
    const year = Math.trunc(num);
    if (year < 1900 || year > 9999) continue;
    if (seen.has(year)) continue;
    seen.add(year);
    years.push(year);
  }
  years.sort((a, b) => a - b);
  return years;
}

function sanitizeManifestFiles(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const files = [];
  for (const raw of list) {
    const normalized = normalizeHistoryFilename(typeof raw === 'string' ? raw : String(raw ?? ''));
    if (!normalized) continue;
    const year = extractYearFromFilename(normalized);
    if (!Number.isFinite(year)) continue;
    const fileName = normalized.startsWith(HISTORY_PREFIX)
      ? normalized
      : `${HISTORY_PREFIX}${year}.json`;
    if (seen.has(fileName)) continue;
    seen.add(fileName);
    files.push(fileName);
  }
  return files;
}

const FR_USD = 'https://api.frankfurter.app/latest?from=USD&to=KRW,EUR,GBP,CNY,HKD';
const FR_JPY = 'https://api.frankfurter.app/latest?from=JPY&to=KRW';

const EH_USD = 'https://api.exchangerate.host/latest?base=USD&symbols=KRW,EUR,GBP,CNY,HKD';
const EH_JPY = 'https://api.exchangerate.host/latest?base=JPY&symbols=KRW';

const NAVER_LIST = 'https://finance.naver.com/marketindex/exchangeList.naver';

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

function shouldUseFallback(err) {
  if (!err) return false;
  const codes = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN']);
  const cause = err.cause;
  if (cause && typeof cause === 'object') {
    if (typeof cause.code === 'string' && codes.has(cause.code)) return true;
    if (Array.isArray(cause.errors) && cause.errors.some(e => typeof e?.code === 'string' && codes.has(e.code))) {
      return true;
    }
  }
  return false;
}

async function requestWithCurl(urlStr, { headers = {}, timeoutMs = 10000 } = {}) {
  const maxTime = Math.max(1, Math.ceil(timeoutMs / 1000));
  const args = ['-sS', '--fail', '-4', '--max-time', String(maxTime), '--retry', '3', '--retry-delay', '2', '--retry-all-errors', '--retry-max-time', String(Math.max(3, maxTime * 2))];
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'undefined') continue;
    args.push('-H', `${key}: ${String(value)}`);
  }
  args.push(urlStr);
  try {
    const { stdout } = await execFileAsync('curl', args);
    return stdout;
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr).trim() : '';
    const message = stderr ? `${err.message}: ${stderr}` : err.message;
    throw new Error(message);
  }
}

async function fetchJsonNative(url, headers) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      ...(headers || {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function fetchTextNative(url, headers) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      ...(headers || {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function fetchJsonEither(url, headers = {}, timeoutMs = 10000) {
  const baseHeaders = { 'Accept': 'application/json', ...(headers || {}) };
  try {
    return await fetchJsonNative(url, baseHeaders);
  } catch (err) {
    if (shouldUseFallback(err)) {
      const text = await requestWithCurl(url, { headers: baseHeaders, timeoutMs });
      return JSON.parse(text);
    }
    throw err;
  }
}

async function fetchTextEither(url, headers = {}, timeoutMs = 10000) {
  const baseHeaders = { ...(headers || {}) };
  try {
    return await fetchTextNative(url, baseHeaders);
  } catch (err) {
    if (shouldUseFallback(err)) {
      return await requestWithCurl(url, { headers: baseHeaders, timeoutMs });
    }
    throw err;
  }
}

function parseProxyJson(text) {
  if (typeof text !== 'string') throw new Error('Proxy response not string');
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Proxy response empty');
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    if (parsed && parsed.data && typeof parsed.data.content === 'string') {
      return parseProxyJson(parsed.data.content);
    }
    return parsed;
  }
  const start = trimmed.indexOf('{');
  if (start === -1) throw new Error('Proxy JSON missing');
  const end = trimmed.lastIndexOf('}');
  if (end === -1 || end < start) throw new Error('Proxy JSON incomplete');
  const jsonStr = trimmed.slice(start, end + 1).trim();
  return JSON.parse(jsonStr);
}

function nowKST() {
  const t = Date.now() + (new Date().getTimezoneOffset() * 60000) + 9 * 3600 * 1000;
  return new Date(t);
}
function yyyymmddKST(d = nowKST()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${dd}`;
}

async function getJson(url,{retries=3,base=400,headers,timeoutMs=10000}={}) {
  let err;
  for (let i=0;i<=retries;i++){
    try{
      return await fetchJsonEither(url, headers, timeoutMs);
    }catch(e){ err=e; if(i<retries) await sleep(base*2**i); }
  }
  throw err;
}

async function getText(url,{retries=3,base=400,headers,timeoutMs=10000}={}) {
  let err;
  const mergedHeaders = {
    'Accept':'text/html, */*;q=0.1',
    'Referer': 'https://finance.naver.com/',
    ...(headers||{}),
  };
  for (let i=0;i<=retries;i++){
    try{
      return await fetchTextEither(url, mergedHeaders, timeoutMs);
    }catch(e){ err=e; if(i<retries) await sleep(base*2**i); }
  }
  throw err;
}

function itemsFromRates(map) {
  return [
    { label:'1 USD',   amount:1,   from:'USD', to:'KRW', krw: map.USD_KRW ?? null },
    { label:'100 JPY', amount:100, from:'JPY', to:'KRW', krw: map.JPY100_KRW ?? null },
    { label:'1 EUR',   amount:1,   from:'EUR', to:'KRW', krw: map.EUR_KRW ?? null },
    { label:'1 CNY',   amount:1,   from:'CNY', to:'KRW', krw: map.CNY_KRW ?? null },
    { label:'1 GBP',   amount:1,   from:'GBP', to:'KRW', krw: map.GBP_KRW ?? null },
    { label:'1 HKD',   amount:1,   from:'HKD', to:'KRW', krw: map.HKD_KRW ?? null },
    { label:'Gold (1 g)', amount:1, from:'GOLD', to:'KRW', krw: map.GOLD_KRW ?? null },
    { label:'Bitcoin (1 BTC)', amount:1, from:'BTC', to:'KRW', krw: map.BTC_KRW ?? null },
  ];
}

const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const MS_PER_DAY = 24 * 3600 * 1000;

function toKSTDayFromUnix(seconds) {
  const ts = Number(seconds);
  if (!Number.isFinite(ts)) return null;
  const kstMs = ts * 1000 + 9 * 3600 * 1000;
  const d = new Date(kstMs);
  if (!Number.isFinite(d.getTime())) return null;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const dayStr = `${year}-${month}-${day}`;
  return { day: dayStr, iso: `${dayStr}T00:00:00+09:00`, year };
}

function dedupeAndSortDaily(points) {
  const map = new Map();
  for (const point of points ?? []) {
    if (!point || typeof point.day !== 'string') continue;
    map.set(point.day, point);
  }
  return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
}

function convertUsdSeriesToKrw(points, usdKrwMap, year) {
  const arr = [];
  let lastRate = null;
  for (const point of dedupeAndSortDaily(points)) {
    if (!point || typeof point.value !== 'number') continue;
    if (Number.isFinite(year) && Number(point.day?.slice(0, 4)) !== year) continue;
    let rate = usdKrwMap.get(point.day);
    if (!Number.isFinite(rate)) rate = lastRate;
    if (!Number.isFinite(rate)) continue;
    lastRate = rate;
    const val = Number((point.value * rate).toFixed(2));
    if (!Number.isFinite(val)) continue;
    arr.push({ t: point.iso, v: val });
  }
  return arr;
}

function formatDateYYYYMMDD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getUsdKrwRateForDay(usdMap, day) {
  if (!(usdMap instanceof Map) || usdMap.size === 0) return null;
  if (typeof day === 'string' && usdMap.has(day)) {
    const direct = Number(usdMap.get(day));
    if (Number.isFinite(direct)) return direct;
  }
  const entries = Array.from(usdMap.entries())
    .map(([date, rate]) => [date, Number(rate)])
    .filter(([, rate]) => Number.isFinite(rate))
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (!entries.length) return null;
  if (typeof day === 'string') {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i][0] <= day) {
        return entries[i][1];
      }
    }
  }
  return entries[entries.length - 1][1];
}

async function fetchCoindeskBitcoinPoint(usdMap) {
  const apiKey = process.env.COINDESK_API || process.env.COINDESK_API_KEY || process.env.COINDESK_TOKEN || '';
  const url = new URL('https://data-api.coindesk.com/index/cc/v1/latest/tick');
  url.searchParams.set('market', 'ccix');
  url.searchParams.set('instruments', 'BTC-USD');
  if (apiKey) {
    url.searchParams.set('api_key', apiKey);
  }
  const json = await getJson(url.toString(), {
    headers: { Accept: 'application/json' },
    retries: 1,
    base: 600,
    timeoutMs: 10000,
  });
  const payload = json?.Data?.['BTC-USD'] ?? json?.Data?.BTCUSD ?? null;
  if (!payload) throw new Error('Coindesk BTC payload missing');
  const usdValue = Number(payload.VALUE ?? payload.value);
  if (!Number.isFinite(usdValue)) throw new Error('Coindesk BTC value missing');
  let tsSeconds = Number(payload.VALUE_LAST_UPDATE_TS ?? payload.last_update_ts);
  if (!Number.isFinite(tsSeconds) && Number.isFinite(payload.VALUE_LAST_UPDATE_TS_NS)) {
    tsSeconds = Number(payload.VALUE_LAST_UPDATE_TS_NS) / 1e9;
  }
  if (!Number.isFinite(tsSeconds)) throw new Error('Coindesk BTC timestamp missing');
  const kst = toKSTDayFromUnix(tsSeconds);
  if (!kst?.day || !kst?.iso) throw new Error('Coindesk BTC timestamp invalid');
  const rate = getUsdKrwRateForDay(usdMap, kst.day);
  if (!Number.isFinite(rate)) throw new Error('USD/KRW rate unavailable for BTC');
  const krwValue = Number((usdValue * rate).toFixed(2));
  if (!Number.isFinite(krwValue)) throw new Error('Coindesk BTC conversion failed');
  return { t: kst.iso, v: krwValue };
}

function parseGoldBasDt(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  return { day, iso: `${day}T00:00:00+09:00` };
}

function parseGoldNumeric(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '').trim();
    if (!cleaned) return NaN;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : NaN;
  }
  return NaN;
}

function getGoldField(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (typeof key !== 'string' || !key) continue;
    const candidate = obj[key];
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
    } else if (typeof candidate === 'number') {
      if (Number.isFinite(candidate)) return candidate;
    }
  }
  return null;
}

function parseGoldItemsFromXml(text) {
  if (typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('<OpenAPI_ServiceResponse')) {
    const reason = trimmed.match(/<returnReasonCode>([^<]*)<\/returnReasonCode>/)?.[1]?.trim();
    const authMsg = trimmed.match(/<returnAuthMsg>([^<]*)<\/returnAuthMsg>/)?.[1]?.trim();
    const errMsg = trimmed.match(/<errMsg>([^<]*)<\/errMsg>/)?.[1]?.trim();
    const parts = [reason, authMsg, errMsg].filter(Boolean);
    const detail = parts.length ? parts.join(' / ') : 'Service error';
    throw new Error(detail);
  }
  const codeMatch = trimmed.match(/<resultCode>([^<]*)<\/resultCode>/);
  if (codeMatch) {
    const code = codeMatch[1]?.trim();
    if (code && code !== '00') {
      const message = trimmed.match(/<resultMsg>([^<]*)<\/resultMsg>/)?.[1]?.trim() ?? 'Unknown error';
      throw new Error(`${code} ${message}`.trim());
    }
  }
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(trimmed))) {
    const block = match[1];
    const entry = {};
    const fieldRegex = /<([^\s<>\/]+)>([\s\S]*?)<\/\1>/g;
    let fieldMatch;
    while ((fieldMatch = fieldRegex.exec(block))) {
      const key = fieldMatch[1]?.trim();
      if (!key) continue;
      const rawVal = fieldMatch[2] ?? '';
      const value = String(rawVal)
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .trim();
      entry[key] = value;
    }
    if (Object.keys(entry).length) {
      items.push(entry);
    }
  }
  return items;
}

function normalizeGoldApiEntries(rawItems) {
  const entries = [];
  for (const raw of rawItems ?? []) {
    const basDt = getGoldField(raw, ['basDt', 'basdt']);
    const parsedDate = parseGoldBasDt(typeof basDt === 'number' ? String(basDt) : basDt);
    if (!parsedDate) continue;
    const priceRaw = getGoldField(raw, ['clpr', 'close', 'closingPrice']);
    const price = parseGoldNumeric(priceRaw);
    if (!Number.isFinite(price)) continue;
    const code = getGoldField(raw, ['srtnCd', 'srtncd']);
    const name = getGoldField(raw, ['itmsNm', 'itmsnm']);
    const perGram = Number(Number(price).toFixed(2));
    if (!Number.isFinite(perGram)) continue;
    entries.push({
      code: typeof code === 'string' ? code.trim() : null,
      name: typeof name === 'string' ? name.trim() : null,
      iso: parsedDate.iso,
      day: parsedDate.day,
      value: perGram,
    });
  }
  return entries;
}

function buildGoldSeries(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    return { series: [], latest: null };
  }
  const byId = new Map();
  for (const entry of entries) {
    const key = entry.code || entry.name || 'default';
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(entry);
  }
  const preferOrder = ['04020000', '04020100'];
  const order = [...preferOrder, ...Array.from(byId.keys()).filter(key => !preferOrder.includes(key))];
  for (const id of order) {
    const arr = byId.get(id);
    if (!arr || !arr.length) continue;
    const perDay = new Map();
    for (const it of arr) {
      if (!it?.day) continue;
      perDay.set(it.day, it);
    }
    if (!perDay.size) continue;
    const sorted = Array.from(perDay.values()).sort((a, b) => a.day.localeCompare(b.day));
    const series = sorted.map(it => ({ t: it.iso, v: Number(it.value.toFixed(2)) }));
    if (series.length) {
      return { series, latest: series[series.length - 1] };
    }
  }
  return { series: [], latest: null };
}

async function fetchGoldPriceFromDataApi(year) {
  const serviceKey = (process.env.DATA_API_KEY || '').trim();
  if (!serviceKey) throw new Error('DATA_API_KEY missing');
  const url = new URL('https://apis.data.go.kr/1160100/service/GetGeneralProductInfoService/getGoldPriceInfo');
  url.searchParams.set('serviceKey', serviceKey);
  url.searchParams.set('numOfRows', '30');
  url.searchParams.set('pageNo', '1');
  url.searchParams.set('resultType', 'json');

  let text;
  try {
    text = await getText(url.toString(), {
      headers: { 'Accept': 'application/json, text/xml;q=0.9, */*;q=0.1' },
      timeoutMs: 12000,
      retries: 1,
    });
  } catch (err) {
    throw new Error(`data.go.kr request failed: ${err.message}`);
  }

  let items = [];
  let parsedJson = null;
  try {
    parsedJson = JSON.parse(text);
  } catch {}

  if (parsedJson) {
    const resultCode = String(parsedJson?.response?.header?.resultCode ?? parsedJson?.header?.resultCode ?? '').trim();
    if (resultCode && resultCode !== '00') {
      const msg = parsedJson?.response?.header?.resultMsg ?? parsedJson?.header?.resultMsg ?? 'Unknown error';
      throw new Error(`${resultCode} ${msg}`.trim());
    }
    const jsonItems = parsedJson?.response?.body?.items?.item ?? parsedJson?.body?.items?.item ?? parsedJson?.items?.item ?? parsedJson?.items;
    if (Array.isArray(jsonItems)) {
      items = jsonItems;
    } else if (jsonItems) {
      items = [jsonItems];
    }
  }

  if (!items.length) {
    items = parseGoldItemsFromXml(text);
  }

  if (!items.length) {
    throw new Error('data.go.kr gold payload empty');
  }

  const entries = normalizeGoldApiEntries(items)
    .filter(entry => !Number.isFinite(year) || Number(entry.day?.slice(0, 4)) >= year - 1);
  const { series, latest } = buildGoldSeries(entries);
  if (!series.length && !latest) {
    throw new Error('data.go.kr gold price unavailable');
  }
  return { series, latest };
}

async function fetchUsdKrwSeries(year) {
  const now = nowKST();
  const startDateStr = `${year}-01-01`;
  const endDateStr = now.getFullYear() === year ? formatDateYYYYMMDD(now) : `${year}-12-31`;
  const url = `https://api.frankfurter.app/${startDateStr}..${endDateStr}?from=USD&to=KRW`;
  const data = await getJson(url, { retries: 2, base: 600 });
  const map = new Map();
  for (const [date, value] of Object.entries(data?.rates ?? {})) {
    if (typeof date !== 'string') continue;
    if (Number(date.slice(0, 4)) !== year) continue;
    const rate = Number(value?.KRW);
    if (!Number.isFinite(rate)) continue;
    map.set(date, rate);
  }
  return map;
}

async function fetchYahooDailySeries(symbol, startMs, endMs) {
  const url = new URL(`${YAHOO_CHART_BASE}${encodeURIComponent(symbol)}`);
  url.searchParams.set('period1', Math.floor(startMs / 1000));
  url.searchParams.set('period2', Math.floor(endMs / 1000));
  url.searchParams.set('interval', '1d');
  url.searchParams.set('includePrePost', 'false');
  url.searchParams.set('events', 'history');

  let json = null;
  try {
    json = await getJson(url.toString(), {
      headers: { 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://finance.yahoo.com/' },
      retries: 2,
      base: 600,
      timeoutMs: 12000,
    });
  } catch {}

  if (!json?.chart?.result?.[0]) {
    const proxyUrl = `https://r.jina.ai/${url.toString()}`;
    const proxyText = await getText(proxyUrl, {
      headers: { 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' },
      timeoutMs: 15000,
    });
    json = parseProxyJson(proxyText);
  }

  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo data missing for ${symbol}`);
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const points = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = Number(timestamps[i]);
    const close = Number(closes[i]);
    if (!Number.isFinite(ts) || !Number.isFinite(close)) continue;
    const kst = toKSTDayFromUnix(ts);
    if (!kst) continue;
    points.push({ day: kst.day, iso: kst.iso, value: close });
  }
  return { points, meta: result.meta ?? {} };
}

function sanitizeSeriesPoints(points, year) {
  if (!Array.isArray(points)) return [];
  const byDay = new Map();
  for (const point of points) {
    if (!point || typeof point.t !== 'string' || typeof point.v !== 'number') continue;
    const d = new Date(point.t);
    if (!Number.isFinite(d.getTime())) continue;
    if (Number.isFinite(year) && d.getFullYear() !== year) continue;
    const dayKey = point.t.slice(0, 10);
    byDay.set(dayKey, { t: point.t, v: point.v });
  }
  const arr = Array.from(byDay.values());
  arr.sort((a, b) => new Date(a.t) - new Date(b.t));
  return arr;
}

function maxIso(...values) {
  let max = null;
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue;
    if (!max || value > max) {
      max = value;
    }
  }
  return max;
}

async function fetchGoldBitcoinKRW() {
  const now = nowKST();
  const year = now.getFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = now.getTime() + MS_PER_DAY;

  let usdMap;
  try {
    usdMap = await fetchUsdKrwSeries(year);
  } catch (err) {
    throw new Error(`USD/KRW reference failed: ${err.message}`);
  }
  if (!usdMap.size) {
    throw new Error('USD/KRW reference empty');
  }

  await sleep(400);

  let goldData = null;
  try {
    goldData = await fetchYahooDailySeries('GC=F', start, end);
  } catch (err) {
    console.warn(`[FX] Gold history fetch failed: ${err.message}`);
  }

  await sleep(400);

  let btcData = null;
  try {
    btcData = await fetchYahooDailySeries('BTC-USD', start, end);
  } catch (err) {
    console.warn(`[FX] Bitcoin history fetch failed: ${err.message}`);
  }

  let goldSeries = goldData
    ? convertUsdSeriesToKrw(goldData.points, usdMap, year)
        .map(point => {
          const value = Number(point?.v);
          if (!Number.isFinite(value)) return null;
          const perGram = Number((value / TROY_OUNCE_TO_GRAM).toFixed(2));
          if (!Number.isFinite(perGram)) return null;
          return { t: point.t, v: perGram };
        })
        .filter(Boolean)
    : [];
  let bitcoinSeries = btcData
    ? convertUsdSeriesToKrw(btcData.points, usdMap, year)
    : [];

  const btcPointIsStale = (point) => {
    if (!point || typeof point.t !== 'string') return true;
    const d = new Date(point.t);
    if (!Number.isFinite(d.getTime())) return true;
    return now.getTime() - d.getTime() > 2 * MS_PER_DAY;
  };

  let coindeskPoint = null;
  const latestFromSeries = bitcoinSeries.length ? bitcoinSeries[bitcoinSeries.length - 1] : null;
  if (!bitcoinSeries.length || btcPointIsStale(latestFromSeries)) {
    try {
      coindeskPoint = await fetchCoindeskBitcoinPoint(usdMap);
      if (coindeskPoint) {
        const dayKey = coindeskPoint.t.slice(0, 10);
        bitcoinSeries = bitcoinSeries
          .filter(p => p && typeof p.t === 'string' && typeof p.v === 'number');
        let replaced = false;
        for (let i = 0; i < bitcoinSeries.length; i++) {
          const existing = bitcoinSeries[i];
          if (existing.t.slice(0, 10) === dayKey) {
            bitcoinSeries[i] = coindeskPoint;
            replaced = true;
            break;
          }
        }
        if (!replaced) {
          bitcoinSeries.push(coindeskPoint);
        }
        bitcoinSeries.sort((a, b) => new Date(a.t) - new Date(b.t));
      }
    } catch (err) {
      console.warn(`[FX] Coindesk BTC fallback failed: ${err.message}`);
    }
  }

  let latestGold = goldSeries.length ? goldSeries[goldSeries.length - 1] : null;

  if ((!goldSeries.length || !latestGold) && process.env.DATA_API_KEY) {
    try {
      const fallback = await fetchGoldPriceFromDataApi(year);
      if (fallback?.series?.length) {
        goldSeries = sanitizeSeriesPoints([...goldSeries, ...fallback.series], year);
      }
      if (!latestGold && fallback?.latest) {
        latestGold = fallback.latest;
      }
      if (!latestGold && goldSeries.length) {
        latestGold = goldSeries[goldSeries.length - 1];
      }
    } catch (err) {
      console.warn(`[FX] Gold fallback (data.go.kr) failed: ${err.message}`);
    }
  }

  if (!latestGold && goldSeries.length) {
    latestGold = goldSeries[goldSeries.length - 1];
  }
  const latestBitcoin = bitcoinSeries.length ? bitcoinSeries[bitcoinSeries.length - 1] : null;
  const extraLastUpdateds = [];
  if (latestGold?.t) extraLastUpdateds.push(latestGold.t);
  if (latestBitcoin?.t) extraLastUpdateds.push(latestBitcoin.t);
  if (coindeskPoint?.t && !extraLastUpdateds.includes(coindeskPoint.t)) {
    extraLastUpdateds.push(coindeskPoint.t);
  }

  return {
    year,
    goldSeries,
    bitcoinSeries,
    latestGold,
    latestBitcoin,
    extraLastUpdateds,
  };
}

// -------- Exim helpers --------
async function fetchEximFor(dateStr, key) {
  const url = new URL('https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON');
  url.searchParams.set('authkey', key);
  url.searchParams.set('searchdate', dateStr);
  url.searchParams.set('data', 'AP01');
  const res = await fetch(url.toString(), { redirect: 'follow' });
  if (!res.ok) throw new Error(`EXIM HTTP ${res.status}`);
  return await res.json();
}
function isValidEximPayload(j) {
  return Array.isArray(j) && j.length > 0 && Number(j[0]?.result) === 1;
}
async function getEximLatestWithin(key, lookbackDays = 7) {
  let d = nowKST();
  for (let i = 0; i < lookbackDays; i++) {
    const ds = yyyymmddKST(d);
    const j = await fetchEximFor(ds, key);
    if (isValidEximPayload(j)) {
      return { date: ds, data: j };
    }
    d.setDate(d.getDate() - 1);
  }
  throw new Error('No valid FX data from Exim in last 7 days');
}

/* --- Provider 1: Naver Finance (환전 고시 환율) --- */
async function naverProvider() {
  // Parse rows like:
  // <td class="tit"><a>미국 USD</a>...</td><td class="sale">1,378.36</td>
  const html = await getText(NAVER_LIST);
  const re = /<td class="tit">[\s\S]*?<a[^>]*>([^<]+)<\/a>[\s\S]*?<\/td>\s*<td class="sale">([^<]+)<\/td>/g;

  const wanted = new Set(['USD','JPY','EUR','CNY','GBP','HKD']);
  const map = {}; // code -> KRW number (JPY is already 100JPY on Naver)
  let m;
  while ((m = re.exec(html))) {
    const name = m[1].replace(/\s+/g,' ').trim();      // e.g., "미국 USD", "일본 JPY (100엔)"
    const saleStr = m[2].replace(/,/g,'').trim();      // "1378.36"
    const codeMatch = name.match(/\b([A-Z]{3})\b/);
    if (!codeMatch) continue;
    const code = codeMatch[1];
    if (!wanted.has(code)) continue;
    const val = Number(saleStr);
    if (!Number.isFinite(val)) continue;
    map[code] = val;
  }

  // Require at least USD+JPY+EUR from Naver
  if (!(map.USD && map.JPY && map.EUR)) throw new Error('Naver parse incomplete');

  const outMap = {
    USD_KRW: map.USD ?? null,
    JPY100_KRW: map.JPY ?? null,        // Naver provides 100 JPY already
    EUR_KRW: map.EUR ?? null,
    CNY_KRW: map.CNY ?? null,
    GBP_KRW: map.GBP ?? null,
    HKD_KRW: map.HKD ?? null,
  };
  return itemsFromRates(outMap);
}

/* --- Provider 2: Korea Eximbank fallback --- */
async function eximProvider() {
  const key =
    process.env.EXIM_AUTH_KEY ||
    process.env.EXIM_API_KEY ||
    process.env.DATA_API_KEY ||
    process.env.KRX_API_KEY || '';
  if (!key) throw new Error('EXIM auth key missing');
  const latest = await getEximLatestWithin(key, 7);
  const map = {};
  for (const row of latest.data) {
    const unit = row.cur_unit;
    const rate = Number(row.deal_bas_r.replace(/,/g, ''));
    if (!Number.isFinite(rate)) continue;
    if (unit === 'USD') map.USD_KRW = rate;
    else if (unit.startsWith('JPY')) map.JPY100_KRW = rate;
    else if (unit === 'EUR') map.EUR_KRW = rate;
    else if (unit === 'CNY') map.CNY_KRW = rate;
    else if (unit === 'GBP') map.GBP_KRW = rate;
    else if (unit === 'HKD') map.HKD_KRW = rate;
  }
  return itemsFromRates(map);
}

/* --- Provider 3: Frankfurter fallback --- */
async function frankfurterProvider() {
  const usd = await getJson(FR_USD);
  const jpy = await getJson(FR_JPY);
  const map = {
    USD_KRW: usd?.rates?.KRW ?? null,
    JPY100_KRW: jpy?.rates?.KRW ? jpy.rates.KRW*100 : null,
    EUR_KRW: (usd?.rates?.KRW && usd?.rates?.EUR) ? usd.rates.KRW/usd.rates.EUR : null,
    CNY_KRW: (usd?.rates?.KRW && usd?.rates?.CNY) ? usd.rates.KRW/usd.rates.CNY : null,
    GBP_KRW: (usd?.rates?.KRW && usd?.rates?.GBP) ? usd.rates.KRW/usd.rates.GBP : null,
    HKD_KRW: (usd?.rates?.KRW && usd?.rates?.HKD) ? usd.rates.KRW/usd.rates.HKD : null,
  };
  return itemsFromRates(map);
}

/* --- Provider 4: Exchangerate.host fallback --- */
async function exchangerateHostProvider() {
  const usd = await getJson(EH_USD);
  const jpy = await getJson(EH_JPY);
  const map = {
    USD_KRW: usd?.rates?.KRW ?? null,
    JPY100_KRW: jpy?.rates?.KRW ? jpy.rates.KRW*100 : null,
    EUR_KRW: (usd?.rates?.KRW && usd?.rates?.EUR) ? usd.rates.KRW/usd.rates.EUR : null,
    CNY_KRW: (usd?.rates?.KRW && usd?.rates?.CNY) ? usd.rates.KRW/usd.rates.CNY : null,
    GBP_KRW: (usd?.rates?.KRW && usd?.rates?.GBP) ? usd.rates.KRW/usd.rates.GBP : null,
    HKD_KRW: (usd?.rates?.KRW && usd?.rates?.HKD) ? usd.rates.KRW/usd.rates.HKD : null,
  };
  return itemsFromRates(map);
}

// --- History helpers (append one point per day, in KST) ---
function keyFromItem(it) {
  return it.from === 'JPY' && it.amount === 100 ? 'JPY100' : it.from; // USD, EUR, CNY, GBP, HKD, JPY100
}

async function readManifest() {
  try {
    const raw = await fs.readFile(HISTORY_MANIFEST, 'utf-8');
    const parsed = JSON.parse(raw);
    const files = sanitizeManifestFiles(parsed.files);
    const yearsFromFiles = sanitizeYears(files.map(extractYearFromFilename).filter(Number.isFinite));
    let years = sanitizeYears(parsed.years);
    if (!years.length && yearsFromFiles.length) {
      years = yearsFromFiles;
    }
    if (!files.length && years.length) {
      for (const year of years) {
        files.push(`${HISTORY_PREFIX}${year}.json`);
      }
    }
    return {
      lastUpdated: parsed.lastUpdated ?? null,
      years,
      files,
    };
  } catch {
    if (existsSync(LEGACY_HISTORY)) {
      const legacyRaw = await fs.readFile(LEGACY_HISTORY, 'utf-8');
      const legacy = JSON.parse(legacyRaw);
      return await migrateLegacyHistory(legacy);
    }
    return { lastUpdated: null, years: [], files: [] };
  }
}

async function writeManifest(manifest) {
  const cleanYears = sanitizeYears(manifest.years);
  const files = cleanYears.map(year => `${HISTORY_PREFIX}${year}.json`);
  const out = { lastUpdated: manifest.lastUpdated ?? null, years: cleanYears, files };
  await fs.writeFile(HISTORY_MANIFEST, JSON.stringify(out, null, 2));
  manifest.years = cleanYears;
  manifest.files = files;
  manifest.lastUpdated = out.lastUpdated;
  return out;
}

async function writeLegacyHistoryFromManifest(manifest) {
  const years = sanitizeYears(manifest?.years);
  const combined = blankSeries();
  let latest = typeof manifest?.lastUpdated === 'string' ? manifest.lastUpdated : null;

  for (const year of years) {
    const data = await readYearHistory(year);
    for (const key of SERIES_KEYS) {
      const arr = Array.isArray(data.series?.[key]) ? data.series[key] : [];
      for (const point of arr) {
        if (!point || typeof point.t !== 'string' || typeof point.v !== 'number') continue;
        combined[key].push({ t: point.t, v: point.v });
        if (!latest || point.t > latest) {
          latest = point.t;
        }
      }
    }
  }

  for (const key of SERIES_KEYS) {
    const cleaned = combined[key]
      .filter(p => p && typeof p.t === 'string' && typeof p.v === 'number')
      .map(p => ({ t: p.t, v: p.v }));
    cleaned.sort((a, b) => {
      const ta = Date.parse(a.t);
      const tb = Date.parse(b.t);
      if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
      if (Number.isFinite(ta)) return -1;
      if (Number.isFinite(tb)) return 1;
      return a.t.localeCompare(b.t);
    });
    const deduped = [];
    for (const point of cleaned) {
      const last = deduped[deduped.length - 1];
      if (last && last.t === point.t) {
        deduped[deduped.length - 1] = point;
      } else {
        deduped.push(point);
      }
    }
    combined[key] = deduped;
  }

  const payload = {
    lastUpdated: typeof latest === 'string' ? latest : null,
    series: combined,
  };

  await fs.writeFile(LEGACY_HISTORY, JSON.stringify(payload, null, 2));
  return payload;
}

async function saveManifest(manifest) {
  const saved = await writeManifest(manifest);
  await writeLegacyHistoryFromManifest(saved);
  return saved;
}

async function readYearHistory(year) {
  try {
    const raw = await fs.readFile(historyFileForYear(year), 'utf-8');
    const parsed = JSON.parse(raw);
    const series = blankSeries();
    for (const key of SERIES_KEYS) {
      const arr = Array.isArray(parsed.series?.[key]) ? parsed.series[key] : [];
      series[key] = arr.filter(p => p && typeof p.t === 'string' && typeof p.v === 'number');
    }
    return { year, series, updatedAt: parsed.updatedAt ?? null };
  } catch {
    return { year, series: blankSeries(), updatedAt: null };
  }
}

async function writeYearHistory(data) {
  const { year } = data;
  const payload = {
    year,
    updatedAt: data.updatedAt ?? null,
    series: SERIES_KEYS.reduce((acc, key) => {
      const arr = Array.isArray(data.series?.[key]) ? data.series[key] : [];
      acc[key] = arr.map(p => ({ t: p.t, v: p.v }));
      return acc;
    }, {}),
  };
  await fs.writeFile(historyFileForYear(year), JSON.stringify(payload, null, 2));
}

async function migrateLegacyHistory(legacy) {
  const manifest = { lastUpdated: legacy?.lastUpdated ?? null, years: [] };
  const perYear = new Map();

  if (legacy && typeof legacy === 'object' && legacy.series) {
    for (const key of SERIES_KEYS) {
      const points = Array.isArray(legacy.series[key]) ? legacy.series[key] : [];
      for (const point of points) {
        if (!point || typeof point.t !== 'string' || typeof point.v !== 'number') continue;
        const d = new Date(point.t);
        const year = Number.isFinite(d.getTime()) ? d.getFullYear() : NaN;
        if (!Number.isFinite(year)) continue;
        if (!perYear.has(year)) {
          perYear.set(year, { year, updatedAt: null, series: blankSeries() });
        }
        const yearData = perYear.get(year);
        yearData.series[key].push({ t: point.t, v: point.v });
        if (!yearData.updatedAt || point.t > yearData.updatedAt) {
          yearData.updatedAt = point.t;
        }
      }
    }
  }

  const years = Array.from(perYear.keys()).sort((a, b) => a - b);
  for (const year of years) {
    const data = perYear.get(year);
    for (const key of SERIES_KEYS) {
      const sorted = data.series[key]
        .filter(p => p && typeof p.t === 'string' && typeof p.v === 'number')
        .sort((a, b) => new Date(a.t) - new Date(b.t));
      const deduped = [];
      for (const point of sorted) {
        const last = deduped[deduped.length - 1];
        if (last && last.t === point.t) {
          deduped[deduped.length - 1] = point;
        } else {
          deduped.push(point);
        }
      }
      data.series[key] = deduped;
    }
    await writeYearHistory(data);
  }

  if (existsSync(LEGACY_HISTORY)) {
    try { await fs.unlink(LEGACY_HISTORY); } catch {}
  }

  manifest.years = years;
  return await saveManifest(manifest);
}

function upsertPoint(arr, iso, val) {
  const day = iso.slice(0,10);             // YYYY-MM-DD
  const last = arr[arr.length - 1];
  if (last && last.t.slice(0,10) === day) {
    last.v = val;                          // overwrite same-day point
  } else {
    arr.push({ t: iso, v: val });
  }
}

async function updateHistory(snapshot, options = {}) {
  const manifest = await readManifest();
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const lastUpdated = typeof snapshot?.lastUpdated === 'string' ? snapshot.lastUpdated : null;
  const extraSeries = options && typeof options.extraSeries === 'object' && options.extraSeries
    ? options.extraSeries
    : {};
  const extraYear = Number.isFinite(options?.extraYear) ? Math.trunc(options.extraYear) : null;
  const extraLastUpdateds = Array.isArray(options?.extraLastUpdateds)
    ? options.extraLastUpdateds.filter(v => typeof v === 'string')
    : [];

  let year = null;
  if (lastUpdated) {
    const ts = new Date(lastUpdated);
    if (Number.isFinite(ts.getTime())) {
      year = ts.getFullYear();
    }
  }
  if (!Number.isFinite(year) && Number.isFinite(extraYear)) {
    year = extraYear;
  }

  if (!Number.isFinite(year)) {
    if (Number.isFinite(extraYear) && !manifest.years.includes(extraYear)) {
      manifest.years.push(extraYear);
    }
    manifest.lastUpdated = maxIso(manifest.lastUpdated, lastUpdated, ...extraLastUpdateds);
    return await saveManifest(manifest);
  }

  const yearHistory = await readYearHistory(year);
  const extraSeriesLatest = [];

  for (const [key, series] of Object.entries(extraSeries)) {
    if (!SERIES_KEYS.includes(key)) continue;
    const sanitized = sanitizeSeriesPoints(series, year);
    if (sanitized.length) {
      yearHistory.series[key] = sanitized;
      extraSeriesLatest.push(sanitized[sanitized.length - 1].t);
    }
  }

  if (lastUpdated) {
    for (const it of items) {
      if (!it || typeof it.krw !== 'number') continue;
      const key = keyFromItem(it);
      yearHistory.series[key] ??= [];
      upsertPoint(yearHistory.series[key], lastUpdated, it.krw);
    }
  }

  for (const key of SERIES_KEYS) {
    const sorted = (yearHistory.series[key] ?? [])
      .filter(p => p && typeof p.t === 'string' && typeof p.v === 'number' && new Date(p.t).getFullYear() === year)
      .sort((a, b) => new Date(a.t) - new Date(b.t));
    const deduped = [];
    for (const point of sorted) {
      const last = deduped[deduped.length - 1];
      if (last && last.t === point.t) {
        deduped[deduped.length - 1] = point;
      } else {
        deduped.push(point);
      }
    }
    yearHistory.series[key] = deduped;
  }

  const updateCandidates = [yearHistory.updatedAt, lastUpdated, ...extraSeriesLatest, ...extraLastUpdateds];
  yearHistory.updatedAt = maxIso(...updateCandidates);
  await writeYearHistory(yearHistory);

  if (!manifest.years.includes(year)) {
    manifest.years.push(year);
  }
  manifest.lastUpdated = maxIso(manifest.lastUpdated, yearHistory.updatedAt, lastUpdated, ...extraLastUpdateds, ...extraSeriesLatest);
  return await saveManifest(manifest);
}

async function main(){
  await fs.mkdir(OUT_DIR, { recursive:true });

  let items = null;
  const providers = [naverProvider];
  if (process.env.USE_EXIM_FX_BACKUP === '1') {
    providers.push(eximProvider);
  }
  providers.push(frankfurterProvider, exchangerateHostProvider);

  for (const p of providers) {
    try {
      items = await p();
      if (items.some(x => typeof x.krw === 'number')) { 
        // Found at least one numeric value
        break;
      }
    } catch(e) {
      console.warn(`[FX] Provider failed: ${p.name}: ${e.message}`);
    }
  }

  if (!items) {
    if (existsSync(OUT)) {
      console.warn('FX: all providers failed; falling back to previous snapshot');
      try {
        const prevRaw = await fs.readFile(OUT, 'utf-8');
        const prev = JSON.parse(prevRaw);
        if (Array.isArray(prev?.items)) {
          items = prev.items.map(it => ({ ...it }));
        }
      } catch (err) {
        console.warn(`[FX] Failed to read fallback FX file: ${err.message}`);
      }
    }
    if (!items) {
      items = itemsFromRates({}); // all nulls
    }
  }

  items = Array.isArray(items) ? items : [];

  let commodityData = null;
  try {
    commodityData = await fetchGoldBitcoinKRW();
  } catch (err) {
    console.warn(`[FX] Commodity fetch failed: ${err.message}`);
  }

  const ensureItem = (code, fallbackLabel) => {
    let found = items.find(it => keyFromItem(it) === code || it.from === code);
    if (!found) {
      found = { label: fallbackLabel, amount: 1, from: code, to: 'KRW', krw: null };
      items.push(found);
    }
    return found;
  };

  if (commodityData?.latestGold) {
    ensureItem('GOLD', 'Gold (1 g)').krw = commodityData.latestGold.v;
  } else {
    ensureItem('GOLD', 'Gold (1 g)');
  }

  if (commodityData?.latestBitcoin) {
    ensureItem('BTC', 'Bitcoin (1 BTC)').krw = commodityData.latestBitcoin.v;
  } else {
    ensureItem('BTC', 'Bitcoin (1 BTC)');
  }

  const out = { lastUpdated: nowKSTISO(), items };
  await fs.writeFile(OUT, JSON.stringify(out, null, 2));
  console.log(`FX: wrote ${OUT} at ${out.lastUpdated}`);

  // append/update rolling history
  const extraSeries = {};
  if (commodityData?.goldSeries?.length) {
    extraSeries.GOLD = commodityData.goldSeries;
  }
  if (commodityData?.bitcoinSeries?.length) {
    extraSeries.BTC = commodityData.bitcoinSeries;
  }
  await updateHistory(out, {
    extraSeries,
    extraYear: commodityData?.year ?? null,
    extraLastUpdateds: commodityData?.extraLastUpdateds ?? [],
  });
}

main().catch(e => { console.error(e); process.exit(1); });
