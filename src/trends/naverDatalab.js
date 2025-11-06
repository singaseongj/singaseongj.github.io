import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const NAVER_ID = process.env.NAVER_CLIENT_ID || '';
const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || '';
const NAVER_URL = 'https://openapi.naver.com/v1/datalab/search';
const NAVER_UA = 'Mozilla/5.0 (compatible; SingaseongTrends/1.0; +https://singaseongj.github.io/)';
const MAX_GROUPS_PER_REQ = 5; // DataLab hard limit
const DEFAULT_TTL_MS = Number(process.env.NAVER_TRENDS_CACHE_TTL_MS || 6 * 60 * 60 * 1000);

const NAVER_CACHE_DIR = path.join('cache', 'naver');
fs.mkdirSync(NAVER_CACHE_DIR, { recursive: true });

function keyForNaver(objOrStr) {
  const s = typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr);
  return crypto.createHash('sha1').update(s).digest('hex');
}
function cachePath(key) {
  return path.join(NAVER_CACHE_DIR, `${key}.json`);
}
async function readCache(key, ttlMs) {
  const p = cachePath(key);
  try {
    const st = await fs.promises.stat(p);
    if (Date.now() - st.mtimeMs > ttlMs) return null;
    return JSON.parse(await fs.promises.readFile(p, 'utf8'));
  } catch { return null; }
}
async function writeCache(key, data) {
  const p = cachePath(key);
  const tmp = `${p}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data));
  await fs.promises.rename(tmp, p);
}

async function readCacheStale(key) {
  const p = cachePath(key);
  try {
    const txt = await fs.promises.readFile(p, 'utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

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

/**
 * baskets: Array<{ groupName: string, keywords: string[], weight?: number, symbol?: string }>
 * Returns: { perSymbol: { [symbol]: { naverPopularity, spike, persist, lastAsvi, debug } }, raw: ... }
 */
export async function fetchNaverTrends(options, _retry = 0) {
  const originalOptions = options ?? {};
  const {
    baskets = [],
    startDate,
    endDate,
    timeUnit = 'date',
    device = '',
    ages = [],
    gender = '',
    cacheTtlMs = DEFAULT_TTL_MS,
    budgetLeftMs = Infinity,
  } = originalOptions;
  if (!NAVER_ID || !NAVER_SECRET) {
    console.warn('[naver] missing NAVER_CLIENT_ID/SECRET; returning empty');
    return { perSymbol:{}, raw:[] };
  }
  // Build requests in chunks of 5 groups
  const chunks = [];
  for (let i=0;i<baskets.length;i+=MAX_GROUPS_PER_REQ){
    chunks.push(baskets.slice(i, i+MAX_GROUPS_PER_REQ));
  }

  const results = [];
  let remainingBudget = Number.isFinite(budgetLeftMs) ? Math.max(0, Number(budgetLeftMs)) : Infinity;
  for (const chunk of chunks){
    const endpoint = NAVER_URL;
    const body = {
      startDate, endDate, timeUnit, keywordGroups: chunk.map(g => ({ groupName: g.groupName, keywords: g.keywords })),
      device, ages, gender
    };

    const cacheKey = keyForNaver({ endpoint, body });
    const ttl = Number(cacheTtlMs ?? DEFAULT_TTL_MS);

    let json = await readCache(cacheKey, ttl);
    if (!json) {
      if (Number.isFinite(remainingBudget) && remainingBudget <= 0) {
        console.warn('[naver] budget exhausted before completing fetch; returning partial results');
        json = { results: [] };
      } else {
        const headers = {
          'X-Naver-Client-Id': NAVER_ID,
          'X-Naver-Client-Secret': NAVER_SECRET,
          'Content-Type': 'application/json',
          'User-Agent': NAVER_UA,
        };

        const start = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
        let res;
        try {
          res = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (err) {
          if (err.name === 'AbortError') {
            console.warn(`[naver] Request timeout for group ${chunk.map(g => g.groupName).join(', ')}`);
            console.warn('⚠️ Naver API fetch aborted (timeout or rate limit)');
            return null;
          }
          throw err;
        } finally {
          clearTimeout(timeout);
          const elapsed = Date.now() - start;
          if (Number.isFinite(remainingBudget)) {
            remainingBudget = Math.max(0, remainingBudget - elapsed);
          }
        }

        if (!res.ok) {
          if (_retry === 0 && (res.status === 429 || res.status >= 500)) {
            console.warn(`⚠️ Retrying Naver API after ${res.status}...`);
            await new Promise(r => setTimeout(r, 3000));
            return fetchNaverTrends({ ...originalOptions, budgetLeftMs: Math.max(0, remainingBudget) }, _retry + 1);
          }
          if (res.status === 403) {
            const stale = await readCacheStale(cacheKey);
            if (stale) {
              console.warn('[naver] 403 Forbidden – using cached response');
              json = stale;
            } else {
              const body = await res.text().catch(() => '');
              throw new Error(`Naver API error 403: ${body.slice(0, 120)}`);
            }
          } else {
            throw new Error(`Naver API error ${res.status}: ${await res.text()}`);
          }
        }

        if (!json) {
          json = await res.json();
        }
        await writeCache(cacheKey, json);
      }
    } else if (Number.isFinite(remainingBudget)) {
      // Using cached response; still decrement to avoid runaway loops when cache reads dominate.
      remainingBudget = Math.max(0, remainingBudget - 1);
    }

    results.push(json);
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
