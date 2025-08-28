import fs from 'fs/promises';

const MAX_PER_SYMBOL = Number(process.env.NAVER_MAX_KEYWORDS || 8);

// generic suffix/prefix templates that tend to help with intent
const TEMPLATES_KR = ['주가', '실적', '리콜', '파업', '규제', '적자', '흑자'];
const TEMPLATES_EN = ['stock', 'earnings', 'recall', 'strike', 'regulation'];

// minimal stopwords to avoid noise
const STOPWORDS = new Set([
  '뉴스','기사','속보','오늘','내일','가격','가격표','무료','다운로드','공식','채용',
  'the','and','for','of','to','in','on','with'
]);

// helpful exonyms (you can expand this list over time)
const EXONYMS = {
  AAPL: ['애플','Apple','아이폰','아이패드','맥북','iPhone','iPad','Mac'],
  MSFT: ['마이크로소프트','Microsoft','윈도우','오피스','Windows','Azure','Office'],
  TSLA: ['테슬라','Tesla','사이버트럭','모델3','Model 3','Model Y'],
  NVDA: ['엔비디아','NVIDIA','지포스','CUDA','HBM'],
  META: ['메타','Meta','페이스북','인스타그램','Facebook','Instagram'],
  GOOGL: ['구글','Google','유튜브','YouTube'],
};

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const k = norm(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function norm(s) {
  if (!s) return '';
  return String(s)
    .replace(/\s+/g,' ')
    .replace(/[^\p{L}\p{N}\s.\-+]/gu,'')
    .trim()
    .toLowerCase();
}

// add KR/EN templates conservatively
function applyTemplates(baseTerms, isKR) {
  const out = new Set(baseTerms);
  const templates = isKR ? TEMPLATES_KR : TEMPLATES_EN;
  for (const term of baseTerms) {
    // avoid attaching templates to very short terms or pure tickers
    if (/^\d{6}\.K[QS]$/.test(term) || /^[A-Z.\-]{1,7}$/.test(term)) continue;
    for (const t of templates) {
      out.add(`${term} ${t}`);
    }
  }
  return Array.from(out);
}

// mine frequent nouns from recent news titles/snippets you already store
function mineFromNews(symbol, newsJson, limit=5) {
  try {
    const items = (newsJson?.[symbol]?.items) || []; // shape up to you
    const text = items.slice(0, 50).map(x => `${x.title || ''} ${x.summary || ''}`).join(' ');
    const tokens = (text.match(/[\p{L}\p{N}][\p{L}\p{N}\-+]{1,20}/gu) || [])
      .map(s => s.trim())
      .filter(s => s.length >= 2 && !STOPWORDS.has(norm(s)));
    const counts = new Map();
    for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
    return Array.from(counts.entries())
      .sort((a,b)=>b[1]-a[1])
      .slice(0, limit)
      .map(([w])=>w);
  } catch { return []; }
}

async function readJsonOrNull(p) {
  try { return JSON.parse(await fs.readFile(p,'utf8')); } catch { return null; }
}

/**
 * Build keyword dictionary for NAVER baskets
 * @param {Object} params
 *  - symbols: string[] symbols to build for
 *  - seeds: {[symbol]: string[]} small seed terms (your current map)
 *  - symbolToName: {[symbol]: displayName} (optional, to seed company names)
 *  - newsFeatures: object (optional) to mine extra words
 *  - newsFilePath: string (optional) fallback: data/market-news.json
 *  - overridesPath: string (optional) data/keyword-overrides.json
 *  - aliasesPath: string (optional) data/aliases.json
 *  - brandsPath: string (optional) data/brands.json
 */
export async function buildKeywordDict({
  symbols,
  seeds = {},
  symbolToName = {},
  newsFeatures = null,
  newsFilePath = 'data/market-news.json',
  overridesPath = 'data/keyword-overrides.json',
  aliasesPath = 'data/aliases.json',
  brandsPath = 'data/brands.json',
}) {
  const aliases = await readJsonOrNull(aliasesPath) || {};     // { symbol: [alias1, alias2...] }
  const brands  = await readJsonOrNull(brandsPath)  || {};     // { symbol: [brand1, app1, product1...] }
  const overrides = await readJsonOrNull(overridesPath) || { add:{}, ignore:{} };
  const marketNews = newsFeatures ? null : (await readJsonOrNull(newsFilePath));

  const out = {};
  for (const sym of symbols) {
    const display = symbolToName[sym] || sym;
    const isKR = /\.K[QS]$/.test(sym);

    // 1) base candidates
    let candidates = [
      ...(seeds[sym] || []),
      ...(aliases[sym] || []),
      ...(brands[sym] || []),
      ...(EXONYMS[sym] || []),
      display
    ];

    // 2) mined tokens from news (either from NEWS_FEATURES-like or market-news.json)
    const mined = newsFeatures
      ? mineFromNews(sym, newsFeatures, 5)
      : mineFromNews(sym, { [sym]: marketNews }, 5);
    candidates.push(...mined);

    // 3) prepend ticker where helpful (US tickers often searched as-is)
    if (!isKR) candidates.push(sym);

    // 4) apply templates (KR/EN)
    candidates = applyTemplates(uniq(candidates), isKR);

    // 5) clean, filter, rank
    let clean = uniq(candidates)
      .filter(w => norm(w).length >= 2)
      .filter(w => !STOPWORDS.has(norm(w)));

    // simple ranking: prefer terms that include company/brand names; then shorter; then mined tokens
    const baseName = norm(display).replace(/\s/g,'');
    const hardHits = new Set((seeds[sym] || []).map(norm).concat((brands[sym] || []).map(norm)));
    const score = (w) => {
      const nw = norm(w);
      let s = 0;
      if (hardHits.has(nw) || nw.includes(baseName)) s += 3;
      if (/주가|earnings|실적|stock/i.test(w)) s += 2;
      if (nw === norm(sym)) s += 1;
      s += Math.max(0, 2 - (w.length / 10)); // prefer shorter
      return s;
    };

    clean.sort((a,b)=>score(b)-score(a));

    // 6) apply overrides
    const add = overrides.add?.[sym] || [];
    const ignore = new Set((overrides.ignore?.[sym] || []).map(norm));
    clean = uniq([...add, ...clean]).filter(w => !ignore.has(norm(w)));

    // 7) cap
    out[sym] = clean.slice(0, MAX_PER_SYMBOL);
  }
  return out;
}

