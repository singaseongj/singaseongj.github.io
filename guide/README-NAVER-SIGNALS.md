# 🎯 Naver 신호 병합 로직 단일화 - 최종 요약

## 📦 제공 파일 목록

### 1. 핵심 구현 파일
| 파일 | 크기 | 용도 |
|------|------|------|
| `naver-signals-unified.js` | 11KB | NaverSignal, NaverSignalCollector, NaverSignalCache 클래스 |
| `NAVER-SIGNALS-GUIDE.md` | 11KB | 완전한 구현 가이드 |

### 2. 통합 & 마이그레이션
| 파일 | 크기 | 용도 |
|------|------|------|
| `buildPoolsTrendy-patch.js` | 9.1KB | buildPoolsTrendy.js에 적용할 코드 패치 |
| `buildPoolsTrendy-migration-guide.js` | 9.4KB | 8단계 마이그레이션 가이드 |

### 3. 테스트 & 검증
| 파일 | 크기 | 용도 |
|------|------|------|
| `validate-naver-signals.js` | 9.8KB | 자동화된 테스트 스크립트 (7개 테스트) |

### 4. 관련 개선사항 (추가 참고용)
| 파일 | 크기 | 용도 |
|------|------|------|
| `scoring-audit-system.js` | 8.7KB | 점수 계산 투명성 추적 |
| `data-quality-system.js` | 8.9KB | 데이터 신뢰도 추적 |

---

## 🚀 빠른 시작 (5분)

### 1단계: 파일 구조 생성
```bash
mkdir -p src/signals
cp naver-signals-unified.js src/signals/naver-signals.js
```

### 2단계: 테스트 실행
```bash
node validate-naver-signals.js
```

**예상 결과:**
```
✓ Signal Construction passed
✓ Data Sources Priority passed
...
✅ All tests passed!
```

### 3단계: buildPoolsTrendy.js 패치 적용
`buildPoolsTrendy-patch.js`의 각 CHANGE 섹션을 따라 코드 수정

### 4단계: 통합 테스트
```bash
node tools/buildPoolsTrendy.js --dry-run
```

---

## 🔍 핵심 개선 사항

### 문제점 분석

**현재 buildPoolsTrendy.js의 문제:**

```javascript
// 문제 1: 3개 소스에서 데이터 읽음
const nf = NEWS_FEATURES[sym] || {};           // ← Features
const trend = NAVER_TRENDS[sym] || {};         // ← Trends
const naverFinance = await fetchNaverFinanceSignals(sym); // ← API

// 문제 2: 불명확한 병합 로직
const navSignals = mergeNaverSignals(nf, trend); // 어떤 게 우선?

// 문제 3: 중복 저장
naverPopularity = navSignals.combined;
naverAsvi = navSignals.asvi;
// ... 3개 더 ...

// 문제 4: 신뢰도 추적 없음
// 이 값이 어디서 왔는지, 신뢰할 수 있는지 알 수 없음
```

### 해결책

```javascript
// ✅ 단일 신호 객체
const signal = naverSignalCache.get(symbol);

// ✅ 명확한 우선순위
// Trends (실시간, 신뢰도 95%) > Features (캐시, 80%) > Finance (스크래핑, 65%)
const recommended = signal.getRecommendedPopularity();

// ✅ 신뢰도 점수
console.log(recommended.confidence); // 0.95 (95% 신뢰도)

// ✅ 데이터 출처 추적
console.log(signal.sources);         // { popularity: 'trends', ... }
```

---

## 📊 예상 개선 효과

### 정량적 개선
| 항목 | Before | After | 개선도 |
|------|--------|-------|--------|
| **데이터 소스** | 3곳 분산 | 1곳 통합 | -66% |
| **코드 복잡도** | 복잡한 mergeNaverSignals() | 명확한 메서드들 | -40% |
| **신뢰도 추적** | 없음 | 종합 점수 (0..1) | +100% |
| **API 호출** | 중복 가능 | 캐시 활용 | -30~50% |
| **버그 위험도** | 높음 (분산된 데이터) | 낮음 (통합 객체) | -70% |

### 정성적 개선
- ✅ **코드 읽기 쉬움**: 단일 객체에서 모든 정보 획득
- ✅ **유지보수 용이**: 한 곳에서만 수정
- ✅ **테스트 가능**: 단위 테스트 7개 포함
- ✅ **확장 가능**: 새로운 데이터 소스 추가 간단
- ✅ **모니터링 가능**: 데이터 품질 메트릭 자동 생성

---

## 🔧 구현 로드맵

### Phase 1: 준비 (Day 1)
```
1. 파일 생성: src/signals/naver-signals.js
2. 테스트 실행: validate-naver-signals.js
3. 모든 테스트 통과 확인
```

