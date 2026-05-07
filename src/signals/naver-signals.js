export class NaverSignal {
  constructor(symbol, data = {}) {
    this.symbol = symbol;
    this.popularity = Number(data.popularity || 0);
    this.asvi = Number(data.asvi || 0);
    this.spike = !!data.spike;
    this.persist = !!data.persist;
    this.financeScore = Number(data.financeScore || 0);
    this.financeVolume = Number(data.financeVolume || 0);
    this.financeAmount = Number(data.financeAmount || 0);
    this.sources = data.sources || { popularity: 'none', asvi: 'none' };
    this.confidence = data.confidence || { popularity: 0, asvi: 0 };
  }

  isValid() {
    return this.popularity > 0;
  }

  getBoostValue() {
    if (!this.isValid()) return 0;
    return Math.min(0.25, (this.spike ? 0.15 : 0) + (this.persist ? 0.1 : 0));
  }

  getRecommendedPopularity() {
    return {
      value: this.popularity,
      source: this.sources.popularity || 'none',
      confidence: this.confidence.popularity || 0
    };
  }
}

const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const toFlag = (v) => v === true || Number(v) > 0;
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

export class NaverSignalCollector {
  constructor(symbol, opts = {}) {
    this.symbol = symbol;
    this.opts = opts;
  }

  collect() {
    const { NAVER_TRENDS = {}, NEWS_FEATURES = {}, ASVI_NEGATIVE_FLOOR = 0, isKR = false } = this.opts;
    const trend = NAVER_TRENDS[this.symbol] || {};
    const feature = NEWS_FEATURES[this.symbol] || {};
    const featurePop = toNum(feature.naverPopularity);
    const trendPop = toNum(trend.naverPopularity ?? trend.popularity ?? trend.popularity01);
    const popularity = clamp01(Math.max(featurePop ?? 0, trendPop ?? 0));
    const asviRaw = toNum(feature.naverAsvi) ?? toNum(trend.lastAsvi ?? trend.naverAsvi) ?? 0;
    const asvi = asviRaw < ASVI_NEGATIVE_FLOOR ? 0 : asviRaw;
    const spike = toFlag(feature.naverSpike) || toFlag(trend.spike);
    const persist = toFlag(feature.naverPersist) || toFlag(trend.persist);

    const sources = {
      popularity: trendPop != null && trendPop >= (featurePop ?? 0) ? 'trends' : (featurePop != null ? 'features' : 'none'),
      asvi: toNum(feature.naverAsvi) != null ? 'features' : (toNum(trend.lastAsvi ?? trend.naverAsvi) != null ? 'trends' : 'none')
    };

    const confidence = {
      popularity: popularity > 0 ? (sources.popularity === 'trends' ? 0.85 : 0.75) : 0,
      asvi: asvi !== 0 ? 0.8 : 0
    };

    const financeScore = isKR ? Number(feature.naverFinanceScore || 0) : 0;
    const financeVolume = isKR ? Number(feature.naverFinanceVolume || 0) : 0;
    const financeAmount = isKR ? Number(feature.naverFinanceAmountMkrw || 0) : 0;

    return new NaverSignal(this.symbol, { popularity, asvi, spike, persist, financeScore, financeVolume, financeAmount, sources, confidence });
  }
}

export class NaverSignalCache {
  constructor() {
    this.cache = new Map();
  }

  get(symbol) {
    return this.cache.get(symbol);
  }

  getMetrics() {
    const values = Array.from(this.cache.values());
    const totalSignals = values.length;
    const valid = values.filter(v => v && v.isValid());
    const avgConfidence = valid.length ? valid.reduce((a, v) => a + (v.confidence.popularity || 0), 0) / valid.length : 0;
    const sources = valid.reduce((acc, v) => {
      const k = v.sources?.popularity || 'none';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    return { totalSignals, validSignals: valid.length, avgConfidence, sources };
  }
}
