// Build a name -> ticker dictionary for S&P 500 + Nasdaq 100
import { writeFile, mkdir } from "fs/promises";
import { load } from "cheerio";

const FMP = process.env.FMP_KEY || ""; // optional; falls back to Wikipedia if empty

async function json(url) {
  const r = await fetch(url, { headers: { "User-Agent": "stock-recs/ci" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
  return r.json();
}
async function text(url) {
  const r = await fetch(url, { headers: { "User-Agent": "stock-recs/ci" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
  return r.text();
}

function decodeEntities(s) {
  return load(s || "").text();
}

function normName(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/\u00AD|\u034F|\u061C|[\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Expand common name variants (Inc., Corp., PLC; “Class A/B/C”; & vs and)
function expandVariants(name) {
  const n = normName(name);
  const variants = new Set([n]);
  const base = n
    .replace(/,?\s+(Inc\.?|Incorporated|Corp\.?|Corporation|Company|Co\.?|Ltd\.?|Limited|PLC|N\.V\.|S\.A\.|A\/S)$/i, "")
    .trim();
  variants.add(base);
  variants.add(base.replace(/\s*&\s*/g, " and "));
  variants.add(base.replace(/\s+and\s+/gi, " & "));
  variants.add(base.replace(/\s+/g, "")); // super-lenient

  // class shares
  const m = base.match(/\b(Class|Series)\s+([ABCDEF])\b/i);
  if (m) {
    const cls = m[2].toUpperCase();
    variants.add(base.replace(/\s*\(?(Class|Series)\s+[A-F]\)?/i, "").trim());
    variants.add(`${base.replace(/\s*\(?(Class|Series)\s+[A-F]\)?/i, "").trim()} (${cls})`);
  }
  return [...variants];
}

async function fetchSP500() {
  // 1) Try FMP (if available)
  if (FMP) {
    try {
      // FMP endpoint commonly used in examples
      const arr = await json(`https://financialmodelingprep.com/api/v3/sp500_constituent?apikey=${FMP}`);
      return arr.map(x => ({ symbol: x.symbol, name: decodeEntities(x.name) }));
    } catch {}
  }
  // 2) Wikipedia fallback (robust enough for CI)
  const html = await text("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies");
  const rows = [...html.matchAll(/<tr>\s*<td><a[^>]+>([A-Z\.\-]+)<\/a><\/td>\s*<td><a[^>]*>([^<]+)<\/a>/g)];
  return rows.map(([, symbol, name]) => ({ symbol, name: decodeEntities(name) }));
}

async function fetchNasdaq100() {
  if (FMP) {
    try {
      // Many users mirror NASDAQ-100 here; keep the fallback just in case endpoint differs
      const arr = await json(`https://financialmodelingprep.com/api/v3/nasdaq_constituent?apikey=${FMP}`);
      if (Array.isArray(arr) && arr[0]?.symbol && arr[0]?.name) {
        return arr.map(x => ({ symbol: x.symbol, name: decodeEntities(x.name) }));
      }
    } catch {}
  }
  const html = await text("https://en.wikipedia.org/wiki/Nasdaq-100");
  // First wikitable with “Ticker” + “Company”
  const rows = [...html.matchAll(/<tr>\s*<td><a[^>]*>([A-Z\.\-]+)<\/a><\/td>\s*<td>(?:<a[^>]*>)?([^<]+)</g)];
  return rows.map(([, symbol, name]) => ({ symbol, name: decodeEntities(name) }));
}

function buildMap(pairs) {
  const map = {};
  for (const { symbol, name } of pairs) {
    if (!symbol || !name) continue;
    for (const v of expandVariants(decodeEntities(name))) {
      map[v] = symbol;
    }
  }
  // Helpful manual aliases
  map["Berkshire Hathaway (B)"] = "BRK-B";
  map["Berkshire Hathaway (A)"] = "BRK-A";
  map["Brown-Forman (B)"] = "BF-B";
  map["Brown-Forman (A)"] = "BF-A";
  return map;
}

const sp = await fetchSP500();
const nd = await fetchNasdaq100();
const mergedMap = buildMap([...sp, ...nd]);

await mkdir("data/indexes", { recursive: true });
await writeFile("data/indexes/sp500.json", JSON.stringify(sp, null, 2));
await writeFile("data/indexes/nasdaq100.json", JSON.stringify(nd, null, 2));
await mkdir("src", { recursive: true });
await writeFile("src/maps.indexes.json", JSON.stringify(mergedMap, null, 2));

console.log(`[index-maps] S&P 500: ${sp.length}, NASDAQ-100: ${nd.length}, merged keys: ${Object.keys(mergedMap).length}`);
