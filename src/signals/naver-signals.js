/**
 * Naver Signals Unification
 *
 * 문제: 현재 buildPoolsTrendy.js에서 Naver 데이터가 여러 곳에서 조각나 있음
 * - NEWS_FEATURES[sym].naverPopularity
 * - NAVER_TRENDS[sym].naverPopularity
 * - naverFinanceScore (별도 API)
 * - naverAsvi, naverSpike (trend data)
 *
 * 해결: 단일 진실 공급원(Single Source of Truth) 구현
 */

/**
 * Naver 신호의 표준 형식 (canonical form)
 */
class NaverSignal {
  constructor(data = {}) {
    // 모든 Naver 관련 데이터를 한 곳에
    this.popularity = data.popularity ?? 0; // 0..1, 가장 신뢰도 높은 값
    this.asvi = data.asvi ?? 0; // ASVI 값 (검색 트렌드)
    this.spike = data.spike ?? false; // 급등 여부
    this.persist = data.persist ?? false; // 지속 여부
    this.finance = data.finance ?? null; // Naver Finance 데이터
    this.financeScore = data.financeScore ?? 0; // 0..1
    this.financeVolume = data.financeVolume ?? 0; // 거래량
    this.financeAmount = data.financeAmount ?? 0; // 거래대금 (만원)

    // 메타데이터: 어느 소스에서 왔는가?
    this.sources = data.sources ?? {
      popularity: null,
      asvi: null,
      spike: null,
      persist: null,
      finance: null
    };

    // 데이터 신뢰도 (0..1)
    this.confidence = data.confidence ?? {};

    // 마지막 업데이트 시간
    this.updatedAt = data.updatedAt ?? null;
  }

  /**
   * 데이터 유효성 확인
   */
  isValid() {
    return this.popularity >= 0 && this.popularity <= 1 &&
      this.asvi >= -100 && this.asvi <= 100 &&
      typeof this.spike === 'boolean' &&
      typeof this.persist === 'boolean';
  }

  /**
   * 점수에 사용할 권장 popularity 값 반환
   * (신뢰도 가중평균 또는 우선순위 기반 선택)
   */
  getRecommendedPopularity() {
    // 신뢰도에 따라 선택
    const candidates = [];

    if (this.sources.popularity === 'trends' && this.confidence.popularity > 0.85) {
      candidates.push({ value: this.popularity, confidence: 0.95, source: 'trends_live' });
    }

    if (this.sources.popularity === 'features' && this.confidence.popularity > 0.7) {
      candidates.push({ value: this.popularity, confidence: 0.80, source: 'features_cache' });
    }

    if (this.financeScore > 0) {
      candidates.push({ value: this.financeScore, confidence: 0.65, source: 'finance_scraped' });
    }

    if (!candidates.length) {
      return { value: 0, confidence: 0, source: 'default' };
    }

    // 신뢰도 기반 가중평균
    const sumWeights = candidates.reduce((s, c) => s + c.confidence, 0);
    const weightedAvg = candidates.reduce((s, c) => s + c.value * c.confidence, 0) / sumWeights;

    return {
      value: Math.max(0, Math.min(1, weightedAvg)),
      confidence: sumWeights / candidates.length,
      source: candidates[0].source,
      candidates: candidates.map(c => ({ value: c.value, confidence: c.confidence }))
    };
  }

  /**
   * 부스트 기여도 계산
   * (spike와 persist로 인한 추가 점수)
   */
  getBoostValue() {
    let boost = 0;

    if (this.spike) {
      boost += 0.05; // spike 감지 시 +5%
    }

    if (this.persist) {
      boost += 0.03; // persist 감지 시 +3%
    }

    // ASVI 양수면 추가 부스트
    if (this.asvi > 5) {
      const asviBoost = Math.min(0.08, Math.log1p(Math.abs(this.asvi)) / 100);
      boost += asviBoost;
    }

    return Math.min(0.15, boost); // 최대 +15%
  }

