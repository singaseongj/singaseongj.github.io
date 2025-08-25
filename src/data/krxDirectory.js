import fetch from "node-fetch";

const KRX_BASE = "https://apis.data.go.kr/1160100/service/GetKrxListedInfoService/getItemInfo";

function key() {
  const k = process.env.DATA_API_KEY;
  if (!k) throw new Error("DATA_API_KEY missing");
  return encodeURIComponent(k);
}

async function fetchPage(pageNo = 1, numOfRows = 1000) {
  const qs = new URLSearchParams({
    serviceKey: key(),
    resultType: "json",
    pageNo: String(pageNo),
    numOfRows: String(numOfRows),
  });
  const res = await fetch(`${KRX_BASE}?${qs.toString()}`);
  if (!res.ok) throw new Error(`KRX HTTP ${res.status}`);
  const j = await res.json();
  const body = j?.response?.body || {};
  const items = body?.items?.item || [];
  return Array.isArray(items) ? items : (items ? [items] : []);
}

let CACHE = null;
export async function getCompanyNameByYahooSymbol(symbol) {
  // Expect symbols like 005930.KS / 035720.KQ
  const code6 = (symbol || "").split(".")[0];
  if (!code6) return null;
  if (!CACHE) {
    // In practice, 1–2 pages covers >1k rows; loop as needed.
    const page1 = await fetchPage(1, 1000);
    CACHE = page1.map(it => ({
      code: String(it?.ISU_SRT_CD || it?.itmsCd || "").padStart(6, "0"),
      name: it?.ITM_NM || it?.itmsNm || "",
    })).filter(x => x.code && x.name);
  }
  const hit = CACHE.find(x => x.code === code6);
  return hit?.name || null; // Korean name (best for KOTRA search)
}

