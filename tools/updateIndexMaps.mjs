// tools/updateIndexMaps.mjs
import fs from "fs/promises";
import { execFileSync } from "node:child_process";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";

let cached = {};

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
  try {
    const html = await text("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies");
    const rows = [...html.matchAll(/<tr>\s*<td[^>]*>\s*(?:<a [^>]*>)?([A-Z.\-]+)<\/(?:a|td)>[\s\S]*?<td[^>]*>\s*(?:<a [^>]*>)?([^<]+)<\/(?:a|td)>[\s\S]*?<td[^>]*>\s*([^<]+)<\/td>/gi)];
    if (rows.length < 400) throw new Error("parse failed");
    return rows.map(m => ({ symbol: canonUS(m[1]), name: m[2].trim(), sector: m[3].trim() }));
  } catch (e) {
    console.warn("S&P 500 fetch failed:", e.message);
    return cached.sp500 || [];
  }
}

// --- Nasdaq-100
async function fetchNasdaq100() {
  try {
    const html = await text("https://en.wikipedia.org/wiki/Nasdaq-100");
    const part = html.split('id="constituents"')[1] || "";
    const rows = [...part.matchAll(/<tr>\s*<td>([A-Z.\-]+)<\/td>\s*<td[^>]*>\s*(?:<a [^>]*>)?([^<]+)<\/(?:a|td)>/gi)];
    if (rows.length < 80) throw new Error("parse failed");
    return rows.map(m => ({ symbol: canonUS(m[1]), name: m[2].trim(), sector: null }));
  } catch (e) {
    console.warn("Nasdaq-100 fetch failed:", e.message);
    return cached.nasdaq100 || [];
  }
}

// --- KOSPI 200 (코스피200) => append .KS
async function fetchKOSPI200() {
  try {
    const html = await text("https://ko.wikipedia.org/wiki/KOSPI_200");
    const rows = [...html.matchAll(/<tr>[\s\S]*?<td[^>]*>\s*(?:<a [^>]*>)?([^<\n]+)<\/(?:a|td)>[\s\S]*?<td[^>]*>\s*(\d{6})\s*<\/td>/gi)];
    if (rows.length < 150) throw new Error("parse failed");
    return rows.map(m => ({ symbol: `${six(m[2])}.KS`, name: m[1].trim(), sector: null }));
  } catch (e) {
    console.warn("KOSPI 200 fetch failed:", e.message);
    return cached.kospi200 || [];
  }
}

// --- KOSDAQ 100 (코스닥100) => append .KQ
async function fetchKOSDAQ100() {
  try {
    const html = await text("https://ko.wikipedia.org/wiki/KOSDAQ_100");
    const rows = [...html.matchAll(/<tr>[\s\S]*?<td[^>]*>\s*(?:<a [^>]*>)?([^<\n]+)<\/(?:a|td)>[\s\S]*?<td[^>]*>\s*(\d{6})\s*<\/td>/gi)];
    if (rows.length < 80) throw new Error("parse failed");
    return rows.map(m => ({ symbol: `${six(m[2])}.KQ`, name: m[1].trim(), sector: null }));
  } catch (e) {
    console.warn("KOSDAQ 100 fetch failed:", e.message);
    return cached.kosdaq100 || [];
  }
}

async function main() {
  try {
    cached = JSON.parse(await fs.readFile("src/maps.indexes.json", "utf8"));
  } catch {}

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

