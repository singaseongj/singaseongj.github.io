This project hosts the Singaseong website files.

## Tests
- Ensure Node.js 18 or newer is installed.
- To run the repository's lone test, execute:
  ```bash
  node tests/apple_association.test.js
  ```
  The script prints `All tests passed` on success.

## Updating data
- Fetch sector and previous close information with:
  ```bash
  node fetchStockInfo.js
  ```
  This updates `recommendations.json`.

- Refresh FX rates with:
  ```bash
  node fetchFxRates.js
  ```
- If all providers fail, the script keeps the existing `data/fx_rates.json` so the last successful rates remain available.

## Building the stock page
- Generate `stocks.html` with:
  ```bash
  node src/build.js
  ```

The page also loads recent market headlines from Yahoo Finance.
When offline, it falls back to `data/sample_market_news.json`.
### Stock page template
The structure of `stocks.html` is defined in `src/template.html`. We like the current layout and keep it as the reference for future builds. Modify this template and rebuild with `node src/build.js` if you change the design.


## Visit counts
To check page visit counts, send a request using the `page` parameter, e.g.:
```bash
# Visit index.html

# Visit stocks.html

```
The response JSON contains `daily` and `total` fields.
