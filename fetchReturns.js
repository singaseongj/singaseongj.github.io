import fs from 'fs/promises';
import { getCandles } from './src/data/candles.js';

const rec = JSON.parse(await fs.readFile('recommendations.json', 'utf8'));

// Load existing pools-metrics — this is the authoritative source; we only patch ret5/ret20 into it
let metrics = {};
try {
  metrics = JSON.parse(await fs.readFile('pools-metrics.json', 'utf8'));
} catch {
  metrics = {};
}

for (const [market, buckets] of Object.entries(rec)) {
  if (market === 'lastUpdated') continue;
  if (!buckets || typeof buckets !== 'object') continue;

  for (const bucket of ['safe', 'aggressive']) {
    const list = Array.isArray(buckets[bucket]) ? buckets[bucket] : [];
    for (const entry of list) {
      const name = entry.name;
      const ticker = entry.ticker;
      if (!ticker || !name) continue;

      try {
        const candles = await getCandles(ticker);
        if (!candles || !Array.isArray(candles.c)) continue;
        const c = candles.c;
        const n = c.length;
        const latest = c[n - 1];
        const c5  = n >= 6  ? c[n - 6]  : null;
        const c20 = n >= 21 ? c[n - 21] : null;
        const ret5  = (c5  != null && latest != null) ? ((latest - c5)  / c5  * 100) : null;
        const ret20 = (c20 != null && latest != null) ? ((latest - c20) / c20 * 100) : null;

        // ADDITIVE PATCH: only touch ret5/ret20, never wipe existing score/components/etc.
        if (!metrics[market])                                  metrics[market] = {};
        if (typeof metrics[market] !== 'object' ||
            Array.isArray(metrics[market]))                    metrics[market] = {};
        if (!metrics[market][name] ||
            typeof metrics[market][name] !== 'object')         metrics[market][name] = {};

        metrics[market][name].ret5  = ret5;
        metrics[market][name].ret20 = ret20;

      } catch (e) {
        console.warn(`[returns] ${ticker} failed: ${e.message}`);
      }
    }
  }
}

await fs.writeFile('pools-metrics.json', JSON.stringify(metrics, null, 2));
console.log('Updated pools-metrics.json with return metrics (ret5/ret20).');

/* === ADDITIVE EXPORT: expose fetchByTickers for other scripts === */
let fetchByTickers;
try {
  ({ fetchByTickers } = await import('./src/data/quotes.js'));
} catch {}
export { fetchByTickers };
