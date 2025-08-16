import fs from 'fs';
import path from 'node:path';

import { TICKER_MAP, STATIC_SECTORS } from './maps.js';
import { pickDeterministic, nowKSTISO } from './util.js';

const POOLS_PATH = path.resolve(process.cwd(), 'pools.json');

const POOLS_FALLBACK = {
  NASDAQ: {
    safe: ['Microsoft','Apple','NVIDIA','Amazon','Meta Platforms'],
    aggressive: ['Super Micro Computer','Palantir','Arm Holdings','Micron Technology','UiPath']
  },
  KOSPI: {
    safe: ['삼성전자','SK하이닉스','현대차','NAVER','카카오'],
    aggressive: ['에코프로','셀트리온','HD현대일렉트릭','두산에너빌리티','한화에어로스페이스']
  },
  KOSDAQ: {
    safe: ['셀트리온헬스케어','JYP엔터테인먼트','펄어비스','아이오케이','CJ ENM'],
    aggressive: ['에코프로비엠','천보','리노공업','알테오젠','레인보우로보틱스']
  }
};

function loadPoolsSync() {
  try {
    const txt = fs.readFileSync(POOLS_PATH, 'utf8');
    return JSON.parse(txt);
  } catch {
    return POOLS_FALLBACK;
  }
}

export async function buildTrendingPools() {
  return structuredClone(loadPoolsSync());
}

export async function fetchSectorByTicker(ticker) {
  return STATIC_SECTORS[ticker] || null;
}

export async function fetchSector(name) {
  const ticker = TICKER_MAP[name] || name;
  const sector = await fetchSectorByTicker(ticker);
  return { sector, ticker };
}

export async function tryFetchAndEnrich() {
  const pools = await buildTrendingPools();
  const data = {};
  let successCount = 0;
  for (const [market, buckets] of Object.entries(pools)) {
    data[market] = { safe: [], aggressive: [] };
    for (const [bucket, names] of Object.entries(buckets)) {
      for (const name of names) {
        const { sector } = await fetchSector(name);
        if (sector) successCount++;
        data[market][bucket].push({ name, sector });
      }
    }
  }
  return { data, successCount };
}

export function sortData(data) {
  const out = {};
  for (const market of Object.keys(data)) {
    out[market] = {};
    for (const bucket of ['safe','aggressive']) {
      const arr = (data[market][bucket] || []).slice().sort((a,b)=>a.name.localeCompare(b.name));
      out[market][bucket] = arr;
    }
  }
  return out;
}

export function pruneEmptyMarkets(out) {
  for (const m of Object.keys(out)) {
    if (['lastUpdated','mode','fallbackReason'].includes(m)) continue;
    const s = out[m]?.safe?.length || 0;
    const a = out[m]?.aggressive?.length || 0;
    if (s + a === 0) delete out[m];
  }
}

export function rotateFromPools(prevData) {
  const pools = loadPoolsSync();
  const seed = new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'});
  const out = {};
  for (const [market,buckets] of Object.entries(pools)) {
    out[market] = {};
    for (const bucket of ['safe','aggressive']) {
      const arr = pickDeterministic(buckets[bucket],5,`${seed}:${market}:${bucket}`);
      out[market][bucket] = arr.map(name=>({name}));
    }
  }
  return out;
}

export async function writeSmartFallback(reason = 'unknown', paths) {
  const seed = new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'});
  const out = { lastUpdated: nowKSTISO(), mode: 'fallback', fallbackReason: reason };
  for (const [market,buckets] of Object.entries(POOLS_FALLBACK)) {
    out[market] = {};
    for (const bucket of ['safe','aggressive']) {
      const arr = pickDeterministic(buckets[bucket],5,`fallback:${seed}:${market}:${bucket}`);
      out[market][bucket] = arr.map(name=>({name}));
    }
  }
  if (paths?.OUT_FILE) {
    const { writeAtomically } = await import('./io.js');
    await writeAtomically(paths.OUT_FILE, JSON.stringify(out, null, 2));
  }
  return out;
}
