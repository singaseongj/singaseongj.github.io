import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'node:path';
import { nowKSTISO } from './utils/time.js';

const OUT = path.resolve(process.cwd(), 'data', 'fx_rates.json');

const YF = (symbols) =>
  `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`;

const FR_USD = 'https://api.frankfurter.app/latest?from=USD&to=KRW,EUR,GBP,CNY,HKD';
const FR_JPY = 'https://api.frankfurter.app/latest?from=JPY&to=KRW';

const EH_USD = 'https://api.exchangerate.host/latest?base=USD&symbols=KRW,EUR,GBP,CNY,HKD';
const EH_JPY = 'https://api.exchangerate.host/latest?base=JPY&symbols=KRW';

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
async function get(url,{retries=3,base=400}={}) {
  let err;
  for (let i=0;i<=retries;i++){
    try{
      const res = await fetch(url,{headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'}});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
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

async function yahooProvider() {
  // Yahoo currency pairs return KRW directly
  const symbols = [
    'USDKRW=X','JPYKRW=X','EURKRW=X','CNYKRW=X','GBPKRW=X','HKDKRW=X'
  ].join(',');
  const j = await get(YF(symbols));
  const q = j?.quoteResponse?.result || [];
  const by = Object.fromEntries(q.map(r => [r.symbol, r.regularMarketPrice]));
  const map = {
    USD_KRW: by['USDKRW=X'],
    JPY100_KRW: by['JPYKRW=X'] ? by['JPYKRW=X']*100 : null,
    EUR_KRW: by['EURKRW=X'],
    CNY_KRW: by['CNYKRW=X'],
    GBP_KRW: by['GBPKRW=X'],
    HKD_KRW: by['HKDKRW=X'],
  };
  return itemsFromRates(map);
}

async function frankfurterProvider() {
  const usd = await get(FR_USD);
  const jpy = await get(FR_JPY);
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

async function exchangerateHostProvider() {
  const usd = await get(EH_USD);
  const jpy = await get(EH_JPY);
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
  const providers = [yahooProvider, frankfurterProvider, exchangerateHostProvider];
  for (const p of providers) {
    try { items = await p(); if (items.some(x=>typeof x.krw==='number')) break; } catch {}
  }

  if (!items) {
    if (existsSync(OUT)) { console.warn('FX: all providers failed; keeping previous file'); return; }
    items = itemsFromRates({}); // all nulls
  }

  const out = { lastUpdated: nowKSTISO(), items };
  await fs.writeFile(OUT, JSON.stringify(out, null, 2));
  console.log(`FX: wrote ${OUT} at ${out.lastUpdated}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });

