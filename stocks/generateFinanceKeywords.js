'use strict';

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import cheerio from 'cheerio';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TAGS_PATH = path.resolve(__dirname, '../data/tags.json');
const FINANCE_KEYWORDS_PATH = path.resolve(__dirname, '../data/finance_keywords.json');

const HANGUL_SUFFIXES = [
  '으로써', '으로서', '이라면', '이라도', '이라고', '라고', '라고도', '라고는',
  '으로', '에서', '에게서', '에게', '한테', '처럼', '까지', '부터', '은', '는',
  '을', '를', '에',
];

function containsHangul(value) {
  return /[가-힣]/.test(String(value || ''));
}

function isLikelyKeyword(term) {
  if (typeof term !== 'string') return false;
  const cleaned = term.trim();
  if (!cleaned || cleaned.length < 2) return false;
  if (/https?:\/\//i.test(cleaned)) return false;
  if (/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(cleaned)) return false;
  if (!/[A-Za-z가-힣]/.test(cleaned)) return false;
  if (cleaned.length > 50) return false;
  return true;
}

function normalizeForComparison(value) {
  if (!value) return '';
  let normalized = String(value).trim().replace(/\s+/g, '');
  normalized = normalized.replace(/[\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]/g, '');

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of HANGUL_SUFFIXES) {
      if (normalized.length <= suffix.length + 1) continue;
      if (normalized.endsWith(suffix)) {
        normalized = normalized.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }

  return normalized;
}

function dedupeKeywords(rawKeywords) {
  const deduped = [];
  const seen = new Set();

  for (const keyword of rawKeywords) {
    const trimmed = typeof keyword === 'string' ? keyword.trim() : '';
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
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
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
    existing.finance_keywords_en && typeof existing.finance_keywords_en === 'object'
      ? existing.finance_keywords_en
      : {};
  return { keywords, translations };
}

function extractKeywordsFromTags() {
  const tags = readJsonIfExists(TAGS_PATH);
  if (!tags) {
    console.log('ℹ️ data/tags.json not found or unreadable; no new keywords extracted.');
    return { keywords: [], translations: new Map() };
  }

  const collected = [];
  const translations = new Map();

  function registerTranslation(a, b) {
    const source = typeof a === 'string' ? a.trim() : '';
    const target = typeof b === 'string' ? b.trim() : '';
    if (!source || !target) return;
    if (containsHangul(source) && !containsHangul(target)) translations.set(source, target);
    else if (!containsHangul(source) && containsHangul(target)) translations.set(target, source);
  }

  function processTerm(term) {
    if (typeof term !== 'string') return;
    const cleaned = term.trim();
    if (!isLikelyKeyword(cleaned)) return;
    collected.push(cleaned);
  }

  function visit(node) {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node === 'object') {
      for (const key of ['term', 'term_ko', 'term_en', 'keyword', 'keyword_ko']) {
        if (typeof node[key] === 'string') processTerm(node[key]);
      }
      registerTranslation(node.term, node.term_ko);
      registerTranslation(node.term, node.term_en);
      for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value);
    }
  }

  visit(tags);
  const deduped = dedupeKeywords(collected);
  console.log(`🆕 Extracted ${deduped.length} keyword candidates from tags.json`);
  return { keywords: deduped, translations };
}

// 📰 Multi-site live scraping
async function fetchFromNewsSites() {
  const results = new Set();
  const sources = [
    'https://finance.naver.com/news/',
    'https://m.news.nate.com/section?mid=m02&sq=1138989',
    'https://news.daum.net/economic/',
    'https://m.mk.co.kr/news/economy/',
    'https://m.news.zum.com/home',
  ];

  for (const url of sources) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = await res.text();
      const $ = cheerio.load(html);
      $('a, strong, h2, h3').each((_, el) => {
        const text = $(el).text().trim();
        if (isLikelyKeyword(text)) results.add(text);
      });
      console.log(`✅ Parsed ${url} (${results.size} total so far)`);
      await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
    } catch (err) {
      console.warn(`⚠️ Failed to scrape ${url}:`, err.message);
    }
  }

  console.log(`🌐 Collected ${results.size} raw terms from finance news sites`);
  return Array.from(results);
}

function buildTranslationMap(existingTranslations, newTranslations, keywords) {
  const map = {};
  const keywordSet = new Set(keywords.map(k => normalizeForComparison(k)).filter(Boolean));

  const include = t => !!t && keywordSet.has(normalizeForComparison(t)) && isLikelyKeyword(t);

  if (existingTranslations) {
    for (const [k, v] of Object.entries(existingTranslations)) {
      if (include(k)) map[k] = v;
    }
  }
  if (newTranslations instanceof Map) {
    for (const [k, v] of newTranslations.entries()) {
      if (include(k)) map[k] = v;
    }
  }
  for (const k of keywords) if (!containsHangul(k) && include(k)) map[k] = map[k] || k;
  return map;
}

export async function generateFinanceKeywords() {
  const { keywords: existingKeywords, translations: existingTranslations } = loadExistingDictionary();
  const { keywords: derivedKeywords, translations: derivedTranslations } = extractKeywordsFromTags();
  const newsKeywords = await fetchFromNewsSites();

  const combinedKeywords = dedupeKeywords([
    ...existingKeywords,
    ...derivedKeywords,
    ...newsKeywords,
  ]);

  const finalTranslations = buildTranslationMap(existingTranslations, derivedTranslations, combinedKeywords);

  const payload = {
    finance_keywords: combinedKeywords,
    finance_keywords_en: finalTranslations,
  };

  fs.mkdirSync(path.dirname(FINANCE_KEYWORDS_PATH), { recursive: true });
  fs.writeFileSync(FINANCE_KEYWORDS_PATH, JSON.stringify(payload, null, 2), 'utf8');

  console.log(`💾 Saved ${combinedKeywords.length} total keywords to ${FINANCE_KEYWORDS_PATH}`);
  console.log(`🗺️ Translation map includes ${Object.keys(finalTranslations).length} entries`);
  return payload;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateFinanceKeywords();
}
