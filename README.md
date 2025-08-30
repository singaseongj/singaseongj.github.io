# singaseongj.github.io

This repository contains files used for the Singaseong website.

The build script collects market index data from Naver for the Korean indices
(KOSPI, KOSDAQ) and from Investing.com for the S&P 500 and NASDAQ 100. It now
parses the previous closing value for KOSPI and KOSDAQ so the generated
`stocks.html` page can display those figures alongside the current index value.
The page also shows a "latest market news" section. A helper script pulls
headlines from Yahoo Finance and several Korean sources every six hours and
writes them to `data/market-news.json`. When the page loads it reads this file,
falling back to `data/sample_market_news.json` if needed.

The S&P 500 tracks 500 large companies listed on U.S. exchanges, while the
NASDAQ 100 focuses on major non‑financial companies trading on the Nasdaq
exchange. Many technology giants such as Apple and Microsoft are members of
both indices, so an individual stock may appear in each section of the
recommendations.

## Voice to Keys Demo / 음성으로 단축키 데모

### English
`voice-hotkey/` is a small demo that listens for phrases like "ctrl w" or "close the tab" and shows the matching keyboard shortcut.
Open `voice-hotkey/index.html` directly to run it locally. To deploy on GitHub Pages, commit the folder and visit `/voice-hotkey/`.
The app first tries the browser's Web Speech API for speech‑to‑text. A placeholder `transcribeAudio` function exists to wire up Whisper or another API later.
If you provide an OpenAI‑compatible API key and model in the **Settings** dialog, the app will use it to interpret natural language. Keys are stored in `localStorage`; avoid using real secrets on shared devices.
Shortcuts default to Windows mappings, with macOS overrides when the OS selector is set to macOS.

### 한국어
`voice-hotkey/` 폴더에는 "ctrl w", "탭 닫아" 같은 말을 인식해 해당 키 조합을 보여주는 데모가 있습니다.
로컬에서는 `voice-hotkey/index.html` 파일을 직접 열면 되고, GitHub Pages에 배포하려면 폴더를 커밋한 뒤 `/voice-hotkey/` 주소로 접속하면 됩니다.
브라우저의 Web Speech API를 기본 음성 인식으로 사용하며, Whisper 등 외부 STT API를 연결할 수 있도록 `transcribeAudio` 함수를 비워 두었습니다.
**Settings** 창에 OpenAI 호환 API 키와 모델을 입력하면 자연어 명령을 해석합니다. 정보는 `localStorage`에 저장되므로 공용 기기에서는 실제 키 사용을 피하세요.
단축키는 기본적으로 Windows 기준이며, OS 선택을 macOS로 바꾸면 맵핑이 달라집니다.

## Running tests

The repository includes a simple Node.js script that verifies the `apple-app-site-association` file. Make sure Node.js is installed and run.
Node.js 18 or newer is required to run the update and build scripts.

```bash
node tests/apple_association.test.js
```

If the file is valid you will see `All tests passed`.

## Updating recommendation data

`fetchStockInfo.js` fetches sector and previous close information from the Yahoo Finance API and stores the result in `recommendations.json`.
The script now checks the file's `lastUpdated` timestamp and only refreshes the data when it is more than six hours old.

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

## Trend-Aware Pools & Learning

Ticker pools are now stored in `pools.json`. The loader checks for a remote
endpoint first (`POOLS_URL`) with a configurable TTL (default 24 h, override via
`--pools-ttl=HOURS` or force with `--refresh-pools`). If remote fetch fails or
TTL is not met it falls back to `pools-cache.json`, then the versioned
`pools.json`, and finally an embedded list.

`tools/buildPoolsTrendy.js` can refresh pools daily using lightweight signals.
It writes diagnostics to `pools-metrics.json` and updates `feedback.json` which
stores user feedback with gradual decay. Missing APIs are tolerated—the script
logs a warning and leaves existing pools untouched. The builder tallies
headlines from Google News, Yahoo Finance, Investing.com, and Hanwha to give
popular large‑cap names higher scores. Each candidate receives an integer score
from 0 to 100 (capped), with a tiny deterministic jitter to tease apart close
matches. Pools are then sorted by this score so top companies surface first.

Key files:

- `pools.json` – current editable pools
- `pools-cache.json` – last successful remote download
- `pools-metrics.json` – scoring diagnostics from the generator
- `feedback.json` – learning memory; weights are applied during pool scoring to nudge future selections; adjust with `node tools/feedback.js --market=KOSPI --name=삼성전자 --delta=0.05`

Optional environment variables:

- `POOLS_URL` – remote JSON endpoint for pools
- `NEWS_API_URL` / `NEWS_API_KEY`
- `QUOTES_API_URL` / `QUOTES_API_KEY`
- `EARNINGS_API_URL` / `EARNINGS_API_KEY`

Run the generator manually:

```bash
node tools/buildPoolsTrendy.js
```

Examples:

```bash
# Full online
FINNHUB_API_KEY=... TWELVEDATA_API_KEY=... node tools/buildPoolsTrendy.js

# Demo / slow networks
FINNHUB_API_KEY=demo TWELVEDATA_API_KEY=demo GLOBAL_BUDGET_MS=60000 MAX_CONCURRENCY=2 node tools/buildPoolsTrendy.js

# Offline but still complete run
node tools/buildPoolsTrendy.js --offline
```

Then rebuild recommendations with remote refresh:

```bash
node fetchStockInfo.js --refresh-pools --force
```

## Updating market news

`fetchNews.js` gathers the latest headlines from several RSS feeds. It collects
five US market items from Yahoo Finance and one headline from each of three
Korean Google News queries, then writes them to `data/market-news.json`. The
file is only refreshed when the previous update is older than six hours.

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
