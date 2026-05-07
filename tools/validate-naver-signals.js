#!/usr/bin/env node
/**
 * Naver Signal Integration Validation
 * 
 * 사용: node tools/validate-naver-signals.js
 * 
 * 목적:
 * - 신규 NaverSignalCollector 구현 검증
 * - 기존 데이터와의 일관성 확인
 * - 신뢰도 분포 분석
 */

import fs from 'fs/promises';
import path from 'path';
import { NaverSignal, NaverSignalCollector, NaverSignalCache } from '../src/signals/naver-signals.js';

const CACHE_DIR = 'cache';
const TEST_SYMBOLS = [
  // 한국 주식 (샘플)
  '005930.KS',  // 삼성전자
  '000660.KS',  // SK하이닉스
  '035420.KS',  // NAVER
  '035720.KS',  // 카카오
  
  // US 주식 (샘플)
  'AAPL',       // Apple
  'MSFT',       // Microsoft
  'TSLA',       // Tesla
  'NVDA',       // NVIDIA
];

class NaverSignalValidator {
  constructor() {
    this.results = {
      passed: 0,
      failed: 0,
      warnings: 0,
      tests: []
    };
    this.cache = new NaverSignalCache();
  }

  async runAll() {
    console.log('🧪 Starting Naver Signal Integration Validation\n');

    await this.testSignalConstruction();
    await this.testDataSources();
    await this.testRecommendedPopularity();
    await this.testBoostCalculation();
    await this.testValidation();
    await this.testConfidenceScoring();
    await this.testDataQualityMetrics();

    this.printSummary();
  }

  /**
   * Test 1: NaverSignal 객체 구성
   */
  async testSignalConstruction() {
    console.log('Test 1: Signal Construction');
    
    const signal = new NaverSignal({
      popularity: 0.75,
      asvi: 42,
      spike: true,
      persist: false,
      sources: {
        popularity: 'trends',
        asvi: 'trends'
      },
      confidence: {
        popularity: 0.95,
        asvi: 0.85
      }
    });

    this.assert(signal.popularity === 0.75, 'popularity stored correctly');
    this.assert(signal.spike === true, 'spike stored correctly');
    this.assert(signal.isValid(), 'signal validation passes');
    this.assert(signal.sources.popularity === 'trends', 'source tracking works');
    
    console.log('✓ Signal Construction passed\n');
  }

  /**
   * Test 2: 다양한 데이터 소스 처리
   */
  async testDataSources() {
    console.log('Test 2: Data Sources Priority');

    // Scenario 1: Trends가 최우선
    const mockContext1 = {
      NAVER_TRENDS: {
        'TEST1': { naverPopularity: 0.9, lastAsvi: 50, spike: true, persist: false }
      },
      NEWS_FEATURES: {
        'TEST1': { naverPopularity: 0.5 }
      },
      ASVI_NEGATIVE_FLOOR: 0
    };

    const collector1 = new NaverSignalCollector('TEST1', mockContext1);
    const signal1 = await collector1.collect();

    this.assert(
      signal1.popularity === 0.9 && signal1.sources.popularity === 'trends',
      'Trends source has priority over Features'
    );

    // Scenario 2: Features 폴백
    const mockContext2 = {
      NAVER_TRENDS: {},
      NEWS_FEATURES: {
        'TEST2': { naverPopularity: 0.6, naverAsvi: 30 }
      },
      ASVI_NEGATIVE_FLOOR: 0
    };

    const collector2 = new NaverSignalCollector('TEST2', mockContext2);
    const signal2 = await collector2.collect();

    this.assert(
      signal2.popularity === 0.6 && signal2.sources.popularity === 'features',
      'Features acts as fallback'
    );

    console.log('✓ Data Sources Priority passed\n');
  }

  /**
   * Test 3: getRecommendedPopularity() 로직
   */
  async testRecommendedPopularity() {
    console.log('Test 3: Recommended Popularity Calculation');

    // Scenario: 여러 소스에서 서로 다른 값
    const signal = new NaverSignal({
      popularity: 0.75,
      sources: {
        popularity: 'trends'
      },
      confidence: {
        popularity: 0.95
      }
    });

    const recommended = signal.getRecommendedPopularity();

    this.assert(
      typeof recommended.value === 'number' && recommended.value >= 0 && recommended.value <= 1,
      'Recommended value is normalized (0..1)'
    );
    this.assert(
      recommended.confidence > 0,
      'Confidence score is positive'
    );
    this.assert(
      typeof recommended.source === 'string',
      'Source is identified'
    );

    console.log('✓ Recommended Popularity passed\n');
  }

  /**
   * Test 4: 부스트 계산
   */
  async testBoostCalculation() {
    console.log('Test 4: Boost Calculation');

    // Scenario 1: Spike만 있음
    const signal1 = new NaverSignal({ spike: true, persist: false, asvi: 0 });
    const boost1 = signal1.getBoostValue();
    this.assert(
      boost1 >= 0.05 && boost1 <= 0.1,
      `Spike-only boost is in range: ${boost1.toFixed(3)}`
    );

    // Scenario 2: Spike + Persist + ASVI
    const signal2 = new NaverSignal({ spike: true, persist: true, asvi: 50 });
    const boost2 = signal2.getBoostValue();
    this.assert(
      boost2 > boost1 && boost2 <= 0.15,
      `Combined boost is higher: ${boost2.toFixed(3)}`
    );

    // Scenario 3: 음수 ASVI는 무시
    const signal3 = new NaverSignal({ spike: false, persist: false, asvi: -20 });
    const boost3 = signal3.getBoostValue();
    this.assert(
      boost3 === 0,
      'Negative ASVI gives no boost'
    );

    console.log('✓ Boost Calculation passed\n');
  }

