// tools/updateIndexMaps.mjs
import fs from "fs/promises";
import { execFileSync } from "node:child_process";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";

async function text(url) {
  try {
    return execFileSync("curl", ["-L", "-s", "-f", "-A", UA, url], {
      encoding: "utf8",
    });
  } catch {
    throw new Error(`HTTP fetch failed for ${url}`);
  }
}

// --- small helpers
const canonUS = s => s.toUpperCase().replace("/", ".").replace("-", ".");
const six = s => (s || "").replace(/\D/g, "").padStart(6, "0");

// --- S&P 500
async function fetchSP500() {
  const html = await text("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies");
  // Company name + Symbol + GICS Sector are in the first big table
  const rows = [...html.matchAll(
    /<tr>\s*<td><a [^>]*>([^<]+)<\/a>[\s\S]*?<td>([A-Z.\-]+)<\/td>[\s\S]*?<td>([^<]+)<\/td>/gi
  )];
  return rows.map((m) => ({
    symbol: canonUS(m[2]),
    name: m[1].trim(),
    sector: m[3].trim(),
  }));
}

// --- Nasdaq-100
async function fetchNasdaq100() {
  const html = await text("https://en.wikipedia.org/wiki/Nasdaq-100");
  // fallback regex: (Company, Ticker)
  const rows = [...html.matchAll(
    /<tr>\s*<td><a [^>]*>([^<]+)<\/a>[\s\S]*?<td>([A-Z.\-]+)<\/td>/gi
  )];
  return rows.map((m) => ({
    symbol: canonUS(m[2]),
    name: m[1].trim(),
    sector: null, // sector not always present on this page
  }));
}

// --- KOSPI 200 (코스피200) => append .KS
async function fetchKOSPI200() {
  const html = await text("https://ko.wikipedia.org/wiki/KOSPI_200");
  // Try to capture rows with 종목명 + 종목코드 (6 digits)
  const rows = [...html.matchAll(
    /<tr>[\s\S]*?<td[^>]*>\s*(?:<a [^>]*>)?([^<\n]+)<\/(?:a|td)>[\s\S]*?<td[^>]*>\s*(\d{6})\s*<\/td>/gi
  )];
  return rows.map((m) => ({
    symbol: `${six(m[2])}.KS`,
    name: m[1].trim(),
    sector: null, // we’ll enrich via Naver later
  }));
}

// --- KOSDAQ 100 (코스닥100) => append .KQ
async function fetchKOSDAQ100() {
  try {
    const html = await text("https://ko.wikipedia.org/wiki/KOSDAQ_100");
    const rows = [...html.matchAll(
      /<tr>[\s\S]*?<td[^>]*>\s*(?:<a [^>]*>)?([^<\n]+)<\/(?:a|td)>[\s\S]*?<td[^>]*>\s*(\d{6})\s*<\/td>/gi
    )];
    return rows.map((m) => ({
      symbol: `${six(m[2])}.KQ`,
      name: m[1].trim(),
      sector: null,
    }));
  } catch (e) {
    console.warn("KOSDAQ 100 fetch failed:", e.message);
    try {
      const cached = JSON.parse(await fs.readFile("src/maps.indexes.json", "utf8"));
      return cached.kosdaq100 || [];
    } catch {
      return [];
    }
  }
}

async function main() {
  const [sp500, nasdaq100, kospi200, kosdaq100] = await Promise.all([
    fetchSP500(),
    fetchNasdaq100(),
    fetchKOSPI200(),
    fetchKOSDAQ100(),
  ]);

  const out = { sp500, nasdaq100, kospi200, kosdaq100, generatedAt: new Date().toISOString() };
  await fs.writeFile("src/maps.indexes.json", JSON.stringify(out, null, 2));
  console.log("Wrote src/maps.indexes.json",
              `(S&P500=${sp500.length}, N100=${nasdaq100.length}, K200=${kospi200.length}, KQ100=${kosdaq100.length})`);
}

main().catch((e) => { console.error(e); process.exit(1); });

