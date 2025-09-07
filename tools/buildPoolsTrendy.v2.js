import path from 'path';
import { readJSON, writeJSONAtomic } from '../utils/cache.js';
import { fetchByTickers } from '../src/data/quotes.js';

const ROOT = process.cwd();
const POOLS_FILE = process.env.POOLS_FILE || path.join(ROOT, 'pools.json');
const METRICS_FILE = process.env.METRICS_FILE || path.join(ROOT, 'pools-metrics.json');
const FEEDBACK_FILE = process.env.FEEDBACK_FILE || path.join(ROOT, 'feedback.json');

function toMap(list, key = 'symbol') {
  const m = new Map();
  for (const it of list || []) {
    const sym = (typeof it === 'string' ? it : it[key])?.toUpperCase?.();
    if (!sym) continue;
    m.set(sym, it);
  }
  return m;
}

function feedbackWeight(feedback, market, symbol) {
  const node = feedback?.[market]?.[symbol];
  if (!node) return 0;
  const ts = node.ts ? Date.parse(node.ts) : Date.now();
  const ageDays = (Date.now() - ts) / 864e5;
  const halflife = Number(process.env.FEEDBACK_HALFLIFE_DAYS || 14);
  const decay = Math.pow(0.5, ageDays / halflife);
  return (Number(node.weight) || 0) * decay;
}

function scoreItem(entry, quote, fWeight = 0) {
  const capBonus = Math.log10(Number(quote?.marketCap || 0) + 1) / 12;
  const p = Number(quote?.regularMarketPrice || 0);
  const pc = Number(quote?.regularMarketPreviousClose || 0);
  const momentum = pc > 0 ? (p - pc) / pc : 0;
  const raw = 50 + (40 * momentum) + (10 * capBonus) + Math.max(-5, Math.min(5, fWeight));
  const jitter = ((entry.symbol || '').charCodeAt(0) || 0) % 3;
  return Math.max(0, Math.min(100, Math.round(raw + jitter * 0.25)));
}

export async function main() {
  const pools = await readJSON(POOLS_FILE, {});
  const feedback = await readJSON(FEEDBACK_FILE, {});
  const metrics = {
    startedAt: new Date().toISOString(),
    marketsProcessed: [],
  };

  for (const [market, list] of Object.entries(pools)) {
    const entries = (list || []).map(x => typeof x === 'string' ? { symbol: x } : { ...x });
    const tickers = entries.map(x => x.symbol).filter(Boolean);
    const quotes = await fetchByTickers(tickers);
    const quoteMap = toMap(quotes);
    const scored = entries.map(e => {
      const q = quoteMap.get(e.symbol.toUpperCase());
      const fw = feedbackWeight(feedback, market, e.symbol.toUpperCase());
      const score = scoreItem(e, q, fw);
      return { ...e, score };
    }).sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    pools[market] = scored;
    metrics.marketsProcessed.push({ market, count: scored.length });
  }

  metrics.finishedAt = new Date().toISOString();
  await writeJSONAtomic(POOLS_FILE, pools);
  await writeJSONAtomic(METRICS_FILE, metrics);
  console.log('[buildPoolsTrendy.v2] updated pools + metrics');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
