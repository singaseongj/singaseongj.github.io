# Stock Dashboard Reliability and Features

## Overview
- Added provider-agnostic candle fetcher with caching and circuit breakers (`src/data/candles.js`).
- Broadened universe with quality filters (`src/universe/index.js`).
- Integrated news sentiment and scoring (`src/news/*`).
- Enhanced diagnostics in `tools/buildPoolsTrendy.js` with provider stats and coverage summary.
- Front-end now uses SWR and tooltips for explanations (`stocks.html`).

## Call Flow
`buildPoolsTrendy.js` → `getCandles()` → cache → provider APIs → metrics → recommendations.

## Risks
- External API rate limits: mitigated by cool-offs and caching.
- Stale data: SWR refreshes after serving cached data.

## Rollout
- Run `node tools/buildPoolsTrendy.js` with demo keys first.
- Verify `pools-metrics.json.summary` before enabling writes.

## Rollback
- Revert to previous commit and restore prior `pools.json` and `pools-metrics.json`.

## Benchmarks
- Warm run hits cache; see `fetchMs` fields in `pools-metrics.json`.

## 한국어 요약
- 새로운 캐시와 회로 차단으로 안정성 향상.
- 후보군 확대 및 거래대금·가격 필터 적용.
- 뉴스 감성 반영으로 추천 설명 강화.
