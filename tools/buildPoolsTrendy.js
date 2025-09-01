// tools/buildPoolsTrendy.js
// Builds trend-aware pools using Finnhub (primary) with TwelveData and FMP as fallbacks for quotes.
// Writes: pools.json (names only) and pools-metrics.json (diagnostics).
// Safe: if no API keys or endpoints fail, it logs and leaves pools.json unchanged.

import fs from 'fs';
import path from 'path';
import fsp from 'fs/promises';
import crypto from 'crypto';
import { execSync } from 'node:child_process';
import { TICKER_MAP } from '../src/maps.js';
import { getCandles, providerState } from '../src/data/candles.js';
import { buildUniverse } from '../src/universe/index.js';
import { buildNewsFeatures, newsScoreFromFeatures } from '../src/news/fetchByTicker.js';
import { fetchNaverTrends, buildBasketsFromUniverse } from '../src/trends/naverDatalab.js';
import { buildKeywordDict } from '../src/trends/keywordBuilder.js';
import { fetchDeepsearchFeatures } from '../src/news/deepsearch.js';

fs.mkdirSync('cache', { recursive: true });

const CACHE_DIR = 'cache';
const TTL_MS = 1000 * 60 * 60 * 12; // 12h default; can override per-call

const VERBOSE = process.env.VERBOSE === '1';
const log = (...a) => VERBOSE && console.log(...a);

let CIRCUIT_OPEN = false;
let CIRCUIT_OPENED_AT = 0;
const CIRCUIT_COOLDOWN_MS = Number(process.env.CIRCUIT_COOLDOWN_MS || 30000); // 30s

function circuitOpen() {
  if (!CIRCUIT_OPEN) return false;
  if (Date.now() - CIRCUIT_OPENED_AT > CIRCUIT_COOLDOWN_MS) {
    CIRCUIT_OPEN = false;
    consecutiveErrors = 0;
    return false;
  }
  return true;
}

function cacheKeyFor(url) {
  const h = crypto.createHash('sha1').update(url).digest('hex');
  return path.join(CACHE_DIR, `${h}.json`);
}

async function cachedJsonFetch(url, fetchFn, ttlMs = TTL_MS, allowStale = false) {
  const key = cacheKeyFor(url);
  try {
    const st = fs.statSync(key);
    const age = Date.now() - st.mtimeMs;
    if (age < ttlMs) {
      return JSON.parse(fs.readFileSync(key, 'utf8'));
    }
    if (allowStale) {
      console.warn(`[cache] serving STALE for ${url.split('?')[0]} (age=${Math.round(age/1000)}s)`);
      return JSON.parse(fs.readFileSync(key, 'utf8'));
    }
  } catch {}

  const data = await fetchFn(url);
  try { fs.writeFileSync(key, JSON.stringify(data)); } catch {}
  return data;
}

function looksLikeXmlOrHtml(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (t.startsWith('<')) return true; // tags or <!DOCTYPE …> or <?xml … ?>
  return false;
}

async function safeParseBody(res) {
  const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
  if (/json/i.test(ct)) {
    return await res.json();
  }
  const txt = await res.text();
  if (looksLikeXmlOrHtml(txt)) {
    throw new Error(`Non-JSON payload (${ct || 'unknown'}), startsWith="<". Likely HTML error/rate-limit page.`);
  }
  try { return JSON.parse(txt); }
  catch (e) { throw new Error(`JSON parse failed (${ct || 'unknown'}): ${e.message}`); }
}

async function fetchFmpNewsCount(sym){
  if (!sym || OFFLINE) return 0;
  const from = new Date(Date.now() - 7*86400000).toISOString().slice(0,10);
  const url = `https://financialmodelingprep.com/api/v3/stock_news?tickers=${encodeURIComponent(sym)}&from=${from}&limit=50&apikey=${FMP_API_KEY}`;
  try {
    const data = await cachedJsonFetch(url, u => fetch(u).then(safeParseBody));
    return Array.isArray(data) ? data.length : 0;
  } catch { return 0; }
}

async function fetchGoogleNewsCount(sym){
  if (!sym || OFFLINE) return 0;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(sym)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const data = await cachedJsonFetch(url, async u => {
      const txt = await fetch(u).then(r=>r.text());
      const count = (txt.match(/<item>/g) || []).length;
      return { count };
    });
    return data.count || 0;
  } catch { return 0; }
}

async function fetchYahooNewsCount(sym){
  if (!sym || OFFLINE) return 0;
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(sym)}&region=US&lang=en-US`;
  try {
    const data = await cachedJsonFetch(url, async u => {
      const txt = await fetch(u).then(r=>r.text());
      const count = (txt.match(/<item>/g) || []).length;
      return { count };
    });
    return data.count || 0;
  } catch { return 0; }
}

async function fetchInvestingNewsCount(sym){
  if (!sym || OFFLINE) return 0;
  const url = `https://www.investing.com/search/?q=${encodeURIComponent(sym)}`;
  try {
    const data = await cachedJsonFetch(url, async u => {
      const txt = await fetch(u).then(r=>r.text());
      const count = (txt.match(new RegExp(sym, 'gi')) || []).length;
      return { count };
    });
    return data.count || 0;
  } catch { return 0; }
}

async function fetchHanwhaNewsCount(sym){
  if (!sym || OFFLINE) return 0;
  const url = `https://m.hanwhawm.com:9090/M/main/research/main/list.cmd?depth3_id=overseaEtf&search=${encodeURIComponent(sym)}`;
  try {
    const data = await cachedJsonFetch(url, async u => {
      const txt = await fetch(u).then(r=>r.text());
      const count = (txt.match(new RegExp(sym, 'gi')) || []).length;
      return { count };
    }, TTL_MS, true);
    return data.count || 0;
  } catch { return 0; }
}

async function fetchWikiPageviews(title){
  if (!title || OFFLINE) return 0;
  const norm = String(title).replace(/\s+/g, '_');
  const endDate = new Date();
  const end = endDate.toISOString().slice(0,10).replace(/-/g, '');
  const startDate = new Date(endDate.getTime() - 7*86400000);
  const start = startDate.toISOString().slice(0,10).replace(/-/g, '');
  const enc = encodeURIComponent(norm);
  const langs = ['en', 'ko'];
  for (const lang of langs) {
    const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${lang}.wikipedia/all-access/all-agents/${enc}/daily/${start}/${end}`;
    try {
      const data = await cachedJsonFetch(url, u => fetch(u).then(safeParseBody), TTL_MS, true);
      if (data && Array.isArray(data.items)) {
        return data.items.reduce((sum, it) => sum + (it.views || 0), 0);
      }
    } catch {}
  }
  try {
    const url = `https://namu.wiki/api/pageview?title=${enc}`;
    const data = await cachedJsonFetch(url, u => fetch(u).then(safeParseBody), TTL_MS, true);
    if (data && typeof data.total === 'number') return data.total;
  } catch {}
  return 0;
}

const SYMBOL_MAP_FILE = path.join(CACHE_DIR, 'name-to-symbol.json');
function loadNameToSymbol() {
  const txt = tryRead(SYMBOL_MAP_FILE);
  return txt ? JSON.parse(txt) : {};
}
function saveNameToSymbol(map) {
  try { fs.writeFileSync(SYMBOL_MAP_FILE, JSON.stringify(map, null, 2)); } catch {}
}
const NAME_TO_SYMBOL = loadNameToSymbol();
const SYMBOL_TO_NAME = {};
const CONFIRMED_KEYS = new Set();

// Canonicalize keys and strip invisible characters
function normalizeKey(s) {
  if (s == null) return '';
  let t = String(s).normalize('NFKC');
  // Remove all format controls (Cf) if supported
  try { t = t.replace(/\p{Cf}/gu, ''); } catch {}
  // Remove common invisibles (soft hyphen, word joiner, bidi, etc.)
  t = t.replace(/[\u00AD\u034F\u061C\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069]/g, '');
  // Remove ASCII/Latin control chars (Cc)
  t = t.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
  t = t.replace(/\uFEFF/g, ''); // strip BOM
  // Unify Unicode minus to hyphen
  t = t.replace(/\u2212/g, '-');
  // Remove all space separators (Zs) and then any remaining whitespace
  t = t.replace(/\u00A0|\u1680|[\u2000-\u200A]|\u202F|\u205F|\u3000/g, '');
  t = t.replace(/\s+/g, '').trim();
  // Uppercase for stable ticker comparisons (safe for KR codes)
  return t.toUpperCase();
}

// Import index maps (S&P 500, Nasdaq-100, KOSPI 200, KOSDAQ 100)
let INDEX_RAW = {};
try {
  INDEX_RAW = JSON.parse(await fsp.readFile('src/maps.indexes.json', 'utf8'));
} catch {}
const INDEX_ROWS = (() => {
  const keys = ["sp500", "nasdaq100", "kospi200", "kosdaq100"];
  let rows = [];
  for (const k of keys) if (Array.isArray(INDEX_RAW?.[k])) rows = rows.concat(INDEX_RAW[k]);
  return rows;
})();

const SP500 = new Map((INDEX_RAW.sp500 || []).map(r => [r.symbol || r.ticker, r.name]));
const N100  = new Map((INDEX_RAW.nasdaq100 || []).map(r => [r.symbol || r.ticker, r.name]));
const K200  = new Map((INDEX_RAW.kospi200 || []).map(r => [r.symbol, r.name]));
const KQ100 = new Map((INDEX_RAW.kosdaq100 || []).map(r => [r.symbol, r.name]));

