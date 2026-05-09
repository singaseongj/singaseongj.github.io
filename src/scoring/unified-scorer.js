/**
 * 🧠 Unified Scoring Module for buildPoolsTrendy.js
 * 
 * 통합 점수 엔진: 규칙 기반 + ML 예측 + 앙상블 투표
 * 
 * 사용 방법:
 * 1. import { UnifiedScorer } from './unified-scorer.js';
 * 2. const scorer = new UnifiedScorer();
 * 3. const result = scorer.scoreItem(name, data);
 */

// ============================================================
// 1. 규칙 기반 평가자 (Rule-Based Scorer)
// ============================================================

class RuleBasedScorer {
  constructor() {
    this.rules = {
      pe: {
        excellent: [0, 15],
        good: [15, 20],
        fair: [20, 30],
        poor: [30, 50],
        terrible: [50, Infinity]
      },
      roe: {
        excellent: [20, Infinity],
        good: [15, 20],
        fair: [10, 15],
        poor: [5, 10],
        terrible: [-Infinity, 5]
      },
      rsi: {
        overbought: [70, 100],
        strong: [60, 70],
        neutral: [40, 60],
        weak: [30, 40],
        oversold: [0, 30]
      },
      volumeSpike: {
        extreme: [3, Infinity],
        significant: [1.5, 3],
        normal: [0.8, 1.5],
        weak: [0, 0.8]
      }
    };
  }

  /**
   * buildPoolsTrendy.js의 byName[n] 데이터로 점수 계산
   */
  scoreFromMetrics(data) {
    let points = 50; // 기본값

    // 뉴스 점수 (0~1)
    if (typeof data.newsScore === 'number') {
      points += data.newsScore * 25;
    }

    // Naver 인기도 (0~1)
    if (typeof data.naverPopularity === 'number') {
      points += data.naverPopularity * 20;
    }

    // 감정 분석
    if (typeof data.sentiment === 'number') {
      if (data.sentiment > 0.5) points += 15;
      else if (data.sentiment > 0) points += 8;
      else if (data.sentiment < -0.5) points -= 15;
      else if (data.sentiment < 0) points -= 8;
    }

    // 블로그 언급
    if (typeof data.blogMentions === 'number' && data.blogMentions > 0) {
      points += Math.min(15, data.blogMentions / 5);
    }

    // 위키 조회
    if (typeof data.wikiViews === 'number' && data.wikiViews > 100) {
      points += 10;
    }

    // 뉴스 7일 변화
    if (typeof data.ds_news7 === 'number') {
      points += data.ds_news7 * 15;
    }

    // Naver 카운트
    if (typeof data.naverCount === 'number' && data.naverCount > 100) {
      points += 10;
    }

    return Math.min(100, Math.max(0, points));
  }

  /**
   * 범위에 따라 점수 매핑
   */
  mapToScore(value, range) {
    for (const [category, [min, max]] of Object.entries(range)) {
      if (value >= min && value < max) {
        const scores = {
          'excellent': 90, 'good': 75, 'fair': 50, 'poor': 25, 'terrible': 10,
          'overbought': 60, 'strong': 80, 'neutral': 50, 'weak': 25, 'oversold': 70,
          'extreme': 85, 'significant': 75, 'normal': 50
        };
        return scores[category] || 50;
      }
    }
    return 50;
  }
}

// ============================================================
// 2. ML 강화 평가자 (ML-Enhanced Scorer)
// ============================================================

class MLEnhancedScorer {
  constructor() {
    this.weights = null;
    this.trained = false;
  }

  /**
   * 과거 점수 데이터로 모델 학습
   * historicalData: [{ features: {...}, score: 0-100 }, ...]
   */
  train(historicalData) {
    if (!historicalData || historicalData.length < 5) {
      this.initializeDefaultWeights();
      return;
    }

    this.weights = {};
    const features = historicalData.map(d => d.features);
    const labels = historicalData.map(d => d.score);

    const featureNames = features.length > 0 ? Object.keys(features[0]) : [];

    for (const feature of featureNames) {
      let correlation = 0;
      let count = 0;

      for (let i = 0; i < features.length; i++) {
        const value = features[i][feature] || 0;
        const label = labels[i] || 50;
        correlation += (value - 50) * (label - 50);
        count++;
      }

      this.weights[feature] = correlation / Math.max(count, 1) / 100;
    }

    this.weights.bias = 50;
    this.trained = true;
  }

