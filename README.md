# singaseongj.github.io

This repository contains files used for the Singaseong website.

The build script collects market index data from Naver for the Korean indices
(KOSPI, KOSDAQ) and from Investing.com for the S&P 500 and NASDAQ 100. It now
parses the previous closing value for KOSPI and KOSDAQ so the generated
`stocks.html` page can display those figures alongside the current index value.
The page also shows a "latest market news" section. A helper script pulls
headlines from Yahoo Finance and several Korean sources every six hours and
writes them to `data/market_news.json`. When the page loads it reads this file,
falling back to `data/sample_market_news.json` if needed.

The S&P 500 tracks 500 large companies listed on U.S. exchanges, while the
NASDAQ 100 focuses on major non‑financial companies trading on the Nasdaq
exchange. Many technology giants such as Apple and Microsoft are members of
both indices, so an individual stock may appear in each section of the
recommendations.

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

## Updating market news

`fetchNews.js` gathers the latest headlines from several RSS feeds, including
three Korean sources, and writes them to `data/market_news.json`. The script
keeps the file fresh by skipping the download when it was updated within the
last six hours.

Run it manually whenever you want to refresh the news:

```bash
node fetchNews.js
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
The HTML layout is defined in `src/template.html`. This template represents our preferred design for `stocks.html`. Update the template and rebuild if you wish to change the page.


## Visit counting

Page visits are tracked via a Google Apps Script. Send a request with the
`page` parameter to update and retrieve the visit totals:

```bash
# Visit index.html

# Visit stocks.html


The script responds with JSON containing the `daily` and `total` fields.

## Ideas for improvement

- Add a dark mode toggle for better readability at night
- Provide filters to sort recommendations by sector
- Show small charts next to each index for quick visual trends
