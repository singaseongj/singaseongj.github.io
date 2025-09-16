import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'node:path';
import { nowKSTISO } from './utils/time.js';

// Write under /stocks/fx_rates/ (dashboard + ticker will read from here)
const OUT_DIR = path.resolve(process.cwd(), 'stocks', 'fx_rates');
const OUT = path.join(OUT_DIR, 'fx_rates.json');
const HISTORY_PREFIX = 'fx_history';
const HISTORY_MANIFEST = path.join(OUT_DIR, `${HISTORY_PREFIX}_manifest.json`);
const LEGACY_HISTORY = path.join(OUT_DIR, 'fx_history.json');

const SERIES_KEYS = ['USD', 'JPY100', 'EUR', 'CNY', 'GBP', 'HKD'];

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

async function getJson(url,{retries=3,base=400,headers}={}) {
  let err;
  for (let i=0;i<=retries;i++){
    try{
      const res = await fetch(url,{
        headers: {
          'User-Agent':'Mozilla/5.0',
          'Accept':'application/json',
          ...(headers||{})
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }catch(e){ err=e; if(i<retries) await sleep(base*2**i); }
  }
  throw err;
}

async function getText(url,{retries=3,base=400,headers}={}) {
  let err;
  for (let i=0;i<=retries;i++){
    try{
      const res = await fetch(url,{
        headers: {
          'User-Agent':'Mozilla/5.0',
          'Accept':'text/html, */*;q=0.1',
          'Referer': 'https://finance.naver.com/',
          ...(headers||{})
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
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
  ];
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

async function updateHistory(snapshot) {
  const manifest = await readManifest();
  const { items, lastUpdated } = snapshot;
  if (!lastUpdated) {
    return await saveManifest(manifest);
  }

  const ts = new Date(lastUpdated);
  if (!Number.isFinite(ts.getTime())) {
    return await saveManifest(manifest);
  }

  const year = ts.getFullYear();
  const yearHistory = await readYearHistory(year);

  for (const it of items) {
    if (typeof it.krw !== 'number') continue;
    const key = keyFromItem(it);
    yearHistory.series[key] ??= [];
    upsertPoint(yearHistory.series[key], lastUpdated, it.krw);
  }

  for (const key of SERIES_KEYS) {
    const sorted = yearHistory.series[key]
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

  yearHistory.updatedAt = lastUpdated;
  await writeYearHistory(yearHistory);

  if (!manifest.years.includes(year)) {
    manifest.years.push(year);
  }
  manifest.lastUpdated = lastUpdated;
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
      console.warn('FX: all providers failed; keeping previous file');
      return;
    }
    items = itemsFromRates({}); // all nulls
  }

  const out = { lastUpdated: nowKSTISO(), items };
  await fs.writeFile(OUT, JSON.stringify(out, null, 2));
  console.log(`FX: wrote ${OUT} at ${out.lastUpdated}`);

  // append/update rolling history
  await updateHistory(out);
}

main().catch(e => { console.error(e); process.exit(1); });