function normIndexKey(sym){
  return String(sym || '').toUpperCase().replace('/', '.').replace('-', '.');
}
function inIdx(sym, m){ return m.has(normIndexKey(sym)); }

const PRIOR_W_SP500 = +process.env.PRIOR_W_SP500 || 0.50;
const PRIOR_W_N100  = +process.env.PRIOR_W_N100  || 0.25;
const PRIOR_W_K200  = +process.env.PRIOR_W_K200  || 0.35;
const PRIOR_W_KQ100 = +process.env.PRIOR_W_KQ100 || 0.20;
const PRIOR_FLOOR   = +process.env.PRIOR_FLOOR   || 0.10; // base for names in no index
const STRUCT_FLOOR_W = +process.env.STRUCT_FLOOR_W || 0.12; // portion of scale reserved for prior
const PREV_CARRY = +process.env.PREV_CARRY || 0.3;  // 0..1 how much of last run to keep

const HOT_W_NEWS       = +process.env.HOT_W_NEWS       || 0.40;
const HOT_W_TREND      = +process.env.HOT_W_TREND      || 0.30;
const HOT_W_TURN       = +process.env.HOT_W_TURN       || 0.20;
const HOT_W_WIKI       = +process.env.HOT_W_WIKI       || 0.10;
const TREND_EXP        = +process.env.TREND_EXP        || 1.5;  // >1 makes trend more sensitive
const BURST_KICK_SCALE = +process.env.BURST_KICK_SCALE || 0.02; // * ds_burst
const BURST_KICK_MAX   = +process.env.BURST_KICK_MAX   || 0.04; // cap (0..1 scale)

// --- Popularity (bounded) ---
const POP_W       = +process.env.POP_W       || 6;    // % of 0..1 scale added to score
const POP_FLOOR_W = +process.env.POP_FLOOR_W || 0.01; // portion of scale reserved for popularity floor
const POP_CAP     = +process.env.POP_CAP     || 0.10; // hard cap of popularity bump (0..1 scale)

// External news/popularity weights
const FMP_API_KEY        = process.env.FMP_API_KEY || 'demo';
const BLOG_WEIGHT        = +process.env.BLOG_WEIGHT        || 1.5;
const NEWS_WEIGHT        = +process.env.NEWS_WEIGHT        || 2.5;
const POPULARITY_WEIGHT  = +process.env.POPULARITY_WEIGHT  || 60; // naver popularity is 0..1
const POS_KW_WEIGHT      = +process.env.POS_KW_WEIGHT      || 3;
const NEG_KW_WEIGHT      = +process.env.NEG_KW_WEIGHT      || 1; // negative keywords count slightly
const WIKI_WEIGHT        = +process.env.WIKI_WEIGHT        || 0.2;
const SCALE_WEIGHT       = +process.env.SCALE_WEIGHT       || 0.05; // scale & stability weight (0..1)

function structuralPrior(sym){
  let p = PRIOR_FLOOR;
  if (inIdx(sym, SP500)) p += PRIOR_W_SP500;
  if (inIdx(sym, N100))  p += PRIOR_W_N100;
  if (inIdx(sym, K200))  p += PRIOR_W_K200;
  if (inIdx(sym, KQ100)) p += PRIOR_W_KQ100;
  return clamp01(p);
}

const INDEX_SYMBOL_TO_NAME = {};
const INDEX_MARKETCAP = {};
for (const r of INDEX_ROWS) {
  const sym = String(r.symbol || r.ticker || '').toUpperCase().replace('/', '.').replace('-', '.');
  if (!sym) continue;
  if (r.name) INDEX_SYMBOL_TO_NAME[sym] = r.name;
  if (r.marketCap) INDEX_MARKETCAP[sym] = r.marketCap;
}

for (const [sym, nm] of Object.entries(INDEX_SYMBOL_TO_NAME)) {
  SYMBOL_TO_NAME[sym] = SYMBOL_TO_NAME[sym] || nm;
  const nk = normalizeKey(nm);
  if (!NAME_TO_SYMBOL[nk]) NAME_TO_SYMBOL[nk] = sym;
}

function keyVariants(k) {
  const t = normalizeKey(k);
  const v = new Set([t]);
  // Produce dash/dot/slash variants for class B/C tickers, and dotless
  if (/^[A-Z]{1,5}[-./][A-Z]{1,3}$/.test(t)) {
    const dot  = t.replace(/[-/]/g, '.');
    const dash = dot.replace(/\./g, '-');
    const slsh = dot.replace(/\./g, '/');
    v.add(dot); v.add(dash); v.add(slsh);
  }
  const dotless = t.replace(/\./g, '');
  v.add(dotless);
  return Array.from(v);
}

function rememberMapping(humanNameOrTicker, providerSymbol) {
  if (!humanNameOrTicker || !providerSymbol) return;
  for (const k of keyVariants(humanNameOrTicker)) {
    if (NAME_TO_SYMBOL[k] !== providerSymbol) {
      NAME_TO_SYMBOL[k] = providerSymbol;
    }
  }
}

function confirmMapping(humanNameOrTicker, providerSymbol) {
  if (!humanNameOrTicker || !providerSymbol) return;
  rememberMapping(humanNameOrTicker, providerSymbol);
  for (const k of keyVariants(humanNameOrTicker)) {
    CONFIRMED_KEYS.add(k);
  }
}

function persistConfirmedMappings() {
  if (CONFIRMED_KEYS.size === 0) return;
  const existing = loadNameToSymbol();
  for (const k of CONFIRMED_KEYS) {
    existing[k] = NAME_TO_SYMBOL[k];
  }
  saveNameToSymbol(existing);
}

function lookupLearnedMapping(key) {
  for (const k of keyVariants(key)) {
    if (NAME_TO_SYMBOL[k]) return NAME_TO_SYMBOL[k];
  }
  return null;
}

function tryProviders(sym) {
  const providers = ['finnhub', 'twelvedata', 'fmp'];
  providers.sort((a, b) => providerPenalty(a) - providerPenalty(b));
  for (const p of providers) {
    if (!sym) continue;
    // For now, assume candidate symbol is valid when provider key exists
    // Real-time validation happens later when fetching candles.
    if (p === 'finnhub' && FINNHUB) return sym;
    if (p === 'twelvedata' && TWELVE) return sym;
    if (p === 'fmp' && FMP) return sym;
  }
  return null;
}

function mapOne(rawKey) {
  const direct = nameToSymbol(normalizeKey(rawKey));
  if (direct) return { sym: direct, raw: rawKey, source: (direct === rawKey ? 'ticker' : 'dict') };

  const t = normalizeKey(rawKey);
  const variants = [t, t.replace('.', '-'), t.replace('.', '/'), t.replace('.', '')];

  for (const v of variants) {
    const sym = tryProviders(v);
    if (sym) {
      rememberMapping(rawKey, sym);
      return { sym, raw: rawKey, source: 'provider' };
    }
  }
  return null;
}

function fallbackSymbolFromRaw(raw) {
  const s = normalizeKey(raw);
  if (/^[A-Z]{1,5}$/.test(s)) return s;            // accept plain US tickers
  if (/^\d{6}\.K[QS]$/.test(s)) return s;
  if (ALLOWLIST.has(s)) return s;
  if (/^[A-Z]{1,5}\.[A-Z]{1,3}$/.test(s)) return s;
  if (/^[A-Z]{1,5}[-/][A-Z]{1,3}$/.test(s)) {
    const [a,b] = s.split(/[-/]/);
    return `${a}.${b}`;
  }
  return null;
}

function mergeIndexNames(base, idxMap) {
  const out = new Set(base || []);
  for (const [sym, nm] of idxMap) out.add(nm || sym);
  return Array.from(out);
}

const PROVIDER_SCORE_FILE = path.join(CACHE_DIR, 'provider-score.json');
function loadProviderScore() {
  const txt = tryRead(PROVIDER_SCORE_FILE);
  return txt ? JSON.parse(txt) : {};
}
function saveProviderScore(score) {
  try { fs.writeFileSync(PROVIDER_SCORE_FILE, JSON.stringify(score, null, 2)); } catch {}
}
const providerScore = loadProviderScore();

function bump(provider, ok) {
  providerScore[provider] ||= { ok: 0, fail: 0, lastFail: 0 };
  if (ok) providerScore[provider].ok++;
  else { providerScore[provider].fail++; providerScore[provider].lastFail = Date.now(); }
  saveProviderScore(providerScore);
}

function providerPenalty(provider) {
  const p = providerScore[provider];
  if (!p) return 0;
  const ageH = (Date.now() - (p.lastFail || 0)) / 36e5;
  const recency = Math.max(0, 6 - ageH) / 6;
  return p.fail * (1 + recency);
}

const LAST_GOOD = path.join(CACHE_DIR, 'last-good-pools.json');
function snapshotPools(pools) {
  try { fs.writeFileSync(LAST_GOOD, JSON.stringify(pools, null, 2)); } catch {}
}
function loadLastGoodPools() {
  const txt = tryRead(LAST_GOOD);
  return txt ? JSON.parse(txt) : null;
}

function tryRead(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch { return null; }
}

const FINNHUB = process.env.FINNHUB_API_KEY || '';
const TWELVE = process.env.TWELVEDATA_API_KEY || '';
const FMP = process.env.FMP_KEY || '';

const POOLS_FILE = 'pools.json';
const METRICS_FILE = 'pools-metrics.json';
const FEEDBACK_FILE = 'feedback.json';
const NEWS_FEATURES_FILE = 'data/news-features.json';
const NAVER_TRENDS_FILE = 'data/naver-trends.json';

