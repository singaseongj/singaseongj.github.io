// KOTRA Overseas Market News (backup)
// Endpoint (as provided):
// https://apis.data.go.kr/B410001/kotra_overseasMarketNews/ovseaMrktNews/ovseaMrktNews
// Required query: serviceKey, numOfRows, pageNo
// Response shape (simplified):
// { response: { header:{resultCode,resultMsg}, body:{ totalCnt, pageNo, itemList:{ item: [...] }, numOfRows } } }

import fetch from "node-fetch";

const BASE = "https://apis.data.go.kr/B410001/kotra_overseasMarketNews/ovseaMrktNews/ovseaMrktNews";

function apiKeyRaw() {
  const k = process.env.DATA_API_KEY;
  if (!k) throw new Error("DATA_API_KEY missing");
  return k; // RAW
}

function toISO(d) {
  try { return new Date(d).toISOString(); } catch { return new Date().toISOString(); }
}

// Normalize one raw item to your site/news shape
function normalizeOne(it) {
  return {
    title: it?.newsTitl || "(no title)",
    url: it?.kotraNewsUrl || "",
    source: "KOTRA 해외시장뉴스",
    // Provided example had othbcDt like "2024-09-04" (string). Convert to ISO.
    publishedAt: toISO(it?.othbcDt || Date.now()),
    summary: it?.cntntSumar || "",
    region: it?.regn || "",
    country: it?.natn || "",
  };
}

function dedupeByUrl(arr) {
  const seen = new Set();
  return arr.filter(x => {
    const k = (x.url || "").trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Fetch a single page (default larger page to reduce calls)
export async function fetchKotraOverseasPage({ pageNo = 1, numOfRows = 50 } = {}) {
  const qs = new URLSearchParams({
    serviceKey: apiKeyRaw(),
    numOfRows: String(numOfRows),
    pageNo: String(pageNo),
    _type: "json",
  });
  const url = `${BASE}?${qs.toString()}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`KOTRA HTTP ${res.status}`);
  const json = await res.json();

  const ok = json?.response?.header?.resultCode === "00";
  if (!ok) return [];

  const raw = json?.response?.body?.itemList?.item ?? [];
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return list.map(normalizeOne).filter(x => x.url);
}

// Pull a few recent pages and merge
export async function fetchKotraOverseasRecent(pages = 2, pageSize = 50) {
  const batches = [];
  for (let p = 1; p <= pages; p++) {
    batches.push(fetchKotraOverseasPage({ pageNo: p, numOfRows: pageSize }));
  }
  const results = (await Promise.all(batches)).flat();
  return dedupeByUrl(results).slice(0, pages * pageSize);
}

// Very light keyword filter (used for per-ticker backup)
export function filterByKeyword(items, keyword) {
  if (!keyword) return [];
  const kw = String(keyword).trim();
  return items.filter(x =>
    (x.title && x.title.includes(kw)) ||
    (x.summary && x.summary.includes(kw))
  );
}