  /**
   * 진단 정보 반환
   */
  getDiagnostics() {
    return {
      popularity: {
        value: this.popularity,
        source: this.sources.popularity,
        confidence: this.confidence.popularity ?? 0
      },
      asvi: {
        value: this.asvi,
        source: this.sources.asvi,
        confidence: this.confidence.asvi ?? 0
      },
      spike: {
        value: this.spike,
        source: this.sources.spike
      },
      persist: {
        value: this.persist,
        source: this.sources.persist
      },
      finance: {
        score: this.financeScore,
        volume: this.financeVolume,
        amount: this.financeAmount,
        source: this.sources.finance
      },
      recommended: this.getRecommendedPopularity(),
      boost: this.getBoostValue(),
      isValid: this.isValid(),
      updatedAt: this.updatedAt
    };
  }
}

/**
 * Naver 신호 통합 수집기
 *
 * 사용:
 *   const collector = new NaverSignalCollector(symbol);
 *   const signal = await collector.collect();
 */
class NaverSignalCollector {
  constructor(symbol, context = {}) {
    this.symbol = symbol;
    this.context = context; // { NEWS_FEATURES, NAVER_TRENDS, isKR, ... }
  }

  async collect() {
    const signal = new NaverSignal();
    signal.updatedAt = new Date().toISOString();

    // === 1. 인기도 데이터 수집 ===
    this._collectPopularity(signal);

    // === 2. ASVI 데이터 수집 ===
    this._collectAsvi(signal);

    // === 3. Spike/Persist 수집 ===
    this._collectTrendIndicators(signal);

    // === 4. Naver Finance 데이터 (KR만) ===
    if (this.context.isKR) {
      await this._collectFinanceData(signal);
    }

    // === 5. 유효성 검증 ===
    if (!signal.isValid()) {
      console.warn(`[naver-signal] ${this.symbol} invalid data`, signal.getDiagnostics());
    }

    return signal;
  }

  /**
   * 인기도 데이터 통합
   * 우선순위: Trends (live) > Features (cached) > Finance (scraped) > Default
   */
  _collectPopularity(signal) {
    let selected = null;
    let confidence = 0;

    // 1순위: NAVER_TRENDS (가장 신뢰도 높음 - 실시간)
    if (this.context.NAVER_TRENDS?.[this.symbol]?.naverPopularity != null) {
      const value = this.context.NAVER_TRENDS[this.symbol].naverPopularity;
      if (this._isValidPopularity(value)) {
        selected = value;
        confidence = 0.95;
        signal.sources.popularity = 'trends';
      }
    }

    // 2순위: NEWS_FEATURES (캐시됨 - 중간 신뢰도)
    if (!selected && this.context.NEWS_FEATURES?.[this.symbol]?.naverPopularity != null) {
      const value = this.context.NEWS_FEATURES[this.symbol].naverPopularity;
      if (this._isValidPopularity(value)) {
        selected = value;
        confidence = 0.80;
        signal.sources.popularity = 'features';
      }
    }

    // 3순위: Naver Finance (웹 스크래핑 - 낮은 신뢰도)
    if (!selected && this.context.naverFinanceData?.[this.symbol] != null) {
      const value = this.context.naverFinanceData[this.symbol];
      if (this._isValidPopularity(value)) {
        selected = value;
        confidence = 0.65;
        signal.sources.popularity = 'finance';
      }
    }

    signal.popularity = selected ?? 0;
    signal.confidence.popularity = confidence;
  }

