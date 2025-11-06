import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";

const KRX_BASE = "https://apis.data.go.kr/1160100/service/GetKrxListedInfoService/getItemInfo";
const UA = "Mozilla/5.0 (compatible; SingaseongKRX/1.0; +https://singaseongj.github.io/)";
const CACHE_PATH = path.join("cache", "krx-directory.json");

function portalKeyRaw() {
  const k = process.env.DATA_API_KEY;
  if (!k) throw new Error("DATA_API_KEY missing");
  return k; // RAW decoded key (no manual encode)
}

function portalKeyDecoded() {
  const raw = portalKeyRaw();
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function readCacheFallback() {
  try {
    const txt = await fs.readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(txt);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return null;
}

async function writeCacheFallback(items) {
  try {
    await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await fs.writeFile(CACHE_PATH, JSON.stringify(items, null, 2));
  } catch {}
}

async function fetchKrxPage(pageNo = 1, numOfRows = 1000) {
  const qs = new URLSearchParams({
    serviceKey: portalKeyDecoded(),
    resultType: "json",
    pageNo: String(pageNo),
    numOfRows: String(numOfRows),
  });
  const url = `${KRX_BASE}?${qs.toString()}`;
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA } });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); }
  catch {
    throw new Error(`KRX non-JSON response (first 60 chars): ${text.slice(0,60)}`);
  }
  const body = j?.response?.body || {};
  const items = body?.items?.item || [];
  return Array.isArray(items) ? items : (items ? [items] : []);
}

let _dirCachePromise;
export async function getKrxDirectory() {
  if (_dirCachePromise) return _dirCachePromise;
  _dirCachePromise = (async () => {
    const maxTries = 3;
    let lastError;
    for (let i = 1; i <= maxTries; i++) {
      try {
        const page1 = await fetchKrxPage(1, 1000);
        const mapped = page1.map(it => ({
          code: String(it?.ISU_SRT_CD || it?.itmsCd || "").padStart(6, "0"),
          name: it?.ITM_NM || it?.itmsNm || "",
        })).filter(x => x.code && x.name);
        if (mapped.length) await writeCacheFallback(mapped);
        return mapped;
      } catch (e) {
        console.error(`[KRX] attempt ${i} failed:`, e.message);
        lastError = e;
        await new Promise(r => setTimeout(r, i * 1000));
      }
    }
    const cached = await readCacheFallback();
    if (cached?.length) {
      console.warn('[KRX] using cached directory due to repeated failures');
      return cached;
    }
    throw lastError || new Error('Failed to load KRX directory');
  })();
  return _dirCachePromise;
}

async function tryLocalName(symbol) {
  const files = ["ticker-cache.json", "pools.json", "recommendations.json"];
  for (const f of files) {
    try {
      const s = await fs.readFile(f, "utf8");
      const j = JSON.parse(s);
      const n = j?.[symbol]?.name || j?.tickers?.[symbol]?.name;
      if (n) return n;
    } catch {}
  }
  return null;
}

export async function getCompanyNameByYahooSymbol(symbol) {
  const local = await tryLocalName(symbol);
  if (local) return local;
  const dir = await getKrxDirectory();
  const code6 = (symbol || "").split(".")[0];
  return dir.find(x => x.code === code6)?.name || null;
}
