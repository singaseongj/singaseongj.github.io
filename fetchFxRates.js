import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'node:path';
import { nowKSTISO } from './utils/time.js';

const OUT = path.resolve(process.cwd(), 'data', 'fx_rates.json');
const API = 'https://api.exchangerate.host/latest?base=USD&symbols=KRW,JPY,EUR,CNY,GBP';

async function ensureDir(p) {
  const dir = path.dirname(p);
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchWithRetry(url, { retries = 3, base = 400 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(base * 2 ** i);
    }
  }
  throw lastErr;
}

async function main() {
  await ensureDir(OUT);
  let data;
  try {
    const j = await fetchWithRetry(API);
    const rates = j?.rates || {};
    const out = {
      base: 'USD',
      timestamp: nowKSTISO(),
      rates: {
        KRW: Number(rates.KRW ?? 0),
        JPY: Number(rates.JPY ?? 0),
        EUR: Number(rates.EUR ?? 0),
        CNY: Number(rates.CNY ?? 0),
        GBP: Number(rates.GBP ?? 0),
      }
    };
    await fs.writeFile(OUT, JSON.stringify(out, null, 2));
    console.log(`FX: wrote ${OUT} at ${out.timestamp}`);
    return;
  } catch (err) {
    console.warn('FX fetch failed:', err?.message || err);
    if (existsSync(OUT)) {
      console.warn('Keeping previous fx_rates.json');
      return;
    }
    const fallback = {
      base: 'USD',
      timestamp: nowKSTISO(),
      rates: { KRW: 0, JPY: 0, EUR: 0, CNY: 0, GBP: 0 }
    };
    await fs.writeFile(OUT, JSON.stringify(fallback, null, 2));
    console.log('FX: wrote fallback fx_rates.json');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
