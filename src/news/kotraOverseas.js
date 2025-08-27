import fetch from "node-fetch";

const BASE = "https://apis.data.go.kr/B410001/kotra_overseasMarketNews/ovseaMrktNews/ovseaMrktNews";

// Accept decoded OR already-encoded key without double-encoding
function getPortalKeyRaw() {
  const k = process.env.DATA_API_KEY;
  if (!k) throw new Error("DATA_API_KEY missing");
  // If key looks percent-encoded, decode once so URLSearchParams can encode it exactly once
  return /%[0-9A-Fa-f]{2}/.test(k) ? decodeURIComponent(k) : k;
}

function toISO(d) { try { return new Date(d).toISOString(); } catch { return new Date().toISOString(); } }

function normalizeOne(it) {
  return {
    title: it?.newsTitl || "(no title)",
    url: it?.kotraNewsUrl || "",
    source: "KOTRA 해외시장뉴스",
    publishedAt: toISO(it?.othbcDt || Date.now()),
    summary: it?.cntntSumar || "",
    keywords: it?.kwrd || "",
    region: it?.regn || "",
    country: it?.natn || "",
  };
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter(x => {
    const k = (x.url || "").trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function fetchPage({ pageNo = 1, numOfRows = 50, withSummary = true, q = {} } = {}) {
  // q can contain search1..search9; we’ll forward only defined ones.
  const params = new URLSearchParams({
    serviceKey: getPortalKeyRaw(),   // RAW; URLSearchParams will encode once
    type: "json",
    pageNo: String(pageNo),
    numOfRows: String(numOfRows),
  });
  if (withSummary) params.set("search8", "Y"); // include summary/keywords/body fields

  // Optional filters (search1..search9)
  for (let i = 1; i <= 9; i++) {
    const key = `search${i}`;
    if (q[key]) params.set(key, q[key]);
  }

  const res = await fetch(`${BASE}?${params.toString()}`, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`KOTRA non-JSON response (first 80 chars): ${text.slice(0,80)}`); }

  const ok = json?.response?.header?.resultCode === "00";
  if (!ok) {
    const code = json?.response?.header?.resultCode;
    const msg  = json?.response?.header?.resultMsg;
    throw new Error(`KOTRA error ${code}: ${msg}`);
  }

  const raw = json?.response?.body?.itemList?.item ?? [];
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return list.map(normalizeOne).filter(x => x.url);
}

// Pull recent pages and optionally filter by keyword
export async function fetchKotraRecent({ pages = 2, pageSize = 50, keyword } = {}) {
  const batches = [];
  for (let p = 1; p <= pages; p++) batches.push(fetchPage({ pageNo: p, numOfRows: pageSize }));
  const merged = dedupeByUrl((await Promise.all(batches)).flat());
  if (!keyword) return merged;
  return merged.filter(x =>
    (x.title && x.title.includes(keyword)) ||
    (x.summary && x.summary.includes(keyword)) ||
    (x.keywords && x.keywords.includes(keyword))
  );
}

