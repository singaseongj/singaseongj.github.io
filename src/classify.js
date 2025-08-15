import { yahooChartCloses, yahooQuoteSummary } from './sources/yahoo.js';

export function annualizedVol(closes) {
  if (!closes || closes.length < 2) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    if (Number.isFinite(r)) rets.push(r);
  }
  if (!rets.length) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const var_ = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(var_) * Math.sqrt(252);
}

export function classify({ vol, marketCap }) {
  if (vol != null && vol >= 0.35) return 'aggressive';
  if (marketCap != null && marketCap < 2e9) return 'aggressive';
  return 'safe';
}

export async function ensureMetrics(symbol) {
  const closes = await yahooChartCloses(symbol);
  const snap = await yahooQuoteSummary(symbol);
  const vol = annualizedVol(closes);
  return { vol, marketCap: snap.marketCap, beta: snap.beta, name: snap.displayName };
}
