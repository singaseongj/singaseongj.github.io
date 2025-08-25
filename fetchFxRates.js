import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'node:path';
import { nowKSTISO } from './utils/time.js';

const OUT = path.resolve(process.cwd(), 'data', 'fx_rates.json');

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

async function main(){
  await fs.mkdir(path.dirname(OUT), { recursive:true });

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
}

main().catch(e => { console.error(e); process.exit(1); });
