import fs from 'fs/promises';
import path from 'node:path';

export function rank01(arr) {
  const nums = arr.filter(v => v != null);
  const min = Math.min(...nums, 0);
  const max = Math.max(...nums, 0);
  return arr.map(v => {
    if (v == null || max === min) return 0;
    return (v - min) / (max - min);
  });
}

export async function getJSON(url, headers = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return await res.json();
    } catch {}
    if (i < retries) await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }
  return null;
}

function log(...a) { console.log('[buildPools]', ...a); }

async function writeAtomically(file, data) {
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

async function readJSON(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch { return null; }
}

function clamp(v, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, v)); }

async function loadUniverse(root, poolsPath) {
  const uni = await readJSON(path.join(root, 'universe.json'));
  if (uni) return uni;
  const pools = await readJSON(poolsPath);
  if (!pools) return null;
  const out = {};
  for (const [m, b] of Object.entries(pools)) {
    out[m] = Array.from(new Set([...(b.safe || []), ...(b.aggressive || [])]));
  }
  return out;
}

async function loadFeedback(file) {
  const fb = await readJSON(file);
  if (fb) return fb;
  return { version: 1, weights: {}, decay: { half_life_days: 14, last_decay_ts: new Date().toISOString() } };
}

async function maybeDecay(feedback, file) {
  const now = Date.now();
  const last = Date.parse(feedback.decay.last_decay_ts || 0);
  const hl = feedback.decay.half_life_days || 14;
  if (now - last > hl * 86400000) {
    for (const m of Object.keys(feedback.weights)) {
      for (const n of Object.keys(feedback.weights[m])) {
        feedback.weights[m][n] *= 0.5;
        if (Math.abs(feedback.weights[m][n]) < 1e-4) delete feedback.weights[m][n];
      }
      if (Object.keys(feedback.weights[m]).length === 0) delete feedback.weights[m];
    }
    feedback.decay.last_decay_ts = new Date().toISOString();
  }
  await writeAtomically(file, JSON.stringify(feedback, null, 2));
}

async function fetchSignals(tickers, env) {
  const out = {};
  const news = env.NEWS_API_URL
    ? await getJSON(`${env.NEWS_API_URL}?tickers=${tickers.join(',')}`, env.NEWS_API_KEY ? { Authorization: env.NEWS_API_KEY } : {})
    : null;
  const quotes = env.QUOTES_API_URL
    ? await getJSON(`${env.QUOTES_API_URL}?tickers=${tickers.join(',')}`, env.QUOTES_API_KEY ? { Authorization: env.QUOTES_API_KEY } : {})
    : null;
  const earnings = env.EARNINGS_API_URL
    ? await getJSON(`${env.EARNINGS_API_URL}?tickers=${tickers.join(',')}`, env.EARNINGS_API_KEY ? { Authorization: env.EARNINGS_API_KEY } : {})
    : null;
  for (const t of tickers) {
    out[t] = {
      news: news?.[t] ?? 0,
      ret5: quotes?.[t]?.ret_5d ?? 0,
      ret20: quotes?.[t]?.ret_20d ?? 0,
      turnover: quotes?.[t]?.turnover_z ?? 0,
      vol: quotes?.[t]?.vol_20d ?? 0,
      earnings: Array.isArray(earnings?.recent) ? earnings.recent.includes(t) : !!earnings?.[t]
    };
  }
  return out;
}

async function main() {
  const root = process.cwd();
  const poolsPath = path.join(root, 'pools.json');
  const metricsPath = path.join(root, 'pools-metrics.json');
  const feedbackPath = path.join(root, 'feedback.json');

  const env = {
    NEWS_API_URL: process.env.NEWS_API_URL,
    NEWS_API_KEY: process.env.NEWS_API_KEY,
    QUOTES_API_URL: process.env.QUOTES_API_URL,
    QUOTES_API_KEY: process.env.QUOTES_API_KEY,
    EARNINGS_API_URL: process.env.EARNINGS_API_URL,
    EARNINGS_API_KEY: process.env.EARNINGS_API_KEY
  };

  if (!env.NEWS_API_URL && !env.QUOTES_API_URL && !env.EARNINGS_API_URL) {
    log('No API endpoints configured; skipping generation');
    await writeAtomically(metricsPath, JSON.stringify({ lastRun: new Date().toISOString(), note: 'skipped' }, null, 2));
    const fb = await loadFeedback(feedbackPath);
    await maybeDecay(fb, feedbackPath);
    return;
  }

  const universe = await loadUniverse(root, poolsPath);
  if (!universe) {
    log('No universe available; skipping');
    await writeAtomically(metricsPath, JSON.stringify({ lastRun: new Date().toISOString(), note: 'no universe' }, null, 2));
    const fb = await loadFeedback(feedbackPath);
    await maybeDecay(fb, feedbackPath);
    return;
  }

  const whitelist = await readJSON(path.join(root, 'whitelist.json')) || {};
  const blacklist = await readJSON(path.join(root, 'blacklist.json')) || {};
  const feedback = await loadFeedback(feedbackPath);

  const metrics = {};
  const pools = {};

  for (const [market, tickers] of Object.entries(universe)) {
    const sig = await fetchSignals(tickers, env);
    const news = rank01(tickers.map(t => sig[t].news));
    const r5 = rank01(tickers.map(t => sig[t].ret5));
    const r20 = rank01(tickers.map(t => sig[t].ret20));
    const turnover = rank01(tickers.map(t => sig[t].turnover));
    const vol = rank01(tickers.map(t => sig[t].vol));

    metrics[market] = {};
    const scored = [];
    tickers.forEach((t, i) => {
      let score_safe = 0.35 * news[i] + 0.35 * r20[i] + 0.20 * r5[i] + 0.10 * (1 - vol[i]);
      let score_aggr = 0.45 * news[i] + 0.35 * r5[i] + 0.20 * turnover[i];
      if (sig[t].earnings) { score_safe += 0.10; score_aggr += 0.10; }
      const weight = feedback.weights?.[market]?.[t] ?? 0;
      score_safe = clamp(score_safe + weight);
      score_aggr = clamp(score_aggr + weight);
      metrics[market][t] = {
        news: news[i], ret5: r5[i], ret20: r20[i], turnover: turnover[i], vol: vol[i], earnings: !!sig[t].earnings,
        score_safe, score_aggr
      };
      scored.push({ t, score_safe, score_aggr });
    });

    const blSet = new Set(blacklist[market] || []);
    const safeSorted = scored.filter(s => !blSet.has(s.t)).sort((a,b)=>b.score_safe-a.score_safe).map(s=>s.t);
    const aggrSorted = scored.filter(s => !blSet.has(s.t)).sort((a,b)=>b.score_aggr-a.score_aggr).map(s=>s.t);

    function applyLists(sorted, wl) {
      const wlSet = new Set(wl);
      const whitelisted = sorted.filter(n => wlSet.has(n));
      const rest = sorted.filter(n => !wlSet.has(n));
      return whitelisted.concat(rest).slice(0,5);
    }

    pools[market] = {
      safe: applyLists(safeSorted, whitelist[market] || []),
      aggressive: applyLists(aggrSorted, whitelist[market] || [])
    };
  }

  await writeAtomically(poolsPath, JSON.stringify(pools, null, 2));
  await writeAtomically(metricsPath, JSON.stringify(metrics, null, 2));
  await maybeDecay(feedback, feedbackPath);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('[buildPools:error]', e); process.exit(0); });
}
