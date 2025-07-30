# singaseongj.github.io

This repository contains files used for the Singaseong website.

The build script collects market index data from Naver and Yahoo Finance. It now
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

## Visit count server

A small Node.js script records page visits in `visits.json`. Start it before opening
`index.html` or `stocks.html` so the pages can update the counts:

```bash
node server.js
```

The server exposes `/visit?page=index` and `/visit?page=stocks` endpoints and stores
the daily and total visit numbers separately for each page.
