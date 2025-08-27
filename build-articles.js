// build-articles.js
// Reads summary.json, fetches recent headlines per ticker using your existing
// getTickerArticles(ticker) util, and writes data/articles/<TICKER>.json.
// Run: node build-articles.js

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

// Adjust import path to match your codebase:
import { getTickerArticles } from './src/news/fetchByTicker.js';

const ROOT = process.cwd();
const SUMMARY = path.join(ROOT, 'summary.json');
const OUTDIR = path.join(ROOT, 'data', 'articles');

function safeFile(t) { return String(t).replace(/[^A-Za-z0-9_.-]/g, '_'); }

async function main() {
  const j = JSON.parse(await fsp.readFile(SUMMARY, 'utf8'));
  const tickers = Array.from(
    new Set((j.companies || []).map(c => c.ticker).filter(Boolean))
  );

  await fsp.mkdir(OUTDIR, { recursive: true });

  let done = 0;
  for (const t of tickers) {
    try {
      const arts = await getTickerArticles(t); // uses your cached/news providers
      const file = path.join(OUTDIR, `${safeFile(t)}.json`);
      await fsp.writeFile(file, JSON.stringify(arts, null, 2), 'utf8');
      done++;
      console.log(`[ok] ${t} -> ${file}`);
    } catch (e) {
      console.warn(`[skip] ${t}: ${e.message}`);
    }
  }
  console.log(`Wrote ${done}/${tickers.length} article files`);
}

main().catch(e => { console.error(e); process.exit(1); });