  /**
   * ASVI (Aggregated Search Volume Index) 수집
   */
  _collectAsvi(signal) {
    let value = null;
    let source = null;

    // Trends에서 ASVI 우선 추출
    if (this.context.NAVER_TRENDS?.[this.symbol]?.lastAsvi != null) {
      value = this.context.NAVER_TRENDS[this.symbol].lastAsvi;
      source = 'trends';
    }

    // Features에서 보조 추출
    if (value == null && this.context.NEWS_FEATURES?.[this.symbol]?.naverAsvi != null) {
      value = this.context.NEWS_FEATURES[this.symbol].naverAsvi;
      source = 'features';
    }

    // 음수 ASVI는 0으로 처리 (하락 무시)
    const ASVI_NEGATIVE_FLOOR = this.context.ASVI_NEGATIVE_FLOOR ?? 0;
    if (Number.isFinite(value) && value < ASVI_NEGATIVE_FLOOR) {
      value = 0;
    }

    signal.asvi = Number.isFinite(value) ? value : 0;
    signal.sources.asvi = source;
    signal.confidence.asvi = source ? 0.85 : 0;
  }

  /**
   * Spike와 Persist 플래그 수집
   */
  _collectTrendIndicators(signal) {
    // Spike: Trends 또는 Features에서 가져오기
    signal.spike = Boolean(
      this.context.NAVER_TRENDS?.[this.symbol]?.spike ??
      this.context.NEWS_FEATURES?.[this.symbol]?.naverSpike
    );
    signal.sources.spike = 'trends|features';

    // Persist: Trends 또는 Features에서 가져오기
    signal.persist = Boolean(
      this.context.NAVER_TRENDS?.[this.symbol]?.persist ??
      this.context.NEWS_FEATURES?.[this.symbol]?.naverPersist
    );
    signal.sources.persist = 'trends|features';
  }

  /**
   * Naver Finance 데이터 수집 (KR 주식만)
   */
  async _collectFinanceData(signal) {
    try {
      const finance = await this.context.fetchNaverFinanceSignals?.(this.symbol);
      if (finance) {
        signal.financeScore = finance.score ?? 0;
        signal.financeVolume = finance.volume ?? 0;
        signal.financeAmount = finance.amountMkrw ?? 0;
        signal.finance = finance;
        signal.sources.finance = 'naver_finance';
        signal.confidence.finance = 0.65;
      }
    } catch (err) {
      console.warn(`[naver-signal] finance fetch failed for ${this.symbol}:`, err.message);
    }
  }

  _isValidPopularity(value) {
    return typeof value === 'number' && value >= 0 && value <= 1;
  }
}

/**
 * 기존 코드와의 호환성을 위한 래퍼
 * (점진적 마이그레이션 지원)
 */
class NaverSignalCache {
  constructor() {
    this.cache = new Map(); // symbol -> NaverSignal
  }

  async getOrCollect(symbol, collector) {
    if (this.cache.has(symbol)) {
      return this.cache.get(symbol);
    }

    const signal = await collector.collect();
    this.cache.set(symbol, signal);
    return signal;
  }

  /**
   * 기존 mergeNaverSignals() 함수의 대체
   *
   * 기존:
   *   const navSignals = mergeNaverSignals(nf, trend);
   *   naverPopularity = navSignals.combined;
   *
   * 신규:
   *   const signal = signalCache.get(symbol);
   *   const pop = signal.getRecommendedPopularity();
   *   naverPopularity = pop.value;
   *   naverBoost = signal.getBoostValue();
   */
  get(symbol) {
    return this.cache.get(symbol) ?? new NaverSignal(); // fallback
  }

  clear() {
    this.cache.clear();
  }

  getMetrics() {
    const items = Array.from(this.cache.values());
    return {
      totalSignals: items.length,
      validSignals: items.filter(s => s.isValid()).length,
      avgConfidence: items.reduce((s, sig) => s + sig.confidence.popularity, 0) / Math.max(1, items.length),
      sources: {
        trends: items.filter(s => s.sources.popularity === 'trends').length,
        features: items.filter(s => s.sources.popularity === 'features').length,
        finance: items.filter(s => s.sources.popularity === 'finance').length,
        default: items.filter(s => !s.sources.popularity).length
      }
    };
  }
}

export { NaverSignal, NaverSignalCollector, NaverSignalCache };
