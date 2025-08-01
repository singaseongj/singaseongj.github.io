# singaseongj.github.io

This repository contains files used for the Singaseong website.

The build script collects market index data from Naver for the Korean indices
(KOSPI, KOSDAQ) and from Investing.com for the S&P 500 and NASDAQ 100. It now
parses the previous closing value for KOSPI and KOSDAQ so the generated
`stocks.html` page can display those figures alongside the current index value.

## Running tests

The repository includes a simple Node.js script that verifies the `apple-app-site-association` file. Make sure Node.js is installed and run.
Node.js 18 or newer is required to run the update and build scripts.

```bash
node tests/apple_association.test.js
```

If the file is valid you will see `All tests passed`.

## Updating recommendation data

`fetchStockInfo.js` fetches sector and previous close information from the Yahoo Finance API and stores the result in `recommendations.json`.

Run the script with:

```bash
node fetchStockInfo.js
```

`src/build.js` now uses `recommendations.json` as a cache. It first checks if the file was
updated within the last 24 hours and, if so, uses the cached data. Otherwise it attempts to
fetch fresh data through a Google Apps Script and writes the result back to the JSON file.
If the fetch fails it will still fall back to the local file
([link](https://drive.google.com/file/d/1OE6OGkhextQCBRG_jG3TC05LdV6RKRHZ/view?usp=drive_link)).
This prevents unnecessary network requests during daily builds.

## Building `stocks.html`

Generate the stock report page using the build script:

```bash
node src/build.js
```

When network access isn't available, enable offline mode to use
`data/sample_market_data.json`:

```bash
OFFLINE=1 node src/build.js
```

## Visit counting

Page visits are tracked via a Google Apps Script. Send a request with the
`page` parameter to update and retrieve the visit totals:

```bash
# Visit index.html
curl 'https://script.google.com/macros/s/AKfycbyM94HyV7c_eqq3SPLMZlBcJVh6KeyygmR4bq_NM80_li9MIM2WWQ25wnd3S51FR4igLw/exec?page=index'

# Visit stocks.html
curl 'https://script.google.com/macros/s/AKfycbyM94HyV7c_eqq3SPLMZlBcJVh6KeyygmR4bq_NM80_li9MIM2WWQ25wnd3S51FR4igLw/exec?page=stocks'
```

The script responds with JSON containing the `daily` and `total` fields.
