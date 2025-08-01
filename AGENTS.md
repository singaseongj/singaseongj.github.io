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

## Building the stock page
- Generate `stocks.html` with:
  ```bash
  node src/build.js
  ```
- If offline, set the environment variable to use sample data:
  ```bash
  OFFLINE=1 node src/build.js
  ```

The page also loads recent market headlines from Yahoo Finance.
When offline, it falls back to `data/sample_market_news.json`.

## Visit counts
To check page visit counts, send a request using the `page` parameter, e.g.:
```bash
# Visit index.html

# Visit stocks.html

```
The response JSON contains `daily` and `total` fields.
