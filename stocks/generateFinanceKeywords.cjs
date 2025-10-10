#!/usr/bin/env node
‘use strict’;

const fs = require(‘fs’);
const path = require(‘path’);

// Fetch polyfill for older Node.js (Node 18+ has native fetch)
const fetch = globalThis.fetch || require(‘node-fetch’);

const DATA_DIR = path.resolve(__dirname, ‘../data’);
const TAGS_PATH = path.join(DATA_DIR, ‘tags.json’);
const FINANCE_KEYWORDS_PATH = path.join(DATA_DIR, ‘finance_keywords.json’);
const CORPUS_PATH = path.join(DATA_DIR, ‘news_corpus.json’);

const HANGUL_SUFFIXES = [
‘으로써’, ‘으로서’, ‘이라면’, ‘이라도’, ‘이라고’, ‘라고’, ‘라고도’, ‘라고는’,
‘으로’, ‘에서’, ‘에게서’, ‘에게’, ‘한테’, ‘처럼’, ‘까지’, ‘부터’, ‘은’, ‘는’,
‘을’, ‘를’, ‘에’,
];

function containsHangul(value) {
return /[가-힣]/.test(String(value || ‘’));
}

function isLikelyKeyword(term) {
if (typeof term !== ‘string’) return false;
const cleaned = term.trim();
if (!cleaned || cleaned.length < 2) return false;
if (/https?:///i.test(cleaned)) return false;
if (!/[A-Za-z가-힣]/.test(cleaned)) return false;
if (cleaned.length > 60) return false;
return true;
}

function normalizeForComparison(value) {
if (!value) return ‘’;
let normalized = String(value).trim().replace(/\s+/g, ‘’);
normalized = normalized.replace(/[\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]/g, ‘’);
for (const suffix of HANGUL_SUFFIXES) {
if (normalized.endsWith(suffix)) {
normalized = normalized.slice(0, -suffix.length);
break;
}
}
return normalized;
}

function dedupeKeywords(rawKeywords) {
const deduped = [];
const seen = new Set();
for (const keyword of rawKeywords) {
const trimmed = typeof keyword === ‘string’ ? keyword.trim() : ‘’;
if (!isLikelyKeyword(trimmed)) continue;
const normalized = normalizeForComparison(trimmed);
if (!normalized || seen.has(normalized)) continue;
seen.add(normalized);
deduped.push(trimmed);
}
return deduped;
}

function readJsonIfExists(filePath) {
try {
if (!fs.existsSync(filePath)) return null;
return JSON.parse(fs.readFileSync(filePath, ‘utf8’));
} catch (err) {
console.warn(`⚠️ Failed to read JSON at ${filePath}:`, err.message);
return null;
}
}

function loadExistingDictionary() {
const existing = readJsonIfExists(FINANCE_KEYWORDS_PATH);
if (!existing) return { keywords: [], translations: {} };
const keywords = Array.isArray(existing.finance_keywords) ? existing.finance_keywords : [];
const translations =
existing.finance_keywords_en && typeof existing.finance_keywords_en === ‘object’
? existing.finance_keywords_en
: {};
return { keywords, translations };
}

function extractKeywordsFromTags() {
const tags = readJsonIfExists(TAGS_PATH);
if (!tags) {
console.log(‘ℹ️ No tags.json found; skipping tag-based extraction.’);
return { keywords: [], translations: new Map() };
}

const collected = [];
const translations = new Map();

function register(a, b) {
if (!a || !b) return;
if (containsHangul(a) && !containsHangul(b)) translations.set(a, b);
if (!containsHangul(a) && containsHangul(b)) translations.set(b, a);
}

function process(t) {
if (typeof t !== ‘string’) return;
if (isLikelyKeyword(t)) collected.push(t.trim());
}

function visit(node) {
if (!node) return;
if (Array.isArray(node)) return node.forEach(visit);
if (typeof node === ‘object’) {
for (const key of [‘term’, ‘term_ko’, ‘term_en’, ‘keyword’, ‘keyword_ko’]) {
if (typeof node[key] === ‘string’) process(node[key]);
}
register(node.term, node.term_ko);
for (const v of Object.values(node)) if (v && typeof v === ‘object’) visit(v);
}
}

visit(tags);
const deduped = dedupeKeywords(collected);
console.log(`🧩 Extracted ${deduped.length} unique terms from tags.json`);
return { keywords: deduped, translations };
}

// Dynamic cheerio import (handles both ESM and CJS)
async function loadCheerio() {
try {
// Try ESM import first (cheerio 1.0+)
const cheerioModule = await import(‘cheerio’);
return cheerioModule.load || cheerioModule.default?.load || cheerioModule;
} catch (err) {
// Fallback to CJS require
try {
return require(‘cheerio’);
} catch (requireErr) {
console.warn(‘⚠️ Cheerio not available, scraping disabled’);
return null;
}
}
}

// 📰 Multi-site scraping with corpus saving
async function fetchFromNewsSites() {
const cheerio = await loadCheerio();
if (!cheerio) {
console.log(‘⚠️ Cheerio unavailable; skipping news scraping’);
return [];
}

const allItems = [];
const sources = [
{ name: ‘Naver’, url: ‘https://finance.naver.com/news/’ },
{ name: ‘Nate’, url: ‘https://m.news.nate.com/section?mid=m02&sq=1138989’ },
{ name: ‘Daum’, url: ‘https://news.daum.net/economic/’ },
{ name: ‘MK’, url: ‘https://m.mk.co.kr/news/economy/’ },
{ name: ‘Zum’, url: ‘https://m.news.zum.com/home’ },
];

for (const { name, url } of sources) {
try {
const res = await fetch(url, { headers: { ‘User-Agent’: ‘Mozilla/5.0’ } });
const html = await res.text();
const $ = cheerio.load(html);

```
  $('a, strong, h2, h3').each((_, el) => {
    const text = $(el).text().trim();
    if (isLikelyKeyword(text)) {
      allItems.push({ source: name, text, url });
    }
  });

  console.log(`✅ Parsed ${name} (${allItems.length} total headlines so far)`);
  await new Promise(r => setTimeout(r, 250 + Math.random() * 200));
} catch (err) {
  console.warn(`⚠️ Failed to scrape ${name}:`, err.message);
}
```

}

// Save raw collected corpus for debugging
const corpus = {
collected_at: new Date().toISOString(),
total_items: allItems.length,
sources: sources.map(s => s.name),
items: allItems,
};

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(CORPUS_PATH, JSON.stringify(corpus, null, 2), ‘utf8’);
console.log(`🗂️ Saved raw corpus to ${CORPUS_PATH} (${allItems.length} entries)`);

const deduped = dedupeKeywords(allItems.map(x => x.text));
console.log(`🌐 Extracted ${deduped.length} unique keywords from scraped headlines`);
return deduped;
}

function buildTranslationMap(existing, derived, keywords) {
const map = {};
const keySet = new Set(keywords.map(k => normalizeForComparison(k)).filter(Boolean));
const include = t => !!t && keySet.has(normalizeForComparison(t)) && isLikelyKeyword(t);

if (existing) {
for (const [k, v] of Object.entries(existing)) if (include(k)) map[k] = v;
}
if (derived instanceof Map) {
for (const [k, v] of derived.entries()) if (include(k)) map[k] = v;
}
for (const k of keywords) if (!containsHangul(k) && include(k)) map[k] = map[k] || k;
return map;
}

async function generateFinanceKeywords() {
const { keywords: existing, translations: existingTrans } = loadExistingDictionary();
const { keywords: derived, translations: derivedTrans } = extractKeywordsFromTags();
const newsKeywords = await fetchFromNewsSites();

const combined = dedupeKeywords([…existing, …derived, …newsKeywords]);
const finalTrans = buildTranslationMap(existingTrans, derivedTrans, combined);

const payload = {
finance_keywords: combined,
finance_keywords_en: finalTrans,
generated_at: new Date().toISOString(),
};

fs.writeFileSync(FINANCE_KEYWORDS_PATH, JSON.stringify(payload, null, 2), ‘utf8’);
console.log(`💾 Wrote ${combined.length} keywords to ${FINANCE_KEYWORDS_PATH}`);
console.log(`🗺 Translation map covers ${Object.keys(finalTrans).length} entries`);
return payload;
}

// CJS entry point check
if (require.main === module) {
generateFinanceKeywords().catch(err => {
console.error(‘❌ Generation failed:’, err);
process.exitCode = 1;
});
}

module.exports = { generateFinanceKeywords };
