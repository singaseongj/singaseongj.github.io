// tools/updateIndexMaps.mjs
import fs from 'fs/promises';
import { execFile } from 'node:child_process';

const OFFLINE = process.env.OFFLINE === '1' || process.env.NO_NET === '1';
const INDEX_PATH = 'src/maps.indexes.json';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';

function execFileText(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout);
    });
  });
}

async function curlText(url) {
  // -L follow redirects, -s silent, -f fail on HTTP error, -A user-agent
  return execFileText('curl', ['-L', '-s', '-f', '-A', UA, url]);
}

async function netText(url) {
  if (OFFLINE) return null;

  // Try built-in fetch first (Node 18+), then curl fallback
  try {
    // Some environments disallow setting User-Agent; omit if it errors
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (r.ok) return await r.text();
  } catch { /* ignore and try curl */ }

  try {
    const txt = await curlText(url);
    if (txt) return txt;
  } catch { /* ignore */ }

  return null;
}

const canonUS = s => s.toUpperCase().replace('/', '.').replace('-', '.');
const six = s => (s || '').replace(/\D/g, '').padStart(6, '0');

const decode = s => s
  .replace(/&amp;/g, '&')
  .replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_,n)=>String.fromCharCode(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_,h)=>String.fromCharCode(parseInt(h,16)));

const clean = s => decode((s || '').trim());

