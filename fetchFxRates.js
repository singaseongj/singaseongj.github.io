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
  try {
    const j = await fetchWithRetry(API);
    const r = j?.rates || {};
    const KRW = Number(r.KRW ?? 0);
    const JPY = Number(r.JPY ?? 0);
    const EUR = Number(r.EUR ?? 0);
    const CNY = Number(r.CNY ?? 0);
    const GBP = Number(r.GBP ?? 0);

    const out = {
      lastUpdated: nowKSTISO(),
      rates: {
        USD: Number(KRW.toFixed(2)),
        JPY: JPY ? Number(((KRW / JPY) * 100).toFixed(2)) : 0,
        EUR: EUR ? Number((KRW / EUR).toFixed(2)) : 0,
        CNY: CNY ? Number((KRW / CNY).toFixed(2)) : 0,
        GBP: GBP ? Number((KRW / GBP).toFixed(2)) : 0,
      }
    };
    await fs.writeFile(OUT, JSON.stringify(out, null, 2));
    console.log(`FX: wrote ${OUT} at ${out.lastUpdated}`);
    return;
  } catch (err) {
    console.warn('FX fetch failed:', err?.message || err);
    if (existsSync(OUT)) {
      console.warn('Keeping previous fx_rates.json');
      return;
    }
    const fallback = {
      lastUpdated: nowKSTISO(),
      rates: { USD: 0, JPY: 0, EUR: 0, CNY: 0, GBP: 0 }
    };
    await fs.writeFile(OUT, JSON.stringify(fallback, null, 2));
    console.log('FX: wrote fallback fx_rates.json');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
