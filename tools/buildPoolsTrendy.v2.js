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

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

function safeSignal(value = 0.5, confidence = 0.5, note = '') {
  return { score: clamp01(value), confidence: clamp01(confidence), note };
}

function scoreItem(entry, quote, fWeight = 0, market = 'US') {
  const auditLevel = process.env.AUDIT_LEVEL || 'standard';
  const enableAudit = process.env.ENABLE_AUDIT !== 'false';

  const weights = {
    size: Number(process.env.W_SIZE || 0.35),
    news: Number(process.env.W_NEWS || 0.25),
    naver: Number(process.env.W_NAVER || 0.15),
    blogs: Number(process.env.W_BLOGS || 0.05),
    wiki: Number(process.env.W_WIKI || 0.02),
    technical: Number(process.env.W_TECHNICAL || 0.12),
    sentiment: Number(process.env.W_SENTIMENT || 0.04),
    sector: Number(process.env.W_SECTOR || 0.02),
  };

  const cap = Number(quote?.marketCap || 0);
  const sizeScore = clamp01(Math.log10(cap + 1) / 12);
  const p = Number(quote?.regularMarketPrice || 0);
  const pc = Number(quote?.regularMarketPreviousClose || 0);
  const momentum = pc > 0 ? (p - pc) / pc : 0;
  const newsResult = safeSignal(0.5 + momentum * 2, 0.6, 'price-momentum proxy');
  const naverScore = clamp01(0.5 + fWeight / 10);
  const blogResult = safeSignal(0.45, 0.3, 'default');
  const wikiResult = safeSignal(0.5, 0.3, 'default');
  const technicalResult = safeSignal(0.5 + momentum * 2.5, 0.6, 'momentum technical proxy');
  const sentimentResult = { sentiment: momentum, ...safeSignal(0.5 + momentum * 1.5, 0.5, 'momentum sentiment proxy') };
  const sectorResult = { score: 0.5, confidence: 0.4, trend: 'neutral', sectorReturn: 0 };

  let score = 0;
  score += weights.size * sizeScore;
  score += weights.news * newsResult.score;
  score += weights.naver * naverScore;
  score += weights.blogs * blogResult.score;
  score += weights.wiki * wikiResult.score;
  score += weights.technical * technicalResult.score;
  score += weights.sentiment * sentimentResult.score;
  score += weights.sector * sectorResult.score;

  const confidence = clamp01((newsResult.confidence + technicalResult.confidence + sentimentResult.confidence) / 3);
  score = score * confidence + 0.5 * (1 - confidence);

  if (technicalResult.score > 0.75 && technicalResult.confidence > 0.7) score += 0.05;
  if (sentimentResult.sentiment > 0.03) score += 0.03;
  if (market === 'KR') score = Math.max(0, score - (Number(process.env.KR_MARKET_DEDUCT || 20) / 100));

  const floor = 0.2;
  const ceil = 1.0;
  score = Math.max(floor, Math.min(ceil, score));

  const finalScore = Math.round(score * 100);
  const scoreAudit = {
    level: auditLevel,
    enabled: enableAudit,
    confidence,
    composition: {
      traditional: {
        size: weights.size * sizeScore,
        news: weights.news * newsResult.score,
        naver: weights.naver * naverScore,
        blogs: weights.blogs * blogResult.score,
        wiki: weights.wiki * wikiResult.score,
      },
      newSources: {
        technical: weights.technical * technicalResult.score,
        sentiment: weights.sentiment * sentimentResult.score,
        sector: weights.sector * sectorResult.score,
      }
    }
  };

  return { finalScore, scoreAudit, weights };
}

export async function main() {
  const pools = await readJSON(POOLS_FILE, {});
  const feedback = await readJSON(FEEDBACK_FILE, {});
  const auditLevel = process.env.AUDIT_LEVEL || 'standard';
  const enableAudit = process.env.ENABLE_AUDIT !== 'false';

  const metrics = {
    startedAt: new Date().toISOString(),
    marketsProcessed: [],
    auditConfiguration: {
      enabled: enableAudit,
      level: auditLevel,
      timestamp: new Date().toISOString(),
      description: 'Score calculation audit trails'
    }
  };

  for (const [market, list] of Object.entries(pools)) {
    const entries = (list || []).map(x => typeof x === 'string' ? { symbol: x } : { ...x });
    const tickers = entries.map(x => x.symbol).filter(Boolean);
    const quotes = await fetchByTickers(tickers);
    const quoteMap = toMap(quotes);
    const scored = entries.map(e => {
      const q = quoteMap.get(e.symbol.toUpperCase());
      const fw = feedbackWeight(feedback, market, e.symbol.toUpperCase());
      const { finalScore, scoreAudit } = scoreItem(e, q, fw, market);
      return { ...e, score: finalScore, audit: enableAudit ? scoreAudit : undefined };
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
