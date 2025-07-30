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
