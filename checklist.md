# QA Checklist

- `node tools/buildPoolsTrendy.js --dry-run` (verify summary and provider cool-offs)
- `node tools/buildPoolsTrendy.js` (with keys) -> ensure `pools.json` updated
- Simulate 429 by modifying API key to trigger rate limit; verify provider cool-off
- Warm run to confirm cache speed
- `node src/build.js` rebuilds front-end
- Load `stocks.html` twice to see SWR cache then refresh
- Hover ticker to show tooltip explanations
