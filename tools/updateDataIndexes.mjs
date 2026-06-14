// tools/updateDataIndexes.mjs
// Refresh lightweight index constituent JSON files under data/indexes from public sources.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

const OFFLINE = process.env.OFFLINE === '1' || process.env.NO_NET === '1';
const OUT_DIR = 'data/indexes';
const UA = 'Mozilla/5.0 (compatible; stock-recs/1.0; +https://singaseongj.github.io)';
const SOURCES = {
  sp500: ['https://en.wikipedia.org/wiki/List_of_S%26P_500_companies'],
  nasdaq100: ['https://en.wikipedia.org/wiki/Nasdaq-100'],
  nasdaqTrader: [
    'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt',
    'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt',
  ],
  kospi200: [
    'https://ko.wikipedia.org/wiki/KOSPI_200',
    'https://finance.naver.com/sise/entryJongmok.naver?page=1',
    'https://finance.naver.com/sise/entryJongmok.naver?page=2',
    'https://finance.naver.com/sise/entryJongmok.naver?page=3',
    'https://finance.naver.com/sise/entryJongmok.naver?page=4',
  ],
  kosdaq100: [
    'https://ko.wikipedia.org/wiki/KOSDAQ_100',
    'https://finance.naver.com/sise/entryJongmok.naver?type=KQ&page=1',
    'https://finance.naver.com/sise/entryJongmok.naver?type=KQ&page=2',
  ],
};

const US_SYMBOL_PATTERN = /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/;
const canonUS = s => String(s || '').toUpperCase().replace('/', '.').replace('-', '.').trim();
const six = s => String(s || '').replace(/\D/g, '').padStart(6, '0');
const decode = s => String(s || '')
  .replace(/&amp;/g, '&')
  .replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