const MARKETS = ["KOSPI", "KOSDAQ", "S&P 500", "NASDAQ 100"];
// Track picks from earlier markets in this run
const USED = {};

let NEWS_FEATURES = {};
try {
  NEWS_FEATURES = JSON.parse(await fsp.readFile(NEWS_FEATURES_FILE, 'utf8'));
} catch {}

let PREV_METRICS = {};
try {
  PREV_METRICS = JSON.parse(await fsp.readFile(METRICS_FILE, 'utf8'));
} catch {}

async function enrichWithNewsFeatures(symbols, opts = {}) {
  const feats = await buildNewsFeatures(symbols, opts);
  try {
    await fsp.mkdir('data', { recursive: true });
    await fsp.writeFile(NEWS_FEATURES_FILE, JSON.stringify(feats, null, 2));
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
    if (timeLeft() < GLOBAL_BUDGET_MS * 0.25) { return {}; }
    // pick a safe 12-month window to compute baseline
    const today = new Date();
    const end = today.toISOString().slice(0,10);
    const startDt = new Date(today.getTime() - 365*24*3600*1000);
    const start = startDt.toISOString().slice(0,10);

    const { perSymbol, raw } = await fetchNaverTrends({
      baskets, startDate: start, endDate: end, timeUnit: 'date',
      cacheTtlMs: Number(process.env.NAVER_TRENDS_CACHE_TTL_MS || 6*60*60*1000),
      budgetLeftMs: timeLeft()
    }).then(r => { bump('naver', true); return r; });
    try {
      await fsp.mkdir('data', { recursive: true });
      await fsp.writeFile(NAVER_TRENDS_FILE, JSON.stringify({ perSymbol, rawMeta: Object.keys(raw) }, null, 2));
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
    bump('naver', false);
    console.warn('[naver] trends enrichment failed:', e.message);
    return {};
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
const COVERAGE_MIN = +process.env.COVERAGE_MIN || 0.15;  // loosen gate
const FINAL_FRAC   = Number(process.env.FINAL_STAGE_BUDGET_FRAC || 0.02);
const GLOBAL_BUDGET_MS = +process.env.GLOBAL_BUDGET_MS || 90000; // 90s soft budget
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 3);       // lower for demo keys
const DEMO_MODE = !process.env.FINNHUB_API_KEY || process.env.FINNHUB_API_KEY === 'demo';
const MIN_ADV_US = Number(process.env.MIN_ADV_US || 200000);
const MIN_ADV_KR = Number(process.env.MIN_ADV_KR || 50000);
const MIN_PRICE_USD = Number(process.env.MIN_PRICE_USD || 2);
const MIN_PRICE_KRW = Number(process.env.MIN_PRICE_KRW || 1000);
const INELIGIBLE_PENALTY = Number(process.env.INELIGIBLE_PENALTY || 0.8);
const UNKNOWN_PENALTY    = Number(process.env.UNKNOWN_PENALTY || 0.3);
const CROSS_MARKET_DEDUP = process.env.CROSS_MARKET_DEDUP !== '0';
const ALLOWLIST = new Set(Object.values(TICKER_MAP));

// ---- time budget
const START_TS = Date.now();
function timeLeft() { return Math.max(0, GLOBAL_BUDGET_MS - (Date.now() - START_TS)); }
function budgetOk(ms=0) { return timeLeft() > ms; }

// ---- circuit breaker
let consecutiveErrors = 0;
const CIRCUIT_MAX_ERRORS = +process.env.CIRCUIT_MAX_ERRORS || 6;
function tripOnError(e) {
  const msg = String(e?.message || e || '');
  // If this came from KR news/earnings (which we now skip), do not escalate
  if (/company-news|calendar\/earnings/i.test(msg) && /K[QS]\b/.test(msg)) {
    console.warn(`[soft] ${msg}`);
    return false;
  }
  consecutiveErrors++;
  if (consecutiveErrors >= CIRCUIT_MAX_ERRORS) {
    CIRCUIT_OPEN = true;
    CIRCUIT_OPENED_AT = Date.now();
    console.warn(`[circuit] too many errors (${consecutiveErrors}), entering offline fallback (cooldown ${CIRCUIT_COOLDOWN_MS}ms)`);
    return true;
  }
  return false;
}
function resetErrors(){
  consecutiveErrors = 0;
  if (CIRCUIT_OPEN) {
    CIRCUIT_OPEN = false;
  }
}

// try to import existing map if available (non-fatal if missing)
try {
  Object.assign(NAME_TO_SYMBOL, (await import('../data/tickerMap.js')).NAME_TO_SYMBOL || {});
} catch {}

Object.assign(NAME_TO_SYMBOL, {
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
});

Object.assign(NAME_TO_SYMBOL, {
  '한화에어로스페이스': '012450.KS',
  'BGF리테일': '282330.KS',
  '삼성바이오로직스': '207940.KS',
  'LG에너지솔루션': '373220.KS'
});

// Reindex NAME_TO_SYMBOL and also merge TICKER_MAP by normalized keys
(function normalizeDictionaries() {
  const entries = Object.entries(NAME_TO_SYMBOL);
  for (const [k, v] of entries) {
    const nk = normalizeKey(k);
    if (nk !== k) {
      delete NAME_TO_SYMBOL[k];
      if (!(nk in NAME_TO_SYMBOL)) NAME_TO_SYMBOL[nk] = v;
    }
  }
  for (const [k, v] of Object.entries(TICKER_MAP)) {
    const nk = normalizeKey(k);
    if (!(nk in NAME_TO_SYMBOL)) NAME_TO_SYMBOL[nk] = v;
  }
})();

// Build reverse lookup to convert tickers back to display names
for (const [name, symbol] of Object.entries({ ...NAME_TO_SYMBOL, ...TICKER_MAP })) {
  SYMBOL_TO_NAME[symbol] = SYMBOL_TO_NAME[symbol] || name;
}

function nameToSymbol(name){
  name = normalizeKey(name);
  const learned = lookupLearnedMapping(name);
  if (learned) return learned;

  const dict = NAME_TO_SYMBOL[name] || TICKER_MAP[name];
  if (dict) return dict;

  // Normalize BRK-B / BRK.B / BRK/B styles
  if (/^[A-Z]{1,5}[-/][A-Z]{1,3}$/.test(name)) {
    const [a,b] = name.split(/[-/]/);
    return `${a}.${b}`; // prefer dot form internally
  }
  if (/^[A-Z][A-Z.\-]{0,6}(\.[A-Z]{1,3})?$/.test(name)) return name;
  if (/^\d{6}\.K[QS]$/.test(name)) return name;
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

Object.assign(NAVER_SEED_KEYWORDS, {
  NVDA: ['엔비디아', 'HBM', '지포스', '엔비디아 주가'],
  AMZN: ['아마존', '프라임', '아마존 주가'],
  GOOGL: ['구글', '알파벳', '구글 주가'],
  META: ['메타', '페이스북', '메타 주가'],
});

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

// Try fetching candles with alternate symbol variants
async function getCandlesWithVariants(sym, opts) {
  const tried = new Set();
  const candidates = [sym];
  if (isKR(sym)) candidates.push(toTwelveSymbol(sym));
  else {
    const dash = sym.includes('.') ? sym.replace(/\./g, '-') : null;
    const slsh = sym.includes('.') ? sym.replace(/\./g, '/') : null;
    const dot1 = sym.includes('-') ? sym.replace(/-/g, '.') : null;
    const dot2 = sym.includes('/') ? sym.replace(/\//g, '.') : null;
    for (const c of [dash, slsh, dot1, dot2]) if (c && c !== sym) candidates.push(c);
  }
  for (const c of candidates) {
    if (tried.has(c)) continue;
    tried.add(c);
    try {
      const res = await getCandles(c, opts);
      if (res && Array.isArray(res.c) && res.c.length >= 21) return res;
    } catch (_) {}
  }
  return null;
}


const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || (DEMO_MODE ? 5000 : 8000));
const RETRIES = Number(process.env.RETRIES || (DEMO_MODE ? 1 : 3));
const BACKOFF_BASE_MS = Number(process.env.BACKOFF_BASE_MS || (DEMO_MODE ? 400 : 600));

async function getJSON(url, headers = {}, retries = RETRIES, base = BACKOFF_BASE_MS, ttlMs = TTL_MS) {
  return cachedJsonFetch(url, async (u) => {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (OFFLINE || circuitOpen()) {
        throw new Error('offline/circuit-open; fetch suppressed');
      }
      if (!budgetOk()) throw new Error('global budget exhausted');
      const controller = new AbortController();
      const perReq = Math.min(REQ_TIMEOUT_MS, timeLeft());
      const timer = setTimeout(() => controller.abort(), perReq);
      try {
        const res = await fetch(u, { headers, signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        resetErrors();
        return await safeParseBody(res);
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (tripOnError(e)) throw lastErr;
        if (attempt < retries && budgetOk() && !circuitOpen()) {
          const jitter = 0.2 + Math.random() * 0.6;
          const backoff = Math.floor(base * Math.pow(2, attempt) * jitter);
          const redacted = u.replace(/token=[^&]+/i, 'token=***').replace(/apikey=[^&]+/i, 'apikey=***');
          console.log(`[net] retry ${attempt + 1}/${retries} in ${backoff}ms :: ${redacted}`);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
        break;
      }
    }
    throw lastErr;
  }, ttlMs, OFFLINE || circuitOpen());
}

async function writeAtomic(p, data) {
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, p);
}

async function loadJson(p, fallback=null) {
  try { return JSON.parse(await fsp.readFile(p,'utf8')); } catch { return fallback; }
}

function rank01(values) {
  // values: array of numbers (may include null). Nulls -> 0.5, all equal -> 0.5
  const arr = values.map(v => (Number.isFinite(v) ? v : null));
  const nums = arr.filter(v => v !== null);
  if (nums.length === 0) return values.map(_ => 0.5);
  const min = Math.min(...nums), max = Math.max(...nums);
  if (min === max) return values.map(() => 0.5);
  return arr.map(v => (v === null ? 0.5 : (v - min) / (max - min)));
}

function safeRank01(arr){
  return rank01(arr);
}

// helper: percentiles from a name->value map (values in 0..1)
function percentileMap(obj){
  const entries = Object.entries(obj).filter(([_,v])=>Number.isFinite(v));
  entries.sort((a,b)=>a[1]-b[1]);
  const n = Math.max(1, entries.length-1);
  const out = {};
  entries.forEach(([k],i)=>{ out[k] = n>0 ? i / n : 0.5; });
  for (const k of Object.keys(obj)) {
    if (!Number.isFinite(obj[k])) out[k] = 0.5;
  }
  return out;
}

function bucketRelative(names, byName, getter){
  const buckets = {};
  for (const n of names){
    const sector = byName[n].sector || 'UNKNOWN';
    const size = byName[n].marketCap ?? byName[n].adv20;
    let bucketSize = 'U';
    if (Number.isFinite(size)) {
      if (size < 2e9) bucketSize = 'S';
      else if (size < 1e11) bucketSize = 'M';
      else bucketSize = 'L';
    }
    const key = `${sector}|${bucketSize}`;
    (buckets[key] ||= []).push({ n, v: getter(n) });
  }
  const out = {};
  for (const arr of Object.values(buckets)){
    const vals = arr.map(o=>Number.isFinite(o.v)?o.v:null);
    const ranks = safeRank01(vals);
    arr.forEach((o,i)=>{ out[o.n] = ranks[i]; });
  }
  return out;
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function scaleAdjust(x){
  return Number.isFinite(x) && x > 0 ? x * Math.log10(1 + x) : 0;
}

function djitter(key, mag=0.01){
  let h=0; for (let i=0;i<key.length;i++) h=(h*131+key.charCodeAt(i))|0;
  return ((h % 2001) - 1000) / 1000 * mag;
}

function stripNulls(o){ return JSON.parse(JSON.stringify(o, (_,v)=>v===null?undefined:v)); }

function scoreSentiment(s){
  if (s == null) return null;
  if (s >= 0.5) return 5;
  if (s >= 0.2) return 4;
  if (s > -0.2) return 3;
  if (s > -0.5) return 2;
  return 1;
}

// === Sensitivity knobs (env) ===
const TREND_T5 = +process.env.TREND_T5 || 0.30;
const TREND_T4 = +process.env.TREND_T4 || 0.12;
const TREND_T3 = +process.env.TREND_T3 || 0.03;
const TREND_T2 = +process.env.TREND_T2 || -0.12;

const NEWS_T5  = +process.env.NEWS_T5  || 1.00;  // growth >= 100%
const NEWS_T4  = +process.env.NEWS_T4  || 0.50;  // >= 50%
const NEWS_T3  = +process.env.NEWS_T3  || 0.10;  // >= 10%
const NEWS_T2  = +process.env.NEWS_T2  || -0.30; // > -30%

function scoreNewsMomentum(cur, prev){
  if (cur === 0 && prev === 0) return 3;
  if (prev === 0) return cur > 0 ? 5 : 3;
  const g = (cur - prev) / Math.max(prev, 1);
  if (g >= NEWS_T5) return 5;
  if (g >= NEWS_T4) return 4;
  if (g >= NEWS_T3) return 3;
  if (g >  NEWS_T2) return 2;
  return 1;
}

function computeTrendMomentum(nf, prev) {
  if (typeof nf?.naverSpike === 'number') return nf.naverSpike;
  if (typeof nf?.naverAsvi === 'number' && typeof prev?.naverAsvi === 'number') {
    const base = Math.max(prev.naverAsvi, 1e-6);
    return (nf.naverAsvi - prev.naverAsvi) / base;
  }
  return 0;
}

function scoreTrend(g){
  if (!Number.isFinite(g)) return null;
  if (g >= TREND_T5) return 5;
  if (g >= TREND_T4) return 4;
  if (g >= TREND_T3) return 3;
  if (g >  TREND_T2) return 2;
  return 1;
}

function scoreCredibility(r){
  if (r == null) return null;
  const x = r > 1 ? r / 100 : r;
  if (x >= 0.70) return 5;
  if (x >= 0.55) return 4;
  if (x >= 0.40) return 3;
  if (x >= 0.25) return 2;
  return 1;
}

const CATALYST_DICT = [
  ['earnings', /earnings beat|eps beat|guidance raise|upgraded|target hike|실적(?: 호조| 개선| 서프라이즈)|가이던스(?: 상향| 상향조정)/i],
  ['contract', /contract win|joint venture|JV|partnership|MOU|제휴|협력|계약|수주|공급|납품/i],
  ['approval', /fda approval|approval|license|승인|허가|인가|인증/i],
  ['product', /product launch|feature launch|pilot|expansion|출시|런칭|신제품|파일럿|확장/i],
  ['capital', /hiring plan|buyback|dividend increase|자사주 매입|배당(?: 증액)?|채용 계획|고용 계획/i]
];

function scoreCatalysts(keywords){
  const kw = (keywords || []).map(k => k.toLowerCase());
  const found = new Set();
  for (const [cat, re] of CATALYST_DICT){
    if (kw.some(k => re.test(k))) found.add(cat);
  }
  const cnt = found.size;
  if (cnt >= 4) return 5;
  if (cnt === 3) return 4;
  if (cnt === 2) return 3;
  if (cnt === 1) return 2;
  return 1;
}

const RISK_SEVERE = [/investigation|regulator probe|sec\b|공정위|금감원|검찰|수사|data breach|해킹|accounting|회계부정|restatement|리콜|상장폐지|delisting/i];
const RISK_MODERATE = [/lawsuit|소송|downgrade|하향|strike|파업|short[- ]seller|공매도|guidance cut|감익|layoff|구조조정|벌금|과징금|fine|영업정지/i];

function scoreRisk(keywords){
  const kw = (keywords || []).map(k => k.toLowerCase());
  let pts = 0;
  for (const re of RISK_SEVERE){ if (kw.some(k => re.test(k))) pts += 2; }
  for (const re of RISK_MODERATE){ if (kw.some(k => re.test(k))) pts += 1; }
  if (pts === 0) return 5;
  if (pts === 1) return 4;
  if (pts === 2) return 3;
  if (pts <= 4) return 2;
  return 1;
}

function combineScore(components){
  const avail = components.filter(c => c.score != null);
  const weightSum = avail.reduce((s,c)=>s+c.weight,0);
  if (weightSum === 0) return 0;
  const subtotal = avail.reduce((s,c)=>s+(c.score/5)*c.weight,0);
  return subtotal * (100/weightSum);
}

function namesOnlyRank(universe, features) {
  const out = {};
  for (const m of MARKETS) {
    const names = universe[m] || [];
    const total = names.length;
    const kSafe = Math.min(8, Math.ceil(total * 0.7));
    const kAggr = Math.min(4, Math.max(0, total - kSafe));

    const scored = names.map(n => {
      const sym = nameToSymbol(n) || n;
      rememberMapping(n, sym);
      const nf = features[sym] || {};
      const newsScore = newsScoreFromFeatures(nf);
      const sentiment = ((nf.sentiment ?? 0) + 1) / 2;
      const pop = nf.naverPopularity ?? 0;
      const trendBoost = (typeof nf.polygonTrend === 'number' ? clamp01(nf.polygonTrend) * 0.05 : 0);
      const nasdaqBoost = nf.nasdaqClose != null ? 0.02 : 0;
      const score = newsScore * 0.12 + (sentiment - 0.5) * 0.08 + (/\.K[QS]$/.test(sym) ? pop * 0.20 : 0) + trendBoost + nasdaqBoost;
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

async function finnhubEarningsWindowSet() {
  const from = todayYMD(-10), to = todayYMD(+10);
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${FINNHUB}`;
  const j = await getJSON(url, {}, RETRIES, BACKOFF_BASE_MS, 1000*60*60*4)
    .then(d => { bump('finnhub', true); return d; })
    .catch(() => { bump('finnhub', false); return null; });
  const rows = j?.earningsCalendar || [];
  const set = new Set(rows.map(x => (x.symbol || x.ticker)).filter(Boolean));
  return set;
}

// Finnhub earnings window ±10d
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
    return [m.ret5, m.ret20, m.vol20, m.turnover].some(x => Number.isFinite(x)) || m.newsScore > 0 || m.newsCount > 0 || m.earn === true;
  }).length;
  return ok / vals.length;
}

// ------- Simple helpers -------
function nz(x, def = 0) { return Number.isFinite(x) ? x : def; }

function sanitizeSignals(row) {
  row.newsCount       = nz(row.newsCount, 0);
  row.newsScore       = nz(row.newsScore, 0);
  row.sentiment       = Number.isFinite(row.sentiment) ? row.sentiment : 0;
  row.blogMentions    = nz(row.blogMentions, 0);
  row.naverPopularity = nz(row.naverPopularity, 0);
  row.naverAsvi       = nz(row.naverAsvi, 0);
  row.naverSpike      = nz(row.naverSpike, 0);
  row.naverCount      = nz(row.naverCount, 0);
  row.naverCountKO    = nz(row.naverCountKO, 0);
  row.naverCountEN    = nz(row.naverCountEN, 0);
  row.wikiViews       = nz(row.wikiViews, 0);
  row.wikiScore       = nz(row.wikiScore, 0);
  row.reputationScore = Number.isFinite(row.reputationScore) ? row.reputationScore : 0.5;
  row.ret5            = Number.isFinite(row.ret5) ? row.ret5 : 0;
  row.ret20           = Number.isFinite(row.ret20) ? row.ret20 : 0;
  row.turnover        = Number.isFinite(row.turnover) ? row.turnover : 0;
  return row;
}

function carryForwardIfEmpty(byName, n, market){
  const prev = PREV_METRICS?.[market]?.[n];
  if (!prev) return;
  const fields = ['ret5','ret20','turnover','newsCount','newsScore','sentiment','naverPopularity','naverAsvi','naverSpike'];
  for (const f of fields){
    const cur = byName[n][f];
    if (!Number.isFinite(cur) || cur === 0){
      const pv = prev[f];
      if (Number.isFinite(pv)) byName[n][f] = pv * PREV_CARRY;
    }
  }
}

function sectorMedians(names, byName){
  const fields = ['sentiment','newsCount','newsScore','naverPopularity','ret5','ret20','turnover'];
  const buckets = new Map();
  for (const n of names){
    const s = byName[n].sector || 'UNKNOWN';
    if (!buckets.has(s)) buckets.set(s, {});
    const b = buckets.get(s);
    for (const f of fields){
      const v = byName[n][f];
      if (Number.isFinite(v)) (b[f] ||= []).push(v);
    }
  }
  const med = {};
  for (const [s,b] of buckets){
    med[s] = {};
    for (const [f, arr] of Object.entries(b)){
      arr.sort((a,b)=>a-b);
      med[s][f] = arr.length ? arr[Math.floor(arr.length/2)] : 0;
    }
  }
  return med;
}

// % off 52w high / low
function pctOffHiLo(c){
  if (!Array.isArray(c) || c.length < 20) return { offHi:0, offLo:0 };
  const lo = Math.min(...c), hi = Math.max(...c), last = c[c.length-1];
  return { offHi: (hi-last)/Math.max(1e-6, hi), offLo: (last-lo)/Math.max(1e-6, hi) };
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
  const hasFinnhub = !!process.env.FINNHUB_API_KEY;
  const hasTwelve  = !!process.env.TWELVEDATA_API_KEY;
  const hasFmp     = !!process.env.FMP_KEY;
  const hasNewsData = !!process.env.NEWSDATA_API_KEY;

  console.log(`[buildPools] start :: FINNHUB=${hasFinnhub} TWELVE=${hasTwelve} FMP=${hasFmp} NEWSDATA=${hasNewsData} OFFLINE=${!!process.env.OFFLINE} DEMO=${!!process.env.DEMO} budget=${process.env.GLOBAL_BUDGET_MS||'n/a'}ms`);

  // Ensure pools object has entries for all markets
  for (const m of MARKETS) {
    if (!pools[m]) pools[m] = { safe: [], aggressive: [] };
  }

  const feedback = await loadJson(FEEDBACK_FILE, { version:1, weights:{}, decay:{ half_life_days:14, last_decay_ts:null }});
  const metricsOut = {};
  const marketCoverage = {};

  const universe = OFFLINE
    ? Object.fromEntries(MARKETS.map(m => [m, Array.from(new Set([...(pools[m]?.safe || []), ...(pools[m]?.aggressive || [])]))]))
    : await buildUniverse(pools, { limitPerMarket: Number(process.env.UNIVERSE_LIMIT || 9999) });

  universe['S&P 500']    = mergeIndexNames(universe['S&P 500'], SP500);
  universe['NASDAQ 100'] = mergeIndexNames(universe['NASDAQ 100'], N100);
  universe.KOSPI  = mergeIndexNames(universe.KOSPI, K200);
  universe.KOSDAQ = mergeIndexNames(universe.KOSDAQ, KQ100);

  const symbolSet = new Set();
  for (const [market, names] of Object.entries(universe)) {
    let count = 0;
    for (const raw of names) {
      const m = mapOne(raw);
      if (m && m.sym) {
        rememberMapping(m.raw, m.sym);
        symbolSet.add(m.sym);
        count++;
      } else {
        const fb = fallbackSymbolFromRaw(raw);
        if (fb) {
          rememberMapping(raw, fb);
          symbolSet.add(fb);
          count++;
        } else {
          const learned = lookupLearnedMapping(raw);
          if (!learned) {
            const hex = [...String(raw)].map(c=>c.charCodeAt(0).toString(16)).join(' ');
            console.warn('[universe] unmapped:', raw, 'hex=', hex);
          }
        }
      }
    }
    if (count === 0) {
      console.warn(`[buildPools] no valid ${market} symbols after mapping`);
    }
  }
  const symbols = Array.from(symbolSet);

  // Prefetch a single earnings window set for US tickers
  let EARNINGS_SET = null;
  if (!OFFLINE && FINNHUB) {
    try {
      EARNINGS_SET = await finnhubEarningsWindowSet();
    } catch {
      EARNINGS_SET = null;
    }
  }

  let KEYWORDS = { ...NAVER_SEED_KEYWORDS };
  if (!OFFLINE) {
    const NEWS_MAX = Number(process.env.NEWS_MAX_SYMBOLS || 80);
    const kr = symbols.filter(isKR);
    const us = symbols.filter(s => !isKR(s));
    const newsSymbols = kr.concat(us).slice(0, NEWS_MAX);
    NEWS_FEATURES = timeLeft() > GLOBAL_BUDGET_MS * 0.6
      ? await enrichWithNewsFeatures(newsSymbols, { symbolToName: SYMBOL_TO_NAME, keywords: KEYWORDS })
      : {};
  }

  // now build keywords using up-to-date features
  KEYWORDS = await buildKeywordDict({
    symbols,
    seeds: NAVER_SEED_KEYWORDS,
    symbolToName: SYMBOL_TO_NAME,
    newsFeatures: NEWS_FEATURES,
    addKoreanForUSTickers: process.env.ADD_KO_FOR_US !== '0',
  });

  for (const sym of symbols){
    if (!KEYWORDS[sym] || KEYWORDS[sym].length === 0){
      const nm = SYMBOL_TO_NAME[sym] || sym;
      KEYWORDS[sym] = [nm, sym, `${nm} 주가`].filter(Boolean);
    }
  }

  try {
    await fsp.mkdir('data', { recursive: true });
    await fsp.writeFile('data/naver-keywords.json', JSON.stringify(KEYWORDS, null, 2));
  } catch {}

  if (!OFFLINE) {
    const NAVER_TRENDS = await enrichWithNaverTrends(universe, KEYWORDS);
    for (const [k, v] of Object.entries(NAVER_TRENDS)) {
      NEWS_FEATURES[k] = { ...(NEWS_FEATURES[k] || {}), ...v };
      // If news providers were throttled (count = 0) but NAVER shows interest,
      // synthesize a minimal newsCount so coverage can count this symbol.
      const cur = NEWS_FEATURES[k];
      if ((cur.count == null || cur.count === 0) && typeof cur.naverPopularity === 'number') {
        if (cur.naverPopularity > 0.05 || cur.naverSpike > 0.0) {
          cur.count = Math.max(1, Math.round(cur.naverPopularity * 5));
        }
      }
    }
  }
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
    const processed = new Set();
    await mapLimit(names, Math.max(1, Math.min(MAX_CONCURRENCY, DEMO_MODE ? 2 : MAX_CONCURRENCY)), async (name) => {
      if (timeLeft() < GLOBAL_BUDGET_MS * FINAL_FRAC) return; // leave final budget
      if (!budgetOk(800)) return; // skip if no time left
      const mappedOne = OFFLINE ? null : mapOne(name);
      if (!mappedOne || !mappedOne.sym) {
        console.warn('[map] skip (no symbol):', name);
        rememberMapping(name, null);
        byName[name] = { ret5:null, ret20:null, vol20:null, turnover:null, adv20:null, close:null, newsCount:0, weightedCount:0, newsScore:0, sentiment:null, naverPopularity:0, blogMentions:0, earn:false, offHi:0, offLo:0, sym:null, source:null, attempts:[], fetchMs:0, ds_news7:0, ds_burst:0, ds_slope7:0, ds_topic:0, ds_trend:0, posHits:0, negHits:0, fmpNewsCount:0, googleNewsCount:0, yahooNewsCount:0, investingNewsCount:0, hanwhaNewsCount:0, wikiViews:0, wikiScore:0 };
        sanitizeSignals(byName[name]);
        return;
      }
      const sym = mappedOne.sym;
      rememberMapping(name, sym);

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
      log(`[buildPools] ${market} :: ${name} ${route}${routeDetail}`);

      let ret5=null, ret20=null, vol20=null, turnover=null, adv20=null, close=null;
      let newsCount=0, weightedCount=0, newsScore=0, sentiment=null;
      let naverPopularity=0, naverAsvi=null, naverSpike=null;
      let naverCount=0, naverCountKO=0, naverCountEN=0;
      let blogMentions=0, polygonTrend=null, nasdaqClose=null, earn=false;
      let candles=null, offHi=0, offLo=0, posHits=0, negHits=0, marketCap=null;
      let fmpNewsCount=0, googleNewsCount=0, yahooNewsCount=0, investingNewsCount=0, hanwhaNewsCount=0;
      let wikiViews=0;
      try {
        const countsBefore = Object.fromEntries(Object.entries(providerState).map(([p,s])=>[p, s.count||0]));
        candles = (sym && budgetOk(REQ_TIMEOUT_MS) && !circuitOpen())
          ? await getCandlesWithVariants(
              sym,
              { cacheTtlMs: CACHE_TTL_MS, cooloffMs: COOLOFF_MS, maxPerProvider: MAX_PER_PROVIDER }
            ).catch(e => { tripOnError(e); return null; })
          : null;
        if (candles?.source) {
          bump(candles.source, true);
        } else {
          const countsAfter = Object.fromEntries(Object.entries(providerState).map(([p,s])=>[p, s.count||0]));
          for (const [p, after] of Object.entries(countsAfter)) {
            if (after > countsBefore[p]) bump(p, false);
          }
        }
        if (candles && Array.isArray(candles.c) && Array.isArray(candles.v)) {
          const m = computeMetrics(candles.c, candles.v);
          ret5 = m.ret5; ret20 = m.ret20; vol20 = m.vol20; turnover = m.turnover; adv20 = m.adv20; close = m.close;
          const shp = pctOffHiLo(candles.c);
          offHi = shp.offHi; offLo = shp.offLo;
        }
        const nf = NEWS_FEATURES[sym] || NEWS_FEATURES[name];
        if (nf) {
          newsCount = nf.count || 0;
          weightedCount = typeof nf.weightedCount === 'number' ? nf.weightedCount : newsCount;
          naverCount = typeof nf.naverCount === 'number' ? nf.naverCount : 0;
          naverCountKO = typeof nf.naverCountKO === 'number' ? nf.naverCountKO : 0;
          naverCountEN = typeof nf.naverCountEN === 'number' ? nf.naverCountEN : 0;
          newsScore = newsScoreFromFeatures(nf);
          sentiment = typeof nf.sentiment === 'number' ? nf.sentiment : null;
          naverPopularity = typeof nf.naverPopularity === 'number' ? nf.naverPopularity : 0;
          blogMentions = typeof nf.blogMentions === 'number' ? nf.blogMentions : 0;
          if (typeof nf.polygonTrend === 'number') polygonTrend = nf.polygonTrend;
          if (typeof nf.nasdaqClose === 'number') nasdaqClose = nf.nasdaqClose;
          if (typeof nf.naverAsvi === 'number') naverAsvi = nf.naverAsvi;
          if (typeof nf.naverSpike === 'number') naverSpike = nf.naverSpike;
          if (typeof nf.posHits === 'number') posHits = nf.posHits;
          if (typeof nf.negHits === 'number') negHits = nf.negHits;
          if (typeof nf.marketCap === 'number') marketCap = nf.marketCap;
        }
        fmpNewsCount = await fetchFmpNewsCount(sym);
        googleNewsCount = await fetchGoogleNewsCount(sym);
        yahooNewsCount = await fetchYahooNewsCount(sym);
        investingNewsCount = await fetchInvestingNewsCount(sym);
        hanwhaNewsCount = await fetchHanwhaNewsCount(sym);
        wikiViews = await fetchWikiPageviews(name);
        earn = !!(EARNINGS_SET && sym && isUS(sym) && EARNINGS_SET.has(sym));
      } catch (e) {
        tripOnError(e);
      }
      byName[name] = { ret5, ret20, vol20, turnover, adv20, close, newsCount, weightedCount, newsScore, sentiment, naverPopularity, naverAsvi, naverSpike, naverCount, naverCountKO, naverCountEN, blogMentions, polygonTrend, nasdaqClose, earn, offHi, offLo, marketCap, reputationScore: null, topKeywords: [], reputationHitIds: [], sym: sym || null, source: candles?.source || null, attempts: candles?.attempts || [], fetchMs: candles?.fetchMs || 0, ds_news7:0, ds_burst:0, ds_slope7:0, ds_topic:0, ds_trend:0, posHits, negHits, fmpNewsCount, googleNewsCount, yahooNewsCount, investingNewsCount, hanwhaNewsCount, wikiViews, wikiScore:0 };
      try {
        const ds = await fetchDeepsearchFeatures({ name, ticker: sym, market });
        Object.assign(byName[name], ds);
      } catch (e) {
        Object.assign(byName[name], { ds_news7:0, ds_burst:0, ds_slope7:0, ds_topic:0, ds_trend:0 });
      }
      sanitizeSignals(byName[name]);
      if (sym && (Number.isFinite(close) || Number.isFinite(adv20) || newsCount > 0)) {
        confirmMapping(name, sym);
      }
      processed.add(name);
    });
    for (const n of names) {
      if (!byName[n]) {
        byName[n] = {
          ret5:null, ret20:null, vol20:null, turnover:null, adv20:null, close:null,
          newsCount:0, weightedCount:0, newsScore:0, sentiment:null, naverPopularity:0, naverAsvi:null, naverSpike:null, naverCount:0, naverCountKO:0, naverCountEN:0, blogMentions:0, polygonTrend:null, nasdaqClose:null, earn:false, offHi:0, offLo:0,
          reputationScore:null, topKeywords:[], reputationHitIds:[],
          sym:null, source:null, attempts:[], fetchMs:0,
          ds_news7:0, ds_burst:0, ds_slope7:0, ds_topic:0, ds_trend:0, posHits:0, negHits:0, fmpNewsCount:0, googleNewsCount:0, yahooNewsCount:0, investingNewsCount:0, hanwhaNewsCount:0, wikiViews:0, wikiScore:0
        };
      }
      const sym = byName[n].sym || nameToSymbol(n) || n;
      const nf = NEWS_FEATURES[sym] || NEWS_FEATURES[n];
      if (nf) {
        byName[n].newsCount       = nf.count ?? byName[n].newsCount;
        byName[n].weightedCount   = nf.weightedCount ?? byName[n].weightedCount;
        byName[n].newsScore       = newsScoreFromFeatures(nf) ?? byName[n].newsScore;
        byName[n].sentiment       = (typeof nf.sentiment === 'number' ? nf.sentiment : byName[n].sentiment);
        byName[n].naverPopularity = nf.naverPopularity ?? byName[n].naverPopularity;
        byName[n].naverAsvi       = nf.naverAsvi ?? byName[n].naverAsvi;
        byName[n].naverSpike      = nf.naverSpike ?? byName[n].naverSpike;
        byName[n].naverCount      = nf.naverCount ?? byName[n].naverCount;
        byName[n].naverCountKO    = nf.naverCountKO ?? byName[n].naverCountKO;
        byName[n].naverCountEN    = nf.naverCountEN ?? byName[n].naverCountEN;
        byName[n].blogMentions    = nf.blogMentions ?? byName[n].blogMentions;
        byName[n].polygonTrend    = nf.polygonTrend ?? byName[n].polygonTrend;
        byName[n].nasdaqClose     = nf.nasdaqClose ?? byName[n].nasdaqClose;
        byName[n].reputationScore = nf.reputationScore ?? byName[n].reputationScore;
        byName[n].topKeywords     = nf.topKeywords ?? byName[n].topKeywords;
        byName[n].reputationHitIds = nf.reputationHitIds ?? byName[n].reputationHitIds;
        byName[n].posHits         = nf.posHits ?? byName[n].posHits;
        byName[n].negHits         = nf.negHits ?? byName[n].negHits;
        byName[n].yahooNewsCount  = nf.yahooNewsCount ?? byName[n].yahooNewsCount;
        byName[n].investingNewsCount = nf.investingNewsCount ?? byName[n].investingNewsCount;
        byName[n].hanwhaNewsCount = nf.hanwhaNewsCount ?? byName[n].hanwhaNewsCount;
        if (typeof nf.marketCap === 'number') byName[n].marketCap = nf.marketCap;
      }
    }

    const med = sectorMedians(names, byName);
    const IMPUTE = +process.env.SECTOR_IMPUTE || 0.6;
    for (const n of names){
      carryForwardIfEmpty(byName, n, market);
      const s = byName[n].sector || 'UNKNOWN';
      const m = med[s] || {};
      if (!Number.isFinite(byName[n].sentiment))       byName[n].sentiment       = (m.sentiment ?? 0) * IMPUTE;
      if (!Number.isFinite(byName[n].newsCount))       byName[n].newsCount       = (m.newsCount ?? 0) * IMPUTE;
      if (!Number.isFinite(byName[n].newsScore))       byName[n].newsScore       = (m.newsScore ?? 0) * IMPUTE;
      if (!Number.isFinite(byName[n].naverPopularity)) byName[n].naverPopularity = (m.naverPopularity ?? 0) * (IMPUTE*0.7);
      if (!Number.isFinite(byName[n].ret5))            byName[n].ret5            = (m.ret5 ?? 0) * (IMPUTE*0.8);
      if (!Number.isFinite(byName[n].ret20))           byName[n].ret20           = (m.ret20 ?? 0) * (IMPUTE*0.8);
      if (!Number.isFinite(byName[n].turnover))        byName[n].turnover        = (m.turnover ?? 0) * (IMPUTE*0.7);
      sanitizeSignals(byName[n]);
    }

    const withSignals = [...processed].filter(n => {
      const m = byName[n];
      return [m.ret5, m.ret20, m.vol20, m.turnover].some(Number.isFinite) || m.newsScore > 0 || m.earn;
    }).length;
    console.log(`[metrics] ${market} processed=${processed.size}/${names.length} withSignals=${withSignals}`);

    // Eligibility flags (for *ranking*, not for whether we score)
    const eligibility = {};
    names.forEach(n => {
      const m = byName[n] || {};
      const sym = m.sym;
      const isKRName = sym ? isKR(sym) : false;
      const advKnown   = Number.isFinite(m.adv20);
      const priceKnown = Number.isFinite(m.close);
      const advOk   = advKnown   && (m.adv20 >= (isKRName ? MIN_ADV_KR : MIN_ADV_US) || (sym && ALLOWLIST.has(sym)));
      const priceOk = priceKnown && (m.close >= (isKRName ? MIN_PRICE_KRW : MIN_PRICE_USD));
      eligibility[n] = { advOk, priceOk, advKnown, priceKnown, eligible: (advOk && priceOk) };
    });

    // Scores for *all* names based on blogs, news articles, popularity and keywords
    const scoreSafeRaw = {};
    const scoreAggrRaw = {};
    const popRaw = names.map(n => {
      const nf = byName[n];
      const sym = nf.sym || nameToSymbol(n) || n;
      const mcap = nf.marketCap ?? INDEX_MARKETCAP[normIndexKey(sym)] ?? 0;
      nf.marketCap = mcap;
      const blog   = nf.blogMentions   || 0;
      const news   = nf.newsCount      || 0;
      const fmp    = nf.fmpNewsCount   || 0;
      const goog   = nf.googleNewsCount|| 0;
      const yahoo  = nf.yahooNewsCount || 0;
      const invest = nf.investingNewsCount || 0;
      const hanwha = nf.hanwhaNewsCount || 0;
      const pop    = nf.naverPopularity|| 0;
      const posK   = nf.posHits        || 0;
      const negK   = nf.negHits        || 0;
      const wiki   = byName[n].wikiViews || 0;
      const newsSum = news + fmp + goog + yahoo + invest + hanwha;
      const materiality = (nf.contractValue && mcap)
        ? nf.contractValue / mcap
        : 0;
      nf.componentScores = {
        blogs: blog,
        news: newsSum,
        popularity: pop,
        wikiViews: wiki,
        posKeywords: posK,
        negKeywords: negK,
        materiality,
        scale: mcap || 0,
      };
      return NEWS_WEIGHT*scaleAdjust(newsSum) +
             BLOG_WEIGHT*scaleAdjust(blog) +
             POPULARITY_WEIGHT*scaleAdjust(pop) +
             WIKI_WEIGHT*scaleAdjust(wiki) +
             POS_KW_WEIGHT*posK +
             NEG_KW_WEIGHT*negK +
             materiality;
    });
    const scaleRaw = names.map(n => {
      const sym = byName[n].sym || nameToSymbol(n) || n;
      const mcap = byName[n].marketCap ?? INDEX_MARKETCAP[normIndexKey(sym)] ?? 0;
      return scaleAdjust(mcap);
    });
    const popArr = safeRank01(popRaw);
    const scaleArr = safeRank01(scaleRaw);
    const popularity01 = Object.fromEntries(names.map((n, i) => [n, popArr[i]]));

    names.forEach((n, i) => {
      const p01 = popArr[i];
      const s01 = scaleArr[i];
      const total01 = (1 - SCALE_WEIGHT) * p01 + SCALE_WEIGHT * s01;
      byName[n].prevNewsScore = PREV_METRICS?.[market]?.[n]?.newsScore || 0;
      byName[n].totalScore    = Math.round(total01 * 100);
      byName[n].componentScores = (NEWS_FEATURES[byName[n].sym || nameToSymbol(n) || n] || {}).componentScores;
      scoreSafeRaw[n] = total01;
      scoreAggrRaw[n] = total01;
    });

    // Apply feedback nudges
    const scoreSafe = applyFeedback(scoreSafeRaw, feedback, market);
    const scoreAggr = applyFeedback(scoreAggrRaw, feedback, market);

    // -------- Small overlap penalty for later U.S. markets ----------
    // If this is NASDAQ 100, penalize names that already appear in S&P 500 SAFE
    if (market === 'NASDAQ 100' && USED['S&P 500']?.safe?.length) {
      const earlierSafeNames = USED['S&P 500'].safe;
      const earlierSafeSyms = new Set(
        earlierSafeNames.map(n => { const s = nameToSymbol(n) || n; rememberMapping(n, s); return s; })
      );
      for (const n of Object.keys(scoreSafe)) {
        const sym = nameToSymbol(n) || n; rememberMapping(n, sym);
        if (earlierSafeSyms.has(sym)) {
          // clamp01 handles floor/ceil
          scoreSafe[n] = clamp01(scoreSafe[n] - 0.15);
          scoreAggr[n] = clamp01(scoreAggr[n] - 0.10);
        }
      }
    }

    // ---- Per-market calibration: curve & widen spread ----
    const AUTO_CURVE = process.env.AUTO_CURVE !== '0';
    let GAMMA = Number(process.env.SCORE_CURVE || 0.62); // <1 boosts the head
    const FLOOR = Number(process.env.SCORE_FLOOR || 0); // allow full 0-100 range
    const CEIL  = Number(process.env.SCORE_CEIL  || 100);

    if (AUTO_CURVE) {
      const vals = Object.values(scoreSafeRaw);
      const spread = Math.max(...vals) - Math.min(...vals);
      if (spread < 0.15) GAMMA = Math.max(0.55, GAMMA - 0.05);
    }

    const pSafe = percentileMap(scoreSafe);   // 0..1 by rank within market
    const pAggr = percentileMap(scoreAggr);

    for (const n of names) {
      // same curve for both buckets; ordering preserved
      const curved = Math.pow(pSafe[n], GAMMA);
      scoreSafe[n] = curved;
      scoreAggr[n] = Math.pow(pAggr[n], GAMMA);
      // store human-facing 0..100 with floor/ceiling
      byName[n].totalScore = Math.round(FLOOR + (CEIL - FLOOR) * curved);
    }

    // Optional: hotness boost — disabled with HOTNESS_WEIGHT=0
    const HOT   = +process.env.HOTNESS_WEIGHT || 8;
    const LIQ_W = +process.env.LIQ_WEIGHT || 1;
    const EARN_BOOST = +process.env.EARNINGS_BOOST || 0.02; // +4% of 0..1 scale
    if (HOT > 0 || LIQ_W > 0) {
      const newsRel  = bucketRelative(names, byName, n => (byName[n].ds_news7 ?? byName[n].newsScore ?? 0));
      const trendRel = bucketRelative(names, byName, n => (byName[n].ds_trend  ?? computeTrendMomentum(byName[n], PREV_METRICS?.[market]?.[n]) ?? 0));
      const wikiRel  = bucketRelative(names, byName, n => (byName[n].wikiViews || 0));
      const asArr = fn => names.map(fn);
      const newsRaw  = names.map(n => newsRel[n]);
      const trendRaw = names.map(n => trendRel[n]);
      const wikiRaw  = names.map(n => wikiRel[n]);

      const newsP  = safeRank01(newsRaw);
      const trendP = safeRank01(trendRaw.map(v => Math.max(0, v)));
      const wikiP  = safeRank01(wikiRaw);
      const turnP  = safeRank01(asArr(n => (byName[n].turnover ?? 0)));
      const liqP   = names.map(n => structuralPrior(byName[n].sym || nameToSymbol(n) || n));

      names.forEach((n,i)=>{ byName[n].wikiScore = wikiP[i]; });

      const hot01 = names.map((n,i) => (
        HOT_W_NEWS*newsP[i] +
        HOT_W_TREND*Math.pow(trendP[i], TREND_EXP) +
        HOT_W_TURN*turnP[i] +
        HOT_W_WIKI*wikiP[i]
      ));

      const burstKick = names.map(n =>
        Math.min(BURST_KICK_MAX, BURST_KICK_SCALE * (byName[n].ds_burst || 0))
      );

      for (let i=0; i<names.length; i++) {
        const n = names[i];
        const bumpHot = (HOT/100) * hot01[i] + burstKick[i];
        const bumpLiq = (LIQ_W/100) * liqP[i];
        const earnSafe = byName[n].earn ? EARN_BOOST : 0;
        const earnAggr = byName[n].earn ? EARN_BOOST*0.8 : 0;
        scoreSafe[n] = clamp01(scoreSafe[n] + bumpHot + bumpLiq + earnSafe);
        scoreAggr[n] = clamp01(scoreAggr[n] + bumpHot*1.15 + bumpLiq + earnAggr);
        byName[n].totalScore = Math.min(100, Math.round(FLOOR + (CEIL - FLOOR) * scoreSafe[n]));
      }

      const SECTOR_LIFT = +process.env.SECTOR_LIFT || 0.02; // 10% of scale max
      const sectorHot = {};
      const sectorCnt = {};
      names.forEach((n,i)=>{
        const s = pools[market]?.sectorMap?.[n] || byName[n].sector || null;
        const composite = 0.45*newsP[i] + 0.25*trendP[i] + 0.2*Math.max(0, (byName[n].ret5 ?? 0)) + 0.1*wikiP[i];
        if (!s) return;
        if (!sectorHot[s]) { sectorHot[s] = 0; sectorCnt[s] = 0; }
        sectorHot[s] += composite; sectorCnt[s] += 1;
      });
      Object.keys(sectorHot).forEach(s => { sectorHot[s] = sectorCnt[s] ? sectorHot[s]/sectorCnt[s] : 0; });

      names.forEach((n)=>{
        const s = pools[market]?.sectorMap?.[n] || byName[n].sector || null;
        if (!s) return;
        const lift = (sectorHot[s] || 0) * SECTOR_LIFT;  // 0..SECTOR_LIFT
        scoreSafe[n] = clamp01(scoreSafe[n] + lift);
        scoreAggr[n] = clamp01(scoreAggr[n] + lift);
        byName[n].totalScore = Math.min(100, Math.round(FLOOR + (CEIL - FLOOR) * scoreSafe[n]));
      });
    }

    // popularity01 already computed above; no additional popularity premium

    names.forEach(n=>{
      const sym = byName[n].sym || nameToSymbol(n) || n;
      const prior = structuralPrior(sym); // 0..1
      const indivFloor01 = STRUCT_FLOOR_W * prior; // index/size based
      const popFloor01   = (POP_FLOOR_W) * (typeof popularity01?.[n] === 'number' ? popularity01[n] : 0);
      const baseFloor    = Math.min(1, indivFloor01 + popFloor01);
      const floor01      = eligibility[n].eligible ? baseFloor : Math.min(baseFloor, 0.1);
      const floor100     = FLOOR + (CEIL - FLOOR) * floor01;

      byName[n].totalScore = Math.max(floor100, byName[n].totalScore);
      scoreSafe[n]         = Math.max(scoreSafe[n], floor01);
      scoreAggr[n]         = Math.max(scoreAggr[n], floor01 * 0.95);
    });

    // Re-apply eligibility penalties after floors so floors can't mask them
    for (const n of names) {
      const pen = !eligibility[n].eligible
        ? INELIGIBLE_PENALTY
        : ((!eligibility[n].advKnown || !eligibility[n].priceKnown) ? UNKNOWN_PENALTY : 0);
      if (pen > 0) {
        scoreSafe[n] = clamp01(scoreSafe[n] - pen);
        scoreAggr[n] = clamp01(scoreAggr[n] - pen * 0.8);
        byName[n].totalScore = Math.round(FLOOR + (CEIL - FLOOR) * scoreSafe[n]);
      }
    }

    // Popularity cap: if baseline >> today (always-talked-about), shave 2–5%
    names.forEach(n => {
      const baseBig = (PREV_METRICS?.[market]?.[n]?.weightedCount ?? 0) > 30;
      if (baseBig && (byName[n].naverAsvi ?? 0) <= 0.05) {
        scoreSafe[n] = clamp01(scoreSafe[n] - POP_CAP);
        scoreAggr[n] = clamp01(scoreAggr[n] - POP_CAP);
      }
    });

    // Rescale scores to widen spread (0..1)
    const rescale = (map) => {
      const vals = Object.values(map);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const span = max - min;
      if (span > 0) {
        names.forEach(n => { map[n] = (map[n] - min) / span; });
      }
    };
    rescale(scoreSafe);
    rescale(scoreAggr);

    for (const n of names) {
      const j = djitter(n);
      scoreSafe[n] = clamp01(scoreSafe[n] + j);
      scoreAggr[n] = clamp01(scoreAggr[n] + j);
      byName[n].totalScore = Math.round(FLOOR + (CEIL - FLOOR) * scoreSafe[n]);

      byName[n].reasons = byName[n].reasons || {};
      byName[n].reasons.topKeywords = byName[n].reasons.topKeywords || [];
      const sig = (byName[n].reasons.signals = {
        ...(byName[n].reasons.signals || {}),
        news7d:  byName[n].ds_news7  ?? 0,
        burst:   byName[n].ds_burst  ?? 0,
        slope7d: byName[n].ds_slope7 ?? 0,
        topic:   byName[n].ds_topic  ?? 0,
        trend:   byName[n].ds_trend  ?? 0,
      });
      sig.sentiment = sig.sentiment ?? 0;
      sig.blog      = sig.blog      ?? 0;
      sig.naver     = sig.naver     ?? 0;
      byName[n].reasons = stripNulls(byName[n].reasons);
    }
    const scores = names.map(n => byName[n].totalScore);
    const highCount = scores.filter(s => s > 90).length;
    if (highCount > names.length / 2) {
      console.warn(`[score-check] ${market}: ${highCount}/${names.length} stocks scored above 90`);
    }
    const minScore = Math.min(...scores), maxScore = Math.max(...scores);
    console.log(`[score-check] ${market} score range ${minScore}-${maxScore}`);

    // ---- Split into safe/aggressive buckets based on volatility ----
    const total = names.length;
    const aggrCount = Math.min(total, Math.max(5, Math.ceil(total * 0.3)));
    const volSorted = names
      .slice()
      .sort((a, b) => (byName[b].vol20 ?? -Infinity) - (byName[a].vol20 ?? -Infinity));
    const aggrSet = new Set(volSorted.slice(0, aggrCount));
    const safeCandidates = names.filter(n => !aggrSet.has(n));

    const safeSorted = safeCandidates.sort((a,b)=>scoreSafe[b]-scoreSafe[a]);
    const aggrSorted = Array.from(aggrSet).sort((a,b)=>scoreAggr[b]-scoreAggr[a]);

    // Optional cross-market de-dup (keep as-is if you like that behavior)
    const earlierAll = CROSS_MARKET_DEDUP
      ? Object.values(USED).flatMap(u => [...(u.safe||[]), ...(u.aggressive||[])])
      : [];
    const earlierSet = new Set(earlierAll.map(n => { const s = nameToSymbol(n) || n; rememberMapping(n, s); return s; }));

    function filterOutEarlier(list) {
      const out = [];
      const seen = new Set();
      for (const n of list) {
        const sym = nameToSymbol(n) || n; rememberMapping(n, sym);
        if (!earlierSet.has(sym) && !seen.has(sym)) { out.push(n); seen.add(sym); }
      }
      return out;
    }

    const rankedSafe = filterOutEarlier(safeSorted);
    const rankedAggr = filterOutEarlier(aggrSorted);

    pools[market] = { safe: rankedSafe, aggressive: rankedAggr };

    // Record for later markets
    USED[market] = { safe: rankedSafe.slice(), aggressive: rankedAggr.slice() };

    metricsOut[market] = names.reduce((acc, n) => {
      acc[n] = {
        ret5: byName[n].ret5,
        ret20: byName[n].ret20,
        vol20: byName[n].vol20,
        turnover: byName[n].turnover,
        adv20: byName[n].adv20,
        close: byName[n].close,
        newsCount: byName[n].weightedCount ?? byName[n].newsCount,
        newsScore: byName[n].newsScore,
        prevNewsScore: byName[n].prevNewsScore,
        sentiment: byName[n].sentiment,
        posHits: byName[n].posHits,
        negHits: byName[n].negHits,
        naverPopularity: byName[n].naverPopularity,
        naverAsvi: byName[n].naverAsvi,
        naverSpike: byName[n].naverSpike,
        naverCount: byName[n].naverCount,
        naverCountKO: byName[n].naverCountKO,
        naverCountEN: byName[n].naverCountEN,
        blogMentions: byName[n].blogMentions,
        wikiViews: byName[n].wikiViews,
        fmpNewsCount: byName[n].fmpNewsCount,
        googleNewsCount: byName[n].googleNewsCount,
        yahooNewsCount: byName[n].yahooNewsCount,
        investingNewsCount: byName[n].investingNewsCount,
        hanwhaNewsCount: byName[n].hanwhaNewsCount,
        offHi: byName[n].offHi,
        offLo: byName[n].offLo,
        polygonTrend: byName[n].polygonTrend,
        nasdaqClose: byName[n].nasdaqClose,
        recentEarnings: byName[n].earn,
        reputationScore: byName[n].reputationScore,
        topKeywords: (byName[n].topKeywords || []).slice(0,3),
        reputationHitIds: byName[n].reputationHitIds || [],
        popularity01: popularity01?.[n] ?? 0,
        source: byName[n].source,
        attempts: byName[n].attempts,
        fetchMs: byName[n].fetchMs,
        components: byName[n].componentScores,
        wikiScore: byName[n].wikiScore,
        score: byName[n].totalScore,
        rawScore: byName[n].totalScore,
        ds_news7: byName[n].ds_news7,
        ds_burst: byName[n].ds_burst,
        ds_slope7: byName[n].ds_slope7,
        ds_topic: byName[n].ds_topic,
        ds_trend: byName[n].ds_trend,
        eligible: eligibility[n]
      };
      return acc;
    }, {});

    const subset = names.reduce((acc, n) => { acc[n] = byName[n]; return acc; }, {});
    marketCoverage[market] = coverageRatio(subset);
  }

  const covs = Object.values(marketCoverage);
  const avgCoverage = covs.length ? covs.reduce((a,b)=>a+b,0)/covs.length : 0;
  const minCov = covs.length ? Math.min(...covs) : 0;
  console.log(`[buildPools] avg coverage=${(avgCoverage*100).toFixed(1)}% (min=${(minCov*100).toFixed(1)}%)`);

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
  const hardFail = avgCoverage === 0 || covs.every(c => c < 0.01);
  if (avgCoverage < COVERAGE_MIN || hardFail) {
    console.warn(`[buildPools] low metric coverage (avg=${(avgCoverage*100).toFixed(1)}%), using fallback`);
    const lastGood = loadLastGoodPools();
    const outPools = lastGood ?? namesOnlyRank(universe, NEWS_FEATURES) ?? pools;
    await writeAtomic(POOLS_FILE, JSON.stringify(outPools, null, 2));
    await writeAtomic(METRICS_FILE, JSON.stringify(metricsOut, null, 2));
    if (lastGood) console.log('[buildPools] wrote pools.json from last good snapshot');
    else if (outPools !== pools) console.log('[buildPools] wrote pools.json and pools-metrics.json :: names-only');
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
  snapshotPools(pools);
  console.log('[buildPools] wrote pools.json and pools-metrics.json :: done');
}

main()
  .then(() => {
    persistConfirmedMappings();
  })
  .catch(e => {
    console.error('[buildPools] failed:', e.message);
    persistConfirmedMappings();
    process.exit(0);
  });
