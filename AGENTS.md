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

## Visit counts
To check page visit counts, send a request using the `page` parameter, e.g.:
```bash
# Visit index.html
curl 'https://script.google.com/macros/s/AKfycbyM94HyV7c_eqq3SPLMZlBcJVh6KeyygmR4bq_NM80_li9MIM2WWQ25wnd3S51FR4igLw/exec?page=index'

# Visit stocks.html
curl 'https://script.google.com/macros/s/AKfycbyM94HyV7c_eqq3SPLMZlBcJVh6KeyygmR4bq_NM80_li9MIM2WWQ25wnd3S51FR4igLw/exec?page=stocks'
```
The response JSON contains `daily` and `total` fields.
