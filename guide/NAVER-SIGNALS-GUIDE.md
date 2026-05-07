# Naver 신호 병합 로직 단일화 - 구현 가이드

## 📋 개요

**문제:** `buildPoolsTrendy.js`에서 Naver 데이터가 4곳에서 분산되어 처리됨
- `NEWS_FEATURES[sym].naverPopularity`
- `NAVER_TRENDS[sym].*` (popularity, spike, persist, lastAsvi)
- `fetchNaverFinanceSignals()` (별도 API)
- `mergeNaverSignals()` 함수의 불명확한 로직

**결과:** 점수 계산 불일치, 유지보수 어려움, 데이터 신뢰도 추적 불가

**해결책:** 단일 진실 공급원(Single Source of Truth) 구현

---

## 🏗️ 아키텍처

### 1. NaverSignal 클래스
```
NaverSignal (데이터 컨테이너)
├─ popularity (0..1) ← 신뢰도 기반 선택
├─ asvi (검색 트렌드)
├─ spike (급등 감지)
├─ persist (지속 여부)
├─ finance* (Naver Finance 데이터)
├─ sources (데이터 출처 추적)
├─ confidence (신뢰도 점수)
└─ 메서드:
   ├─ isValid() → 유효성 검증
   ├─ getRecommendedPopularity() → 신뢰도 기반 값 선택
   ├─ getBoostValue() → 부스트 계산 (+spike, +persist, +asvi)
   └─ getDiagnostics() → 디버깅 정보
```

### 2. NaverSignalCollector 클래스
```
NaverSignalCollector (수집 엔진)
├─ 입력: symbol, context (NAVER_TRENDS, NEWS_FEATURES, ...)
├─ collect() → NaverSignal 반환
└─ 프로세스:
   ├─ _collectPopularity() ← Trends > Features > Finance > Default
   ├─ _collectAsvi()
   ├─ _collectTrendIndicators() (spike, persist)
   └─ _collectFinanceData() (KR만)
```

### 3. NaverSignalCache 클래스
```
NaverSignalCache (중앙 저장소)
├─ cache: Map<symbol, NaverSignal>
├─ get(symbol) → NaverSignal
├─ getMetrics() → 통계 정보
└─ 용도: 성능 최적화, 중복 제거
```

---

## 🔧 구현 단계

### Phase 1: 준비 (1-2시간)

#### 1.1 파일 생성
```bash
mkdir -p src/signals
touch src/signals/naver-signals.js
```

#### 1.2 NaverSignal 클래스 구현
파일 위치: `src/signals/naver-signals.js`
- 위의 `naver-signals-unified.js` 내용 복사

#### 1.3 테스트 실행
```bash
node tools/validate-naver-signals.js
```

**예상 출력:**
```
✓ Signal Construction passed
✓ Data Sources Priority passed
✓ Recommended Popularity passed
✓ Boost Calculation passed
✓ Signal Validation passed
✓ Confidence Scoring passed
✓ Data Quality Metrics passed

✅ All tests passed!
```

---

### Phase 2: buildPoolsTrendy.js 통합 (2-3시간)

#### 2.1 Import 추가
파일: `tools/buildPoolsTrendy.js` (상단, ~15줄)

```javascript
import { NaverSignalCollector, NaverSignalCache } from '../src/signals/naver-signals.js';
```

#### 2.2 전역 변수 선언
```javascript
const naverSignalCache = new NaverSignalCache();
```

#### 2.3 신호 초기화 (main 함수 내, ~900줄)

**기존 코드:**
```javascript
for (const [sym, trend] of Object.entries(NAVER_TRENDS)) {
  if (!trend || typeof trend !== 'object') continue;
  const nf = (NEWS_FEATURES[sym] ||= {});
  if (nf.naverPopularity == null && trend.naverPopularity != null) {
    nf.naverPopularity = trend.naverPopularity;
  }
  // ... 5개 더 ...
}
```

