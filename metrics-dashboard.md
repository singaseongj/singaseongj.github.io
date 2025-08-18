# Metrics Dashboard

- `summary.providers.{provider}.ok` – count of successful candle fetches
- `summary.providers.{provider}.err` – errors by provider
- `summary.providers.{provider}.429` – rate-limit hits
- `summary.coverage.{market}` – fraction of symbols with metrics
- `summary.timingMs.total` – total run time of `buildPoolsTrendy`

Suggested alerts:
- High `429` counts indicate throttling; consider raising `CACHE_TTL_MS`.
- Low coverage (<0.5) for any market triggers investigation.