function uniqBySymbol(arr){
  const seen = new Set();
  const out = [];
  for (const r of arr) {
    const k = (r.symbol || '').toUpperCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out.sort((a,b)=>a.symbol.localeCompare(b.symbol));
}

function parseCap(str){
  if (!str) return null;
  const m = str.replace(/,/g,'').match(/([\d.]+)\s*([TBMK])\s+[A-Z]{3}/i);
  if (!m) return null;
  const mult = { K:1e3, M:1e6, B:1e9, T:1e12 }[m[2].toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

function exchangesFor(sym){
  if (sym.endsWith('.KS')) return ['KRX'];
  if (sym.endsWith('.KQ')) return ['KOSDAQ'];
  return ['NASDAQ','NYSE','NYSEARCA','NYSEAMERICAN'];
}

async function fetchCap(sym){
  const exs = exchangesFor(sym);
  const base = sym.replace(/\.KS$|\.KQ$/,'');
  for (const ex of exs){
    const html = await netText(`https://www.google.com/finance/quote/${base}:${ex}`);
    if (!html) continue;
    const m = html.match(/Market cap<\/div><div[^>]*>.*?<\/div><\/span><div[^>]*>([^<]+)/);
    if (m) return parseCap(m[1]);
  }
  return null;
}

async function fetchMarketCaps(symbols, limit=5){
  const caps = {};
  const queue = symbols.slice();
  const workers = Array(limit).fill(0).map(async () => {
    while(queue.length){
      const sym = queue.shift();
      caps[sym] = await fetchCap(sym);
    }
  });
  await Promise.all(workers);
  return caps;
}

// ---- Parsers (with fallbacks)

// S&P 500: prefer Name,Symbol,Sector order; fallback to Symbol,Name,Sector
function parseSp500(html) {
  if (!html) return [];
  let rows = [
    ...html.matchAll(
      /<tr>\s*<td[^>]*>\s*(?:<a[^>]*>)?([A-Z.\-]+)<\/(?:a|td)>\s*<td[^>]*>\s*(?:<a[^>]*>)?([^<]+)<\/(?:a|td)>\s*<td[^>]*>[\s\S]*?<\/td>\s*<td[^>]*>\s*(?:<a[^>]*>)?([^<]+)<\/(?:a|td)>/gi
    ),
  ];
  if (rows.length < 300) {
    rows = [
      ...html.matchAll(
        /<tr>\s*<td[^>]*>\s*(?:<a[^>]*>)?([A-Z.\-]+)<\/(?:a|td)>[\s\S]*?<td[^>]*>\s*(?:<a[^>]*>)?([^<]+)<\/(?:a|td)>[\s\S]*?<td[^>]*>\s*(?:<a[^>]*>)?([^<]+)<\/(?:a|td)>/gi
      ),
    ];
  }
  return rows.map(m => ({ symbol: canonUS(m[1]), name: clean(m[2]), sector: clean(m[3]) }));
}

// Nasdaq-100: limit to constituents section to avoid extra tables
function parseNasdaq100(html) {
  if (!html) return [];
  const parts = html.split(/id="constituents"/i);
  const part = parts[1] || html;
  const rows = [
    ...part.matchAll(
      /<tr>\s*<td><a [^>]*>([^<]+)<\/a>[\s\S]*?<td>([A-Z.\-]+)<\/td>/gi
    ),
  ];
  if (rows.length > 0) {
    return rows.map(m => ({ symbol: canonUS(m[2]), name: clean(m[1]), sector: null }));
  }
  // fallback pattern
  const rows2 = [
    ...part.matchAll(/<tr>\s*<td>([A-Z.\-]+)<\/td>\s*<td[^>]*>\s*(?:<a [^>]*>)?([^<]+)<\/(?:a|td)>/gi),
  ];
  return rows2.map(m => ({ symbol: canonUS(m[1]), name: clean(m[2]), sector: null }));
}

function parseKospi200(html) {
  if (!html) return [];
  const rows = [
    ...html.matchAll(
      /<tr>[\s\S]*?<td[^>]*>\s*(?:<a [^>]*>)?([^<\n]+)<\/(?:a|td)>[\s\S]*?<td[^>]*>\s*(\d{6})\s*<\/td>/gi
    ),
  ];
  return rows.map(m => ({ symbol: `${six(m[2])}.KS`, name: clean(m[1]), sector: null }));
}

function parseKosdaq100(html) {
  if (!html) return [];
  const rows = [
    ...html.matchAll(
      /<tr>[\s\S]*?<td[^>]*>\s*(?:<a [^>]*>)?([^<\n]+)<\/(?:a|td)>[\s\S]*?<td[^>]*>\s*(\d{6})\s*<\/td>/gi
    ),
  ];
  return rows.map(m => ({ symbol: `${six(m[2])}.KQ`, name: clean(m[1]), sector: null }));
}

async function main() {
  // Load existing file (for fallback if fetch fails)
  let current = { sp500: [], nasdaq100: [], kospi200: [], kosdaq100: [], generatedAt: null };
  try { current = JSON.parse(await fs.readFile(INDEX_PATH, 'utf8')); } catch {}

  const [spTxt, nqTxt, k200Txt, kq100Txt] = await Promise.all([
    netText('https://en.wikipedia.org/wiki/List_of_S%26P_500_companies'),
    netText('https://en.wikipedia.org/wiki/Nasdaq-100'),
    netText('https://ko.wikipedia.org/wiki/KOSPI_200'),
    netText('https://ko.wikipedia.org/wiki/KOSDAQ_100'),
  ]);

  let sp500 = parseSp500(spTxt);
  let nasdaq100 = parseNasdaq100(nqTxt);
  let kospi200 = parseKospi200(k200Txt);
  let kosdaq100 = parseKosdaq100(kq100Txt);

  // Sanity thresholds; fallback to current if parse looks wrong/too small
  if (sp500.length < 350) { console.log('[indexes] keep current S&P500 (parsed=', sp500.length, ')'); sp500 = current.sp500; }
  if (nasdaq100.length < 70) { console.log('[indexes] keep current Nasdaq100 (parsed=', nasdaq100.length, ')'); nasdaq100 = current.nasdaq100; }
  if (kospi200.length < 150) { console.log('[indexes] keep current KOSPI200 (parsed=', kospi200.length, ')'); kospi200 = current.kospi200; }
  if (kosdaq100.length < 80) { console.log('[indexes] keep current KOSDAQ100 (parsed=', kosdaq100.length, ')'); kosdaq100 = current.kosdaq100; }

  sp500     = uniqBySymbol(sp500);
  nasdaq100 = uniqBySymbol(nasdaq100);
  kospi200  = uniqBySymbol(kospi200);
  kosdaq100 = uniqBySymbol(kosdaq100);

  const allSymbols = Array.from(new Set([
    ...sp500,
    ...nasdaq100,
    ...kospi200,
    ...kosdaq100,
  ].map(r => r.symbol)));

  const caps = OFFLINE ? {} : await fetchMarketCaps(allSymbols);
  const oldCaps = new Map();
  for (const key of ['sp500','nasdaq100','kospi200','kosdaq100']) {
    for (const r of current[key] || []) {
      if (typeof r.marketCap === 'number') oldCaps.set(r.symbol, r.marketCap);
    }
  }

  function attachCaps(list){
    for (const r of list) {
      const mc = caps[r.symbol] ?? null;
      const prev = oldCaps.get(r.symbol);
      if (prev != null && mc != null && prev !== mc) {
        console.log(`[cap] ${r.symbol}: ${prev} -> ${mc}`);
      }
      r.marketCap = mc;
    }
  }

  attachCaps(sp500);
  attachCaps(nasdaq100);
  attachCaps(kospi200);
  attachCaps(kosdaq100);

  const next = {
    sp500,
    nasdaq100,
    kospi200,
    kosdaq100,
    generatedAt: new Date().toISOString(),
  };

  await fs.mkdir('src', { recursive: true });
  await fs.writeFile(INDEX_PATH, JSON.stringify(next, null, 2));
  console.log('[indexes] updated',
    `(S&P500=${sp500.length}, N100=${nasdaq100.length}, K200=${kospi200.length}, KQ100=${kosdaq100.length})`,
    OFFLINE ? '[OFFLINE mode]' : ''
  );
}

// Non-fatal on error (so CI doesn’t break hard)
main().catch(e => { console.warn('[indexes] non-fatal:', e.message); process.exit(0); });