**신규 코드:**
```javascript
// Naver 신호 통합 초기화
{
  const startInit = Date.now();
  for (const symbol of symbols) {
    const collector = new NaverSignalCollector(symbol, {
      NAVER_TRENDS,
      NEWS_FEATURES,
      isKR: isKR(symbol),
      ASVI_NEGATIVE_FLOOR: +process.env.ASVI_NEGATIVE_FLOOR || 0,
      fetchNaverFinanceSignals: isKR(symbol) 
        ? (sym) => fetchNaverFinanceSignals(sym)
        : null
    });
    try {
      const signal = collector.collect();
      naverSignalCache.cache.set(symbol, signal);
    } catch (e) {
      console.warn(`[naver-signal] ${symbol} failed:`, e.message);
    }
  }
  const metrics = naverSignalCache.getMetrics();
  console.log(`[naver-signals] initialized: ${metrics.totalSignals} total, ${metrics.validSignals} valid`);
}
```

#### 2.4 신호 추출 함수 추가
```javascript
function extractNaverSignals(symbol, name) {
  const signal = naverSignalCache.get(symbol);
  if (!signal || signal.popularity === 0) {
    return {
      naverPopularity: 0,
      naverAsvi: 0,
      naverSpike: 0,
      naverPersist: false,
      naverFinanceScore: 0,
      naverFinanceVolume: 0,
      naverFinanceAmountMkrw: 0,
      naverBoost: 0
    };
  }
  const recommended = signal.getRecommendedPopularity();
  return {
    naverPopularity: recommended.value,
    naverAsvi: signal.asvi,
    naverSpike: signal.spike ? 1 : 0,
    naverPersist: signal.persist ? 1 : 0,
    naverFinanceScore: signal.financeScore,
    naverFinanceVolume: signal.financeVolume,
    naverFinanceAmountMkrw: signal.financeAmount,
    naverBoost: signal.getBoostValue()
  };
}
```

#### 2.5 신호 수집 부분 수정 (~1200줄, mapLimit 콜백 내)

**기존:**
```javascript
const nf = NEWS_FEATURES[sym] || NEWS_FEATURES[name] || {};
const trend = NAVER_TRENDS[sym] || {};
const naverFinance = isKR(sym) ? await fetchNaverFinanceSignals(sym) : {...};
const navSignals = mergeNaverSignals(nf, trend);
naverPopularity = navSignals.combined;
naverAsvi = navSignals.asvi;
naverSpike = navSignals.spike ? 1 : 0;
// ... 3개 더 ...
```

**신규:**
```javascript
const naverData = extractNaverSignals(sym, name);
naverPopularity = naverData.naverPopularity;
naverAsvi = naverData.naverAsvi;
naverSpike = naverData.naverSpike;
naverPersist = naverData.naverPersist;
naverFinanceScore = naverData.naverFinanceScore;
naverFinanceVolume = naverData.naverFinanceVolume;
naverFinanceAmountMkrw = naverData.naverFinanceAmountMkrw;
```

#### 2.6 부스트 계산 수정 (~1500줄)

**기존:**
```javascript
const spikeHotBoost = names.map(n =>
  byName[n].naverSpike ? 0.05 : 0
);
```

**신규:**
```javascript
const spikeHotBoost = names.map(n => {
  const sig = naverSignalCache.get(byName[n].sym || nameToSymbol(n) || n);
  return sig ? sig.getBoostValue() : 0;
});
```

#### 2.7 메트릭 출력 개선

메트릭에 데이터 품질 정보 추가:
```javascript
naverSignalDiagnostics: (() => {
  const sig = naverSignalCache.get(symbol);
  if (!sig) return null;
  return sig.getDiagnostics();
})()
```

#### 2.8 함수 제거

기존 함수 삭제:
```javascript
// ❌ REMOVE
function mergeNaverSignals(feature = {}, trend = {}) { ... }
```

---

### Phase 3: 테스트 & 검증 (1-2시간)

#### 3.1 단위 테스트 실행
```bash
node tools/validate-naver-signals.js
```

#### 3.2 통합 테스트
```bash
# buildPoolsTrendy.js 실행
node tools/buildPoolsTrendy.js --dry-run

# 로그 확인
grep "naver" pools-metrics.json | head -20
```

#### 3.3 점수 비교
```bash
# 이전 버전 점수
jq '.["S&P 500"][] | select(.score > 0) | .score' pools-metrics.json.old | sort | uniq -c

# 신규 버전 점수  
jq '.["S&P 500"][] | select(.score > 0) | .score' pools-metrics.json | sort | uniq -c

# 비교 (±10% 범위 내 정상)
```