  initializeDefaultWeights() {
    this.weights = {
      newsScore: 0.3,
      naverPopularity: 0.25,
      sentiment: 0.2,
      blogMentions: 0.1,
      wikiViews: 0.05,
      bias: 50
    };
  }

  /**
   * 피처로 점수 예측
   */
  predict(features) {
    if (!this.weights) {
      this.initializeDefaultWeights();
    }

    let score = this.weights.bias || 50;

    for (const [key, weight] of Object.entries(this.weights)) {
      if (key !== 'bias' && features[key] !== undefined) {
        score += features[key] * weight;
      }
    }

    return Math.min(100, Math.max(0, score));
  }
}

// ============================================================
// 3. 통합 평가 엔진 (Unified Scorer)
// ============================================================

export class UnifiedScorer {
  constructor() {
    this.ruleBased = new RuleBasedScorer();
    this.mlBased = new MLEnhancedScorer();
    this.historicalData = [];
  }

  /**
   * 과거 메트릭으로 ML 모델 학습
   */
  trainFromHistorical(previousMetrics) {
    if (!previousMetrics) return;

    const historicalData = [];

    for (const [market, metrics] of Object.entries(previousMetrics)) {
      for (const [name, data] of Object.entries(metrics || {})) {
        if (typeof data.score === 'number') {
          historicalData.push({
            features: {
              newsScore: data.newsScore || 0,
              naverPopularity: data.naverPopularity || 0,
              sentiment: data.sentiment || 0,
              blogMentions: data.blogMentions || 0,
              wikiViews: data.wikiViews || 0
            },
            score: data.score
          });
        }
      }
    }

    if (historicalData.length > 0) {
      this.mlBased.train(historicalData);
      console.log(`[UnifiedScorer] ML 모델 학습 완료: ${historicalData.length}개 샘플`);
    }
  }

  /**
   * 개별 종목 점수 계산
   */
  scoreItem(name, data) {
    const ruleScore = this.ruleBased.scoreFromMetrics(data);
    const mlScore = this.scoreSingleML(data);

    // 신뢰도: 두 모델의 합의도
    const agreement = 1 - Math.abs(ruleScore - mlScore) / 100;
    const confidence = Math.max(0.5, agreement);

    // 최종 점수: 앙상블 투표
    const finalScore = ruleScore * 0.6 + mlScore * 0.4;

    return {
      name,
      score: Math.round(finalScore),
      ruleScore: Math.round(ruleScore),
      mlScore: Math.round(mlScore),
      confidence,
      reasoning: this.generateReasoning(data, ruleScore, mlScore)
    };
  }

  /**
   * ML 기반 개별 점수
   */
  scoreSingleML(data) {
    const features = {
      newsScore: data.newsScore || 0,
      naverPopularity: data.naverPopularity || 0,
      sentiment: data.sentiment || 0,
      blogMentions: data.blogMentions || 0,
      wikiViews: data.wikiViews || 0
    };

    return this.mlBased.predict(features);
  }

  /**
   * 점수 결정 이유 생성
   */
  generateReasoning(data, ruleScore, mlScore) {
    const reasons = [];

    if (data.newsScore && data.newsScore > 0.7) {
      reasons.push('✓ 강한 뉴스 신호');
    }

    if (data.naverPopularity && data.naverPopularity > 0.6) {
      reasons.push('✓ 높은 Naver 인기도');
    }

    if (data.sentiment && data.sentiment > 0.5) {
      reasons.push('✓ 긍정적 감정');
    }

    if (data.blogMentions && data.blogMentions > 50) {
      reasons.push('✓ 블로그 언급 많음');
    }

    if (Math.abs(ruleScore - mlScore) > 20) {
      reasons.push('⚠ 모델 간 의견 불일치');
    }

    return reasons.join(' | ') || '중립적 신호';
  }

