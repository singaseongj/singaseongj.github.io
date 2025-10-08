const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// CommonJS-compatible polyfill for fetch
if (typeof fetch === 'undefined') {
  const fetchPolyfill = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
  global.fetch = fetchPolyfill;
}

const HANGUL_REGEX = /[\u3131-\u318E\uAC00-\uD7A3]/;
const SMALL_WORDS = new Set(['and', 'or', 'the', 'a', 'an', 'for', 'to', 'of', 'in', 'on', 'by', 'at', 'with']);

const KEYWORD_MARKET_QUERIES = [
  { market: 'KOSPI', query: '코스피 주요 이슈' },
  { market: 'KOSDAQ', query: '코스닥 주요 이슈' },
  { market: 'S&P 500', query: 'us stock market top themes' },
  { market: 'NASDAQ 100', query: 'nasdaq 100 trending stocks' },
];

const DEFAULT_TAG_FILE = path.join('data', 'tags.json');
const TAG_OUTPUT_FILE = process.env.MARKET_TAG_FILE || DEFAULT_TAG_FILE;
const KEYWORD_OUTPUT_FILE = process.env.MARKET_KEYWORD_FILE || TAG_OUTPUT_FILE;

const translationCache = new Map();

function ensureDirFor(filePath) {
  if (!filePath) return;
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function hasHangulText(str) {
  return HANGUL_REGEX.test(String(str || ''));
}

function normalizeKoKeywordTerm(term) {
  const raw = String(term || '').replace(/\s+/g, ' ').trim();
  return raw;
}

function formatTagDisplay(term) {
  const raw = String(term || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (hasHangulText(raw)) {
    return normalizeKoKeywordTerm(raw);
  }
  const words = raw.split(' ');
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && SMALL_WORDS.has(lower)) {
        return lower;
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function setTranslationCache(term, termKo) {
  const formatted = formatTagDisplay(term);
  const normalizedKo = normalizeKoKeywordTerm(termKo);
  if (!formatted || !normalizedKo) return;
  translationCache.set(formatted, normalizedKo);
}

function translateTagToKo(term) {
  const formatted = formatTagDisplay(term);
  if (!formatted) return '';
  const cached = translationCache.get(formatted);
  if (cached) return cached;
  return formatted;
}

function collectEntriesFromSnapshot(snapshot) {
  const entries = [];
  if (!snapshot || typeof snapshot !== 'object') return entries;
  const pushEntry = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    const term = formatTagDisplay(entry.term || entry.en);
    const termKo = normalizeKoKeywordTerm(entry.term_ko || entry.ko || '');
    if (!term) return;
    entries.push({ term, term_ko: termKo || (hasHangulText(term) ? term : '') });
  };
  if (Array.isArray(snapshot.discovered_keywords)) {
    snapshot.discovered_keywords.forEach(pushEntry);
  }
  if (Array.isArray(snapshot.keywords)) {
    snapshot.keywords.forEach(pushEntry);
  }
  if (snapshot.translations && typeof snapshot.translations === 'object') {
    Object.entries(snapshot.translations).forEach(([term, value]) => {
      pushEntry({ term, term_ko: value?.ko });
    });
  }
  return entries;
}

function buildTermKoLookup(snapshot) {
  const lookup = new Map();
  for (const entry of collectEntriesFromSnapshot(snapshot)) {
    if (!entry.term) continue;
    const formatted = formatTagDisplay(entry.term);
    const termKo = normalizeKoKeywordTerm(entry.term_ko || '');
    if (!formatted || !termKo) continue;
    lookup.set(formatted, termKo);
  }
  return lookup;
}

function lookupKoFromMap(map, term) {
  if (!map || typeof map.get !== 'function') return null;
  const formatted = formatTagDisplay(term);
  return map.get(formatted) || null;
}

function primeTranslationCacheFromSnapshot(snapshot) {
  for (const entry of collectEntriesFromSnapshot(snapshot)) {
    if (entry.term && entry.term_ko) {
      setTranslationCache(entry.term, entry.term_ko);
    }
  }
}

function normalizeKeywordEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const term = formatTagDisplay(entry.term || entry.en);
  if (!term) return null;
  const rawKo = normalizeKoKeywordTerm(entry.term_ko || entry.ko || '');
  const termKo = rawKo || (hasHangulText(term) ? term : term);
  return { term, term_ko: termKo };
}

function dedupeKeywords(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || !item.term) continue;
    const key = item.term;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function collectSignificantPhrases({ preCollected = null, snapshotPath = TAG_OUTPUT_FILE } = {}) {
  if (preCollected && typeof preCollected === 'object') {
    const normalized = Array.isArray(preCollected.keywords)
      ? preCollected.keywords.map(normalizeKeywordEntry).filter(Boolean)
      : [];
    return {
      keywords: normalized,
      totalRaw: preCollected.totalRaw ?? normalized.length,
      uniqueTerms: preCollected.uniqueTerms ?? new Set(normalized.map((k) => k.term)).size,
    };
  }

  const existing = readJsonSafe(snapshotPath);
  if (existing) {
    const keywords = collectEntriesFromSnapshot(existing).map(normalizeKeywordEntry).filter(Boolean);
    return {
      keywords: dedupeKeywords(keywords),
      totalRaw: keywords.length,
      uniqueTerms: new Set(keywords.map((k) => k.term)).size,
    };
  }

  return { keywords: [], totalRaw: 0, uniqueTerms: 0 };
}

function buildTranslationMap(keywords) {
  const out = {};
  for (const item of keywords) {
    const term = item.term;
    const ko = item.term_ko || item.term;
    if (!term || !ko) continue;
    setTranslationCache(term, ko);
    out[term] = {
      en: term,
      ko,
      translator: 'pre-collected',
      cachedAt: new Date().toISOString(),
    };
  }
  return out;
}

async function buildMarketKeywordSnapshot({ outputPath = KEYWORD_OUTPUT_FILE, preCollected = null } = {}) {
  const collected = await collectSignificantPhrases({ preCollected, snapshotPath: outputPath });
  const keywords = dedupeKeywords(collected.keywords || []);
  const now = new Date();
  const base = {
    generatedAt: now.toISOString(),
    timezone: 'Asia/Seoul',
    date: now.toISOString().slice(0, 10),
    window: '12_hours',
    total_phrases: keywords.length,
    markets: KEYWORD_MARKET_QUERIES.map((m) => m.market),
    keywords,
    discovered_keywords: keywords,
  };
  base.translations = buildTranslationMap(keywords);

  if (outputPath) {
    ensureDirFor(outputPath);
    await fsp.writeFile(outputPath, JSON.stringify(base, null, 2));
    if (KEYWORD_OUTPUT_FILE && KEYWORD_OUTPUT_FILE !== outputPath) {
      ensureDirFor(KEYWORD_OUTPUT_FILE);
      await fsp.writeFile(KEYWORD_OUTPUT_FILE, JSON.stringify(base, null, 2));
    }
  }

  return base;
}

async function writeSignificantPhrasesJson({ outputPath = TAG_OUTPUT_FILE, preCollected = null } = {}) {
  return buildMarketKeywordSnapshot({ outputPath, preCollected });
}

async function collectKoreanFirstKeywords({ snapshot = null, preCollected = null } = {}) {
  const baseSnapshot = snapshot || (await buildMarketKeywordSnapshot({ outputPath: null, preCollected }));
  const keywords = Array.isArray(baseSnapshot?.keywords) ? baseSnapshot.keywords : [];
  return keywords.filter((item) => hasHangulText(item.term_ko || item.term));
}

async function writeKoreanFirstTagsJson({ outputPath = TAG_OUTPUT_FILE, snapshot = null, preCollected = null } = {}) {
  const keywords = await collectKoreanFirstKeywords({ snapshot, preCollected });
  const payload = {
    generatedAt: new Date().toISOString(),
    timezone: 'Asia/Seoul',
    keywords,
  };
  if (outputPath) {
    ensureDirFor(outputPath);
    await fsp.writeFile(outputPath, JSON.stringify(payload, null, 2));
  }
  return payload;
}

async function naverSearch({
  query,
  NAVER_ID,
  NAVER_SECRET,
  display = 20,
  start = 1,
  sort = 'date',
} = {}) {
  if (!query) {
    return { items: [] };
  }
  const headers = {};
  if (NAVER_ID) headers['X-Naver-Client-Id'] = NAVER_ID;
  if (NAVER_SECRET) headers['X-Naver-Client-Secret'] = NAVER_SECRET;
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=${display}&start=${start}&sort=${sort}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Naver search failed (${res.status}): ${text}`);
  }
  return res.json();
}

// 🧩 Export CommonJS module
module.exports = {
  KEYWORD_MARKET_QUERIES,
  TAG_OUTPUT_FILE,
  KEYWORD_OUTPUT_FILE,
  hasHangulText,
  normalizeKoKeywordTerm,
  formatTagDisplay,
  setTranslationCache,
  translateTagToKo,
  buildTermKoLookup,
  lookupKoFromMap,
  primeTranslationCacheFromSnapshot,
  collectSignificantPhrases,
  buildMarketKeywordSnapshot,
  writeSignificantPhrasesJson,
  collectKoreanFirstKeywords,
  writeKoreanFirstTagsJson,
  naverSearch
};
