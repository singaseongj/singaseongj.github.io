// tools/updateIndexMaps.mjs
// Builds name->ticker map for S&P 500 + Nasdaq-100 with retries, IPv4 preference, and offline fallbacks.

import { writeFile, mkdir, readFile } from "fs/promises";
import path from "node:path";
import url from "node:url";
import dns from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";

dns.setDefaultResultOrder?.("ipv4first");
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

const FMP = process.env.FMP_KEY || "";
const OFFLINE = process.env.OFFLINE === "1";
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function normName(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/\u00AD|\u034F|\u061C|[\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function expandVariants(name) {
  const n = normName(name);
  const variants = new Set([n]);
  const base = n.replace(/,?\s+(Inc\.?|Incorporated|Corp\.?|Corporation|Company|Co\.?|Ltd\.?|Limited|PLC|N\.V\.|S\.A\.|A\/S)$/i, "").trim();
  variants.add(base);
  variants.add(base.replace(/\s*&\s*/g, " and "));
  variants.add(base.replace(/\s+and\s+/gi, " & "));
  variants.add(base.replace(/\s+/g, "")); // ultra-lenient
  const m = base.match(/\b(Class|Series)\s+([ABCDEF])\b/i);
  if (m) {
    const cls = m[2].toUpperCase();
    const noClass = base.replace(/\s*\(?(Class|Series)\s+[A-F]\)?/i, "").trim();
    variants.add(noClass);
    variants.add(`${noClass} (${cls})`);
  }
  return [...variants];
}

async function get(url, kind = "text", { timeoutMs = 8000, retries = 2 } = {}) {
  if (OFFLINE) throw new Error("offline");
  let last;
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        signal: ac.signal,
        headers: { "User-Agent": "stock-recs/ci" },
      });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return kind === "json" ? r.json() : r.text();
    } catch (e) {
      clearTimeout(t);
      last = e;
      if (i < retries) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw last;
}

async function readOffline(name) {
  try {
    const p = path.resolve(__dirname, "../data/indexes", `${name}.offline.json`);
    const txt = await readFile(p, "utf8");
    return JSON.parse(txt);
  } catch {
    return [];
  }
}

async function fetchSP500() {
  // 1) FMP (if available)
  if (FMP) {
    try {
      const arr = await get(`https://financialmodelingprep.com/api/v3/sp500_constituent?apikey=${FMP}`, "json");
      if (Array.isArray(arr)) return arr.map(x => ({ symbol: x.symbol, name: x.name }));
    } catch {}
  }
  // 2) Wikipedia
  try {
    const html = await get("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", "text");
    const rows = [...html.matchAll(/<tr>\s*<td><a[^>]+>([A-Z.\-]+)<\/a><\/td>\s*<td><a[^>]*>([^<]+)<\/a>/g)];
    return rows.map(([, symbol, name]) => ({ symbol, name }));
  } catch {}
  // 3) Offline snapshot
  const off = await readOffline("sp500");
  return off;
}

async function fetchNasdaq100() {
  if (FMP) {
    try {
      const arr = await get(`https://financialmodelingprep.com/api/v3/nasdaq_constituent?apikey=${FMP}`, "json");
      if (Array.isArray(arr) && arr[0]?.symbol && arr[0]?.name) {
        return arr.map(x => ({ symbol: x.symbol, name: x.name }));
      }
    } catch {}
  }
  try {
    const html = await get("https://en.wikipedia.org/wiki/Nasdaq-100", "text");
    const rows = [...html.matchAll(/<tr>\s*<td><a[^>]*>([A-Z.\-]+)<\/a><\/td>\s*<td>(?:<a[^>]*>)?([^<]+)</g)];
    return rows.map(([, symbol, name]) => ({ symbol, name }));
  } catch {}
  const off = await readOffline("nasdaq100");
  return off;
}

function buildMap(pairs) {
  const map = {};
  for (const { symbol, name } of pairs) {
    if (!symbol || !name) continue;
    for (const v of expandVariants(name)) map[v] = symbol;
  }
  // helpful class-share aliases
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
if (!sp.length || !nd.length) {
  console.warn("[index-maps] Network failed; used offline snapshots where available.");
}