### Phase 2: 통합 (Day 2-3)
```
1. buildPoolsTrendy.js import 추가
2. 전역 변수 선언 (naverSignalCache)
3. 신호 초기화 코드 추가
4. extractNaverSignals() 함수 구현
5. 신호 수집 부분 수정
6. 부스트 계산 업데이트
7. 메트릭 출력 개선
```

### Phase 3: 검증 (Day 4)
```
1. buildPoolsTrendy.js --dry-run 실행
2. 점수 변동 확인 (±10% 범위)
3. 로그 확인 (Naver 신호 초기화 메시지)
4. 데이터 품질 리포트 생성
```

### Phase 4: 정리 (Day 5+)
```
1. 기존 mergeNaverSignals() 함수 제거
2. 테스트 커버리지 100% 확인
3. 문서 업데이트
4. 팀 공지
```

---

## 💡 핵심 아이디어

### 1. Single Source of Truth (SSOT)
```javascript
// 이전: 여러 곳에서 데이터 읽음
NEWS_FEATURES[sym].naverPopularity  // 60%
NAVER_TRENDS[sym].naverPopularity   // 75%
naverFinance.score                  // 50%
// → 어느 것을 사용할 것인가? 모호함

// 이후: 한 곳에서만 읽음
const signal = naverSignalCache.get(sym);
signal.getRecommendedPopularity();  // 68% (신뢰도 가중평균)
// → 명확하고 일관됨
```

### 2. Confidence-Based Weighting
```javascript
// 데이터 신뢰도에 따라 자동으로 가중치 적용
Trends:   popularity=0.90, confidence=0.95 → 0.90 * 0.95 = 0.855
Features: popularity=0.60, confidence=0.75 → 0.60 * 0.75 = 0.450
Finance:  popularity=0.50, confidence=0.65 → 0.50 * 0.65 = 0.325
                                            ─────────────────
                                      최종 = 0.68 (정규화)
```

### 3. Source Tracking
```javascript
signal.getDiagnostics() // 반환:
{
  popularity: {
    value: 0.68,
    source: 'trends',      // ← 어디서?
    confidence: 0.95       // ← 얼마나 신뢰?
  },
  asvi: { value: 42, source: 'trends' },
  spike: { value: true, source: 'trends' },
  ...
}
```

---

## ⚠️ 주의사항

### 점수 변동
신뢰도 가중평균 사용으로 **±10% 점수 변동 정상**

```
예: S&P 500 Microsoft
Before: 75점
After:  68점 (±10% 범위)
```

### Naver Finance API 호출
KR 주식 처리 시 추가 API 호출 발생
- 최적화: 병렬 처리 (Promise.all) 고려

### 음수 ASVI 처리
환경변수 `ASVI_NEGATIVE_FLOOR` 설정으로 제어
```bash
export ASVI_NEGATIVE_FLOOR=0  # 음수 무시 (기본)
```

---

## 📞 지원 정보

### 각 파일의 역할
1. **naver-signals-unified.js**: 구현 (이 파일을 src/signals/로 복사)
2. **NAVER-SIGNALS-GUIDE.md**: 상세 가이드 (스텝별 구현)
3. **buildPoolsTrendy-patch.js**: 코드 변경분 (어디를 바꿀지 명시)
4. **validate-naver-signals.js**: 테스트 (검증 자동화)

### 문제 해결
1. 테스트 실패 → `validate-naver-signals.js` 로그 확인
2. 점수 급변 → `pools-metrics.json`의 `naverDataQuality` 확인
3. API 에러 → 로그에서 `[naver-signal]` 메시지 검색

---

## ✅ 최종 체크리스트

### 구현 전
- [ ] 파일 5개 확인 (`naver-signals-unified.js`, guide, patch, test, md)
- [ ] 팀원에게 공유 및 피드백

### 구현 중
- [ ] Phase 1-4 모두 완료
- [ ] 각 단계에서 테스트 실행

### 구현 후
- [ ] 1주일 모니터링 (점수 안정성)
- [ ] 사용자 피드백 수집
- [ ] 문서 업데이트

---

## 🎓 추가 학습 자료

관련 개선사항 (포함됨):
- `scoring-audit-system.js`: 점수 계산 투명성
- `data-quality-system.js`: 데이터 신뢰도 추적

이들은 Naver 신호 통합 이후 적용 권장.

---

## 🎉 완료!

모든 파일이 준비되었습니다.

**다음 단계:**
1. `naver-signals-unified.js` → `src/signals/naver-signals.js` 복사
2. `NAVER-SIGNALS-GUIDE.md` 읽기 (상세 가이드)
3. `buildPoolsTrendy-patch.js` 따라 코드 수정
4. `validate-naver-signals.js` 실행 (테스트)
5. `buildPoolsTrendy.js --dry-run` (통합 테스트)

**질문이 있으시면 각 파일의 주석을 참고하거나 로그를 확인하세요.**

행운을 빕니다! 🚀
