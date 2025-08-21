import fs from 'fs/promises';
import crypto from 'crypto';

const NAVER_ID = process.env.NAVER_CLIENT_ID || '';
const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || '';
const NAVER_URL = 'https://openapi.naver.com/v1/datalab/search';
const MAX_GROUPS_PER_REQ = 5; // DataLab hard limit
const DEFAULT_TTL_MS = Number(process.env.NAVER_TRENDS_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const REQ_TIMEOUT_MS = Number(process.env.NAVER_REQ_TIMEOUT_MS || 8000);
const RETRIES = Number(process.env.NAVER_RETRIES || 3);
const BACKOFF_BASE_MS = Number(process.env.NAVER_BACKOFF_BASE_MS || 600);
const CACHE_DIR = process.env.NAVER_CACHE_DIR || 'cache';
const QPS = Number(process.env.NAVER_QPS || 2); // crude throttle
let lastReqTs = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now(){ return Date.now(); }
function hash(obj){
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

async function ensureDir(p){ await fs.mkdir(p, { recursive: true }); }

export function rollingMedian(arr, win) {
  const out = new Array(arr.length).fill(null);
  const buf = [];
  for (let i=0;i<arr.length;i++){
    const v = arr[i];
    if (v == null || !Number.isFinite(v)) { out[i] = null; continue; }
    buf.push(v);
    if (buf.length > win) buf.shift();
    if (buf.length < win) { out[i] = null; continue; }
    const s = [...buf].sort((a,b)=>a-b);
    const mid = Math.floor(win/2);
    out[i] = win % 2 ? s[mid] : (s[mid-1]+s[mid])/2;
  }
  return out;
}

export function rollingMAD(arr, med, win){
  const out = new Array(arr.length).fill(null);
  const buf = [];
  for (let i=0;i<arr.length;i++){
    const v = arr[i];
    if (v == null || !Number.isFinite(v) || med[i] == null) { out[i] = null; continue; }
    buf.push(Math.abs(v - med[i]));
    if (buf.length > win) buf.shift();
    if (buf.length < win) { out[i] = null; continue; }
    const s = [...buf].sort((a,b)=>a-b);
    const mid = Math.floor(win/2);
    out[i] = win % 2 ? s[mid] : (s[mid-1]+s[mid])/2;
  }
  return out;
}

export function asvi(series, win=8) {
  const x = series.map(v => (v == null ? null : Math.log1p(v)));
  const med = rollingMedian(x, win);
  const mad = rollingMAD(x, med, win).map(v => (v === 0 ? null : v));
  return x.map((v,i) => (v==null || med[i]==null || mad[i]==null ? null : (v - med[i]) / mad[i]));
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

async function readCacheOrNull(path, ttlMs){
  try{
    const stat = await fs.stat(path);
    if (now() - stat.mtimeMs > ttlMs) return null;
    return JSON.parse(await fs.readFile(path, 'utf8'));
  }catch{ return null; }
}

async function writeAtomic(p, data){
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, p);
}

async function postJSONWithBackoff({ url, headers, body, retries=RETRIES, timeoutMs=REQ_TIMEOUT_MS, budgetLeftMs=Infinity }) {
  let lastErr;
  for (let attempt=0; attempt<=retries; attempt++){
    if (budgetLeftMs <= 0) throw new Error('naver budget exhausted');
    // simple qps throttle
    const gap = 1000 / Math.max(QPS, 1);
    const wait = Math.max(0, lastReqTs + gap - now());
    if (wait > 0) await sleep(wait);
    lastReqTs = now();

    const controller = new AbortController();
    const perReq = Math.min(timeoutMs, Math.max(500, budgetLeftMs));
    const t = setTimeout(() => controller.abort(), perReq);
    try{
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }catch(e){
      clearTimeout(t);
      lastErr = e;
      if (attempt < retries && budgetLeftMs > 0){
        const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
        await sleep(backoff);
      }
    }
  }
  throw lastErr;
}

/**
 * baskets: Array<{ groupName: string, keywords: string[], weight?: number, symbol?: string }>
 * Returns: { perSymbol: { [symbol]: { naverPopularity, spike, persist, lastAsvi, debug } }, raw: ... }
 */
export async function fetchNaverTrends({ baskets, startDate, endDate, timeUnit='date', device='', ages=[], gender='', cacheTtlMs=DEFAULT_TTL_MS, budgetLeftMs=Infinity }) {
  if (!NAVER_ID || !NAVER_SECRET) {
    console.warn('[naver] missing NAVER_CLIENT_ID/SECRET; returning empty');
    return { perSymbol:{}, raw:[] };
  }
  await ensureDir(CACHE_DIR);

  // Build requests in chunks of 5 groups
  const chunks = [];
  for (let i=0;i<baskets.length;i+=MAX_GROUPS_PER_REQ){
    chunks.push(baskets.slice(i, i+MAX_GROUPS_PER_REQ));
  }

  const results = [];
  for (const chunk of chunks){
    const body = {
      startDate, endDate, timeUnit, keywordGroups: chunk.map(g => ({ groupName: g.groupName, keywords: g.keywords })),
      device, ages, gender
    };
    const cacheKey = `${NAVER_URL}-${hash(body)}.json`;
    const cachePath = `${CACHE_DIR}/${cacheKey}`;

    const cached = await readCacheOrNull(cachePath, cacheTtlMs);
    if (cached) { results.push(cached); continue; }

    try{
      const j = await postJSONWithBackoff({
        url: NAVER_URL,
        headers: { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET },
        body, budgetLeftMs
      });
      await writeAtomic(cachePath, JSON.stringify(j));
      results.push(j);
    }catch(e){
      console.warn('[naver] chunk failed:', e.message);
    }
  }

  // Flatten and compute ASVI per group
  const seriesByGroup = new Map(); // groupName -> { dates:[], values:[] }
  for (const r of results){
    const res = r?.results || [];
    for (const g of res){
      const dates = [];
      const vals = [];
      for (const p of g.data){
        dates.push(p.period);
        vals.push(Number(p.ratio) || 0);
      }
      seriesByGroup.set(g.title || g.groupName, { dates, values: vals });
    }
  }

  // Aggregate to symbols
  const perSymbol = {};
  for (const b of baskets){
    const w = Number.isFinite(b.weight) ? b.weight : 1;
    const key = b.groupName;
    const sym = b.symbol || b.groupName; // fall back to groupName
    const s = seriesByGroup.get(key);
    if (!s) continue;

    const sv = s.values;
    const a = asvi(sv, 10);
    const lastIdx = a.findLastIndex(x => x != null);
    const lastAsvi = lastIdx >= 0 ? a[lastIdx] : null;
    // Spike & persistence
    let persist = 0;
    if (a.length >= 5){
      const tail = a.slice(-5).filter(x => x != null);
      persist = tail.filter(x => x > 1).length >= 3 ? 1 : 0;
    }
    const spike = lastAsvi != null && lastAsvi >= 2 ? 1 : 0;

    // Popularity: mix of normalized last search ratio and ASVI
    const maxSV = Math.max(...sv.filter(Number.isFinite), 0) || 1;
    const lastSV = sv[sv.length - 1] || 0;
    const svNorm = clamp01(lastSV / maxSV);
    let asviNorm = 0.5;
    if (lastAsvi != null) {
      // Map ~[-1,3] to [0,1]
      asviNorm = clamp01((lastAsvi + 1) / 4);
    }
    const pop = clamp01(0.6 * asviNorm + 0.4 * svNorm);

    if (!perSymbol[sym]) {
      perSymbol[sym] = { wsum:0, popsum:0, spike:0, persist:0, lastAsvi: null, debug: [] };
    }
    perSymbol[sym].wsum += w;
    perSymbol[sym].popsum += w * pop;
    perSymbol[sym].spike = Math.max(perSymbol[sym].spike, spike);
    perSymbol[sym].persist = Math.max(perSymbol[sym].persist, persist);
    perSymbol[sym].lastAsvi = perSymbol[sym].lastAsvi == null ? lastAsvi : Math.max(perSymbol[sym].lastAsvi, lastAsvi ?? -Infinity);
    perSymbol[sym].debug.push({ groupName: key, pop, spike, persist, lastAsvi });
  }

  const out = {};
  for (const [sym, v] of Object.entries(perSymbol)){
    const naverPopularity = v.wsum > 0 ? clamp01(v.popsum / v.wsum) : 0;
    out[sym] = {
      naverPopularity,
      spike: v.spike === 1,
      persist: v.persist === 1,
      lastAsvi: v.lastAsvi,
      debug: v.debug
    };
  }

  return { perSymbol: out, raw: Object.fromEntries(seriesByGroup) };
}

/**
 * Helper to build baskets from your universe & NAME_TO_SYMBOL map.
 * `universe` is { market: string[] } (names), like in your script.
 * `nameToSymbol` is your function.
 * `keywordDict` maps symbol -> keyword array.
 */
export function buildBasketsFromUniverse({ universe, nameToSymbol, keywordDict }) {
  const baskets = [];
  const seen = new Set();

  for (const names of Object.values(universe || {})) {
    for (const name of names) {
      const sym = nameToSymbol(name) || name;
      if (seen.has(sym)) continue;
      seen.add(sym);
      const keywords = keywordDict[sym];
      if (!keywords || !keywords.length) continue;

      // Be conservative: cap at 8 keywords per basket (DataLab allows up to 20 per group; 8 keeps noise down)
      baskets.push({
        groupName: sym,
        keywords: keywords.slice(0, 8),
        weight: 1,
        symbol: sym
      });
    }
  }
  return baskets;
}