  /**
   * Test 5: 유효성 검증
   */
  async testValidation() {
    console.log('Test 5: Signal Validation');

    // Valid signal
    const validSignal = new NaverSignal({
      popularity: 0.5,
      asvi: 25,
      spike: false,
      persist: false
    });
    this.assert(validSignal.isValid(), 'Valid signal passes validation');

    // Invalid: popularity out of range
    const invalidSignal1 = new NaverSignal({
      popularity: 1.5, // > 1
      asvi: 25
    });
    this.assert(!invalidSignal1.isValid(), 'Detects out-of-range popularity');

    // Invalid: ASVI out of range
    const invalidSignal2 = new NaverSignal({
      popularity: 0.5,
      asvi: 150 // > 100
    });
    this.assert(!invalidSignal2.isValid(), 'Detects out-of-range ASVI');

    console.log('✓ Signal Validation passed\n');
  }

  /**
   * Test 6: 신뢰도 점수
   */
  async testConfidenceScoring() {
    console.log('Test 6: Confidence Scoring');

    const signal = new NaverSignal({
      popularity: 0.8,
      sources: { popularity: 'trends' },
      confidence: { popularity: 0.95 }
    });

    const diagnostics = signal.getDiagnostics();

    this.assert(
      diagnostics.recommended.confidence >= 0 && diagnostics.recommended.confidence <= 1,
      'Confidence is normalized (0..1)'
    );
    this.assert(
      diagnostics.popularity.confidence === 0.95,
      'Popularity confidence recorded'
    );
    this.assert(
      diagnostics.recommended.source === 'trends_live',
      'Source is identified in diagnostics'
    );

    console.log('✓ Confidence Scoring passed\n');
  }

  /**
   * Test 7: 데이터 품질 메트릭
   */
  async testDataQualityMetrics() {
    console.log('Test 7: Data Quality Metrics');

    // 캐시에 여러 신호 추가
    const cache = new NaverSignalCache();
    cache.cache.set('TEST1', new NaverSignal({
      popularity: 0.9,
      sources: { popularity: 'trends' },
      confidence: { popularity: 0.95 }
    }));
    cache.cache.set('TEST2', new NaverSignal({
      popularity: 0.5,
      sources: { popularity: 'features' },
      confidence: { popularity: 0.75 }
    }));
    cache.cache.set('TEST3', new NaverSignal({
      popularity: 0,
      sources: { popularity: null },
      confidence: { popularity: 0 }
    }));

    const metrics = cache.getMetrics();

    this.assert(metrics.totalSignals === 3, 'Total count is correct');
    this.assert(metrics.validSignals === 2, 'Valid count (excluding zero) is correct');
    this.assert(
      metrics.sources.trends === 1 && metrics.sources.features === 1 && metrics.sources.default === 1,
      'Source breakdown is accurate'
    );
    this.assert(
      metrics.avgConfidence > 0.5 && metrics.avgConfidence < 1,
      'Average confidence is reasonable'
    );

    console.log('✓ Data Quality Metrics passed\n');
  }

  /**
   * 성능 테스트 (선택)
   */
  async testPerformance() {
    console.log('Test 8: Performance (optional)');

    const context = {
      NAVER_TRENDS: {},
      NEWS_FEATURES: {}
    };

    // 1000개 신호 생성 성능 테스트
    const startTime = Date.now();
    for (let i = 0; i < 1000; i++) {
      new NaverSignal({
        popularity: Math.random(),
        asvi: Math.random() * 100 - 50,
        spike: Math.random() > 0.7,
        persist: Math.random() > 0.8
      });
    }
    const elapsed = Date.now() - startTime;

    console.log(`  ✓ Created 1000 signals in ${elapsed}ms (${(elapsed/1000).toFixed(2)}ms per signal)`);
    this.assert(elapsed < 100, 'Signal creation is fast (< 100ms for 1000)');

    console.log('✓ Performance test passed\n');
  }

  // === 헬퍼 메서드 ===

  assert(condition, message) {
    if (condition) {
      console.log(`  ✓ ${message}`);
      this.results.passed++;
    } else {
      console.log(`  ✗ FAILED: ${message}`);
      this.results.failed++;
    }
  }

  warn(message) {
    console.log(`  ⚠ WARNING: ${message}`);
    this.results.warnings++;
  }

  printSummary() {
    console.log('\n' + '='.repeat(60));
    console.log('📊 Validation Summary');
    console.log('='.repeat(60));
    console.log(`Passed:  ${this.results.passed}`);
    console.log(`Failed:  ${this.results.failed}`);
    console.log(`Warnings: ${this.results.warnings}`);

    const total = this.results.passed + this.results.failed;
    const passRate = total > 0 ? ((this.results.passed / total) * 100).toFixed(1) : 0;
    console.log(`Pass Rate: ${passRate}%`);

    if (this.results.failed === 0) {
      console.log('\n✅ All tests passed!');
      process.exit(0);
    } else {
      console.log('\n❌ Some tests failed.');
      process.exit(1);
    }
  }
}

// 실행
const validator = new NaverSignalValidator();
validator.runAll().catch(err => {
  console.error('Validation failed:', err);
  process.exit(1);
});