const clean = s => decode(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

function execFileText(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function fetchText(url) {
  if (OFFLINE) return null;
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    if (res.ok) return await res.text();
    console.warn(`[data-indexes] ${url} returned HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[data-indexes] ${url} fetch failed: ${err.message}`);
  }
  const curled = await execFileText('curl', ['-L', '-s', '-f', '-A', UA, url]);
  if (curled) return curled;
  console.warn(`[data-indexes] ${url} curl fallback failed`);
  return null;
}

function uniqBySymbol(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const symbol = canonUS(row?.symbol || row?.ticker || row);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({ symbol, name: clean(row?.name || symbol), sector: row?.sector ? clean(row.sector) : null });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function parseSp500(html) {
  if (!html) return [];
  const part = html.split(/id=\"constituents\"/i)[1] || html;
  const tableBody = part.split(/<\/table>/i)[0] || part;
  const rows = tableBody.split(/<tr>/i).slice(1);
  const out = [];
  for (const row of rows) {
    const match = row.match(/^\s*<td[^>]*>\s*(?:<a[^>]*>)?([A-Z.\-]+)<\/(?:a|td)>[\s\S]*?<td[^>]*>\s*(?:<a[^>]*>)?([^<]+)<\/(?:a|td)>[\s\S]*?<td[^>]*>\s*(?:<a[^>]*>)?([^<]+)<\/(?:a|td)/i);
    if (match) {
      out.push({ symbol: canonUS(match[1]), name: clean(match[2]), sector: clean(match[3]) });
    }
  }
  return out;
}

function parseNasdaq100(html) {
  if (!html) return [];
  const part = html.split(/id="constituents"/i)[1] || html;
  const linked = [...part.matchAll(/<tr>\s*<td><a [^>]*>([^<]+)<\/a>[\s\S]*?<td>([A-Z.\-]+)<\/td>/gi)];
  if (linked.length) return linked.map(m => ({ symbol: canonUS(m[2]), name: clean(m[1]), sector: null }));
  const rows = [...part.matchAll(/<tr>\s*<td>([A-Z.\-]+)<\/td>\s*<td[^>]*>\s*(?:<a [^>]*>)?([^<]+)<\/(?:a|td)>/gi)];
  return rows.map(m => ({ symbol: canonUS(m[1]), name: clean(m[2]), sector: null }));
}

function parseNasdaqTrader(txt) {
  if (!txt) return [];
  const [headerLine, ...lines] = txt.split(/\r?\n/).filter(Boolean);
  if (!headerLine?.includes('|')) return [];
  const headers = headerLine.split('|').map(h => h.trim().toLowerCase());
  const col = (...names) => names.map(n => headers.indexOf(n.toLowerCase())).find(i => i >= 0) ?? -1;
  const symbolIdx = col('Symbol', 'ACT Symbol');
  const nameIdx = col('Security Name');
  const testIdx = col('Test Issue');
  const etfIdx = col('ETF');
  if (symbolIdx < 0 || nameIdx < 0) return [];
  return lines
    .filter(line => !/^File Creation Time:/i.test(line))
    .map(line => line.split('|').map(c => c.trim()))
    .filter(cols => cols.length >= headers.length)
    .filter(cols => testIdx < 0 || cols[testIdx] === 'N')
    .filter(cols => etfIdx < 0 || cols[etfIdx] !== 'Y')
    .map(cols => ({ symbol: canonUS(clean(cols[symbolIdx])), name: clean(cols[nameIdx]).replace(/\s+-\s+Common Stock$/i, ''), sector: null }))
    .filter(row => US_SYMBOL_PATTERN.test(row.symbol))
    .filter(row => !/(warrants?|units?|rights?|preferred|depositary|notes?|bonds?|debentures?)/i.test(row.name));
}

function parseKoreanWiki(html, suffix) {
  if (!html) return [];
  const rows = [...html.matchAll(/<tr>[\s\S]*?<td[^>]*>\s*(?:<a [^>]*>)?([^<\n]+)<\/(?:a|td)>[\s\S]*?<td[^>]*>\s*(\d{6})\s*<\/td>/gi)];
  return rows.map(m => ({ symbol: `${six(m[2])}${suffix}`, name: clean(m[1]), sector: null }));
}

function parseNaver(html, suffix) {
  if (!html) return [];
  const rows = [...html.matchAll(/href="\/item\/main\.naver\?code=(\d{6})"[^>]*>([^<]+)<\/a>/gi)];
  return rows.map(m => ({ symbol: `${six(m[1])}${suffix}`, name: clean(m[2]), sector: null }));
}

async function readExisting(file, mapKey) {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Array.isArray(raw) && raw.length) return raw;
  } catch {}
  try {
    const map = JSON.parse(await fs.readFile('src/maps.indexes.json', 'utf8'));
    const rows = Array.isArray(map?.[mapKey]) ? map[mapKey] : [];
    if (rows.length) return rows;
  } catch {}
  return [];
}

async function writeIndex(name, rows, minCount, mapKey = name) {
  const file = path.join(OUT_DIR, `${name}.json`);
  const next = uniqBySymbol(rows);
  const finalRows = next.length >= minCount ? next : await readExisting(file, mapKey);
  if (next.length < minCount) console.warn(`[data-indexes] keeping existing ${file}; parsed ${next.length}, expected at least ${minCount}`);
  await fs.writeFile(file, JSON.stringify(finalRows, null, 2));
  console.log(`[data-indexes] wrote ${file} (${finalRows.length})`);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const texts = Object.fromEntries(await Promise.all(Object.entries(SOURCES).map(async ([key, urls]) => [key, await Promise.all(urls.map(fetchText))])));
  await writeIndex('sp500', parseSp500(texts.sp500[0]), 350);
  await writeIndex('nasdaq100', parseNasdaq100(texts.nasdaq100[0]), 70);
  await writeIndex('nasdaq-trader', texts.nasdaqTrader.flatMap(parseNasdaqTrader), 1000, 'nasdaqTrader');
  await writeIndex('kospi200', [...parseKoreanWiki(texts.kospi200[0], '.KS'), ...texts.kospi200.slice(1).flatMap(t => parseNaver(t, '.KS'))], 150);
  await writeIndex('kosdaq100', [...parseKoreanWiki(texts.kosdaq100[0], '.KQ'), ...texts.kosdaq100.slice(1).flatMap(t => parseNaver(t, '.KQ'))], 80);
}

main().catch(err => { console.error('[data-indexes] failed:', err); process.exit(1); });