  /**
   * 마켓 전체 점수 계산
   */
  scoreMarket(byName, previousMetrics = null) {
    // ML 학습
    if (previousMetrics) {
      this.trainFromHistorical(previousMetrics);
    }

    const results = {};

    for (const [name, data] of Object.entries(byName || {})) {
      results[name] = this.scoreItem(name, data);
    }

    return results;
  }

  /**
   * 추천 생성
   */
  generateRecommendations(results, limit = 10) {
    const sorted = Object.values(results)
      .filter(r => r.score >= 60)
      .sort((a, b) => b.score - a.score);

    return {
      recommendations: sorted.slice(0, limit),
      avgScore: (sorted.reduce((sum, r) => sum + r.score, 0) / Math.max(sorted.length, 1)).toFixed(1),
      count: sorted.length
    };
  }
}

// ============================================================
// 4. buildPoolsTrendy.js 통합 헬퍼
// ============================================================

/**
 * buildPoolsTrendy.js의 점수 계산에 통합
 */
export function integrateUnifiedScoringIntoBuilPoolsTrendy(
  byName,           // 기존 byName 객체
  newsFeatures,     // 기존 newsFeatures 객체
  previousMetrics,  // 이전 메트릭
  market            // 현재 마켓명
) {
  const scorer = new UnifiedScorer();
  
  // ML 모델 학습
  if (previousMetrics && previousMetrics[market]) {
    scorer.trainFromHistorical({ [market]: previousMetrics[market] });
  }

  // 점수 계산
  const scores = scorer.scoreMarket(byName, previousMetrics);

  // byName에 통합 점수 추가
  for (const [name, scoreData] of Object.entries(scores)) {
    if (byName[name]) {
      byName[name].unifiedScore = scoreData.score;
      byName[name].scoreBreakdown = {
        ruleScore: scoreData.ruleScore,
        mlScore: scoreData.mlScore,
        confidence: scoreData.confidence,
        reasoning: scoreData.reasoning
      };
    }
  }

  // 추천 생성
  const recommendations = scorer.generateRecommendations(scores);
  
  console.log(`[UnifiedScorer] ${market} - 평균: ${recommendations.avgScore}, 개수: ${recommendations.count}`);

  return {
    byName,
    recommendations,
    scores
  };
}

// ============================================================
// 5. 테스트/데모
// ============================================================

export async function demonstrateUnifiedScoring() {
  const scorer = new UnifiedScorer();

  // 샘플 데이터
  const sampleData = {
    'Apple Inc.': {
      newsScore: 0.75,
      naverPopularity: 0.6,
      sentiment: 0.5,
      blogMentions: 120,
      wikiViews: 5000,
      naverCount: 150
    },
    'Microsoft': {
      newsScore: 0.68,
      naverPopularity: 0.55,
      sentiment: 0.45,
      blogMentions: 95,
      wikiViews: 3500,
      naverCount: 120
    },
    'Tesla': {
      newsScore: 0.85,
      naverPopularity: 0.7,
      sentiment: 0.6,
      blogMentions: 150,
      wikiViews: 6000,
      naverCount: 200
    }
  };

  // 점수 계산
  const results = scorer.scoreMarket(sampleData);

  console.log('\n=== 통합 점수 계산 결과 ===');
  for (const [name, result] of Object.entries(results)) {
    console.log(`${name}:`);
    console.log(`  최종 점수: ${result.score}점`);
    console.log(`  규칙 기반: ${result.ruleScore}점`);
    console.log(`  ML 기반: ${result.mlScore}점`);
    console.log(`  신뢰도: ${(result.confidence * 100).toFixed(0)}%`);
    console.log(`  이유: ${result.reasoning}`);
    console.log('');
  }

  // 추천
  const recommendations = scorer.generateRecommendations(results);
  console.log(`\n추천 (${recommendations.count}개, 평균: ${recommendations.avgScore}점)`);
  recommendations.recommendations.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.name}: ${r.score}점`);
  });
}

// 직접 실행 시
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateUnifiedScoring().catch(console.error);
}
