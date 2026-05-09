import fs from 'fs/promises';
import { getCandles } from './src/data/candles.js';

const rec = JSON.parse(await fs.readFile('recommendations.json', 'utf8'));
let out = {};

try {
  out = JSON.parse(await fs.readFile('pools-metrics.json', 'utf8'));
} catch {
  out = {};
}

for (const [market, buckets] of Object.entries(rec)) {
  if (market === 'lastUpdated') continue;
  if (!out[market] || typeof out[market] !== 'object') out[market] = {};
  for (const bucket of ['safe', 'aggressive']) {
    const list = Array.isArray(buckets[bucket]) ? buckets[bucket] : [];
    for (const entry of list) {
      const name = entry.name;
      const ticker = entry.ticker;
      if (!ticker) continue;
      try {
        const candles = await getCandles(ticker);
        if (!candles || !Array.isArray(candles.c)) continue;
        const c = candles.c;
        const n = c.length;
        const latest = c[n-1];
        const c5 = c[n-6];
        const c20 = c[n-21];
        const ret5 = (c5 != null && latest != null) ? ((latest - c5) / c5 * 100) : null;
        const ret20 = (c20 != null && latest != null) ? ((latest - c20) / c20 * 100) : null;
        const prev = (out[market][name] && typeof out[market][name] === 'object') ? out[market][name] : {};
        out[market][name] = { ...prev, ret5, ret20 };
      } catch (e) {
        console.warn(`[returns] ${ticker} failed: ${e.message}`);
      }
    }
  }
}

await fs.writeFile('pools-metrics.json', JSON.stringify(out, null, 2));
console.log('Updated pools-metrics.json with return metrics (ret5/ret20).');
/* === ADDITIVE EXPORT: expose fetchByTickers for other scripts === */
let fetchByTickers;
try {
  ({ fetchByTickers } = await import('./src/data/quotes.js'));
} catch {}
export { fetchByTickers };
