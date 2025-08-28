// tools/updateIndexMaps.mjs (offline-safe)
import fs from 'fs/promises';

const OFFLINE = process.env.OFFLINE === '1' || process.env.NO_NET === '1';
const INDEX_PATH = 'src/maps.indexes.json';

async function safeFetchText(url) {
  if (OFFLINE) return null;
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

const canonUS = s => s.toUpperCase().replace('/', '.').replace('-', '.');
const six = s => (s || '').replace(/\D/g, '').padStart(6, '0');

function parseSp500(html) {
  const rows = [...html.matchAll(/<tr>\s*<td><a [^>]*>([^<]+)<\/a>[\s\S]*?<td>([A-Z.\-]+)<\/td>[\s\S]*?<td>([^<]+)<\/td>/gi)];
  return rows.map(m => ({ symbol: canonUS(m[2]), name: m[1].trim(), sector: m[3].trim() }));
}

function parseNasdaq100(html) {
  const rows = [...html.matchAll(/<tr>\s*<td><a [^>]*>([^<]+)<\/a>[\s\S]*?<td>([A-Z.\-]+)<\/td>/gi)];
  return rows.map(m => ({ symbol: canonUS(m[2]), name: m[1].trim(), sector: null }));
}

function parseKospi200(html) {
  const rows = [...html.matchAll(/<tr>[\s\S]*?<td[^>]*>\s*(?:<a [^>]*>)?([^<\n]+)<\/(?:a|td)>[\s\S]*?<td[^>]*>\s*(\d{6})\s*<\/td>/gi)];
  return rows.map(m => ({ symbol: `${six(m[2])}.KS`, name: m[1].trim(), sector: null }));
}

function parseKosdaq100(html) {
  const rows = [...html.matchAll(/<tr>[\s\S]*?<td[^>]*>\s*(?:<a [^>]*>)?([^<\n]+)<\/(?:a|td)>[\s\S]*?<td[^>]*>\s*(\d{6})\s*<\/td>/gi)];
  return rows.map(m => ({ symbol: `${six(m[2])}.KQ`, name: m[1].trim(), sector: null }));
}

async function main() {
  let current = { sp500: [], nasdaq100: [], kospi200: [], kosdaq100: [], generatedAt: null };
  try { current = JSON.parse(await fs.readFile(INDEX_PATH, 'utf8')); } catch {}

  const spTxt = await safeFetchText('https://en.wikipedia.org/wiki/List_of_S%26P_500_companies');
  const nqTxt = await safeFetchText('https://en.wikipedia.org/wiki/Nasdaq-100');
  const k200Txt = await safeFetchText('https://ko.wikipedia.org/wiki/KOSPI_200');
  const kq100Txt = await safeFetchText('https://ko.wikipedia.org/wiki/KOSDAQ_100');

  const next = {
    sp500:    spTxt   ? parseSp500(spTxt)      : current.sp500,
    nasdaq100:nqTxt   ? parseNasdaq100(nqTxt)  : current.nasdaq100,
    kospi200: k200Txt ? parseKospi200(k200Txt) : current.kospi200,
    kosdaq100:kq100Txt? parseKosdaq100(kq100Txt): current.kosdaq100,
    generatedAt: new Date().toISOString()
  };

  await fs.mkdir('src', { recursive: true });
  await fs.writeFile(INDEX_PATH, JSON.stringify(next, null, 2));
  console.log('[indexes] updated (offline-safe)');
}

main().catch(e => { console.warn('[indexes] non-fatal:', e.message); process.exit(0); });