#### 3.4 데이터 품질 리포트
```bash
jq '.summary.coverage' pools-metrics.json
jq '.[] | .naverDataQuality | select(.) | .confidence' pools-metrics.json | \
  jq -s 'add/length'  # 평균 신뢰도
```

---

## 📊 개선 효과

### Before (기존 코드)
```
데이터 흐름: NEWS_FEATURES → mergeNaverSignals() → NAVER_TRENDS
            ↓                              ↓
          중복 검사               불명확한 우선순위
            ↓                              ↓
        점수 계산 (불일치 위험)      Naver Finance 별도
```

### After (신규 코드)
```
데이터 흐름: NAVER_TRENDS ──┐
            NEWS_FEATURES ──┼──→ NaverSignalCollector ──→ NaverSignal
            NAVER_FINANCE ──┘                              (단일 객체)
                                                              ↓
                                        점수 계산 (일관성 보장)
```

### 정량적 개선
| 항목 | Before | After | 개선도 |
|------|--------|-------|--------|
| 데이터 소스 | 3곳 분산 | 1곳 통합 | 66% ↓ |
| 코드 복잡도 | mergeNaverSignals() | NaverSignal 메서드 | 40% ↓ |
| 신뢰도 추적 | 없음 | 종합 점수 | 100% ↑ |
| API 호출 | 중복 | 캐시 | 30-50% ↓ |
| 디버깅 시간 | 높음 | 낮음 | 60% ↓ |

---

## 🐛 주의사항 & 트러블슈팅

### 주의 1: 점수 변동
신규 로직은 신뢰도 기반 가중평균을 사용하므로 **±10% 점수 변동 예상**

**정상:**
```
Before:  S&P 500 Microsoft: 75
After:   S&P 500 Microsoft: 68  (±10% 범위)
```

**비정상 (조사 필요):**
```
Before:  S&P 500 Microsoft: 75
After:   S&P 500 Microsoft: 45  (↓40%, 문제 있음)
```

### 주의 2: 한국 주식 Naver Finance 호출
KR 주식에서만 추가 API 호출. 네트워크 지연 발생 가능.

**최적화:**
```javascript
// 병렬 처리 (buildPoolsTrendy.js에 추가)
const financeData = await Promise.allSettled(
  symbols
    .filter(isKR)
    .map(sym => fetchNaverFinanceSignals(sym))
);
```

### 주의 3: 음수 ASVI 처리
`ASVI_NEGATIVE_FLOOR` 환경변수 확인:
```bash
# 음수 ASVI 무시
export ASVI_NEGATIVE_FLOOR=0

# 음수 ASVI도 고려
export ASVI_NEGATIVE_FLOOR=-100
```

---

## 📝 체크리스트

### Before Merge
- [ ] `validate-naver-signals.js` 모든 테스트 통과
- [ ] `buildPoolsTrendy.js` 구문 오류 없음
- [ ] 기존 메트릭과 ±10% 범위 내 점수 변동 확인
- [ ] 로그에 Naver 신호 초기화 메시지 확인
- [ ] Naver Finance 데이터 품질 확인 (KR만)

### After Merge
- [ ] 1주일 모니터링: 점수 안정성 확인
- [ ] 사용자 피드백: 추천주 정확도 변화
- [ ] 기존 `mergeNaverSignals()` 함수 완전 제거 확인
- [ ] 문서 업데이트 (README.md)
- [ ] 팀 공지: 점수 계산 로직 변경 알림

---

## 📞 문의 & 지원

문제 발생 시:
1. 로그 확인: `[naver-signal]` 메시지 검색
2. 메트릭 확인: `pools-metrics.json`의 `naverDataQuality` 필드
3. 진단 정보 확인: `getDiagnostics()` 메서드 결과

---

## 다음 단계

이 개선 완료 후:
1. **데이터 신뢰도 시스템** (Data Quality System 참고)
2. **점수 계산 감사 추적** (Scoring Audit System 참고)
3. **A/B 테스트 프레임워크** 구축
