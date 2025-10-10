'use strict';

import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);

const fs = require('fs');
const path = require('path');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TAGS_PATH = path.resolve(__dirname, '../data/tags.json');
const FINANCE_KEYWORDS_PATH = path.resolve(__dirname, '../data/finance_keywords.json');

const HANGUL_SUFFIXES = [
  '으로써',
  '으로서',
  '이라면',
  '이라도',
  '이라고',
  '라고',
  '라고도',
  '라고는',
  '으로',
  '에서',
  '에게서',
  '에게',
  '한테',
  '처럼',
  '까지',
  '부터',
  '은',
  '는',
  '을',
  '를',
  '에',
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
  if (cleaned.includes('/') && !containsHangul(cleaned)) return false;
  if (!containsHangul(cleaned) && cleaned.includes('_')) return false;
  if (!containsHangul(cleaned) && cleaned.includes('-') && !cleaned.includes(' ')) return false;
  if (/\bUpdated\b/i.test(cleaned)) return false;
  if (/업데이트/.test(cleaned)) return false;
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
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`⚠️ Failed to read JSON at ${filePath}:`, err.message);
    return null;
  }
}

function loadExistingDictionary() {
  const existing = readJsonIfExists(FINANCE_KEYWORDS_PATH);
  if (!existing) {
    return { keywords: [], translations: {} };
  }

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

    if (containsHangul(source) && !containsHangul(target)) {
      translations.set(source, target);
    } else if (!containsHangul(source) && containsHangul(target)) {
      translations.set(target, source);
    } else if (!containsHangul(source) && !containsHangul(target)) {
      translations.set(source, target);
    }
  }

  function processTerm(term) {
    if (typeof term !== 'string') return;
    const cleaned = term.trim();
    if (!isLikelyKeyword(cleaned)) return;
    collected.push(cleaned);
  }

  function visit(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === 'object') {
      const term = typeof node.term === 'string' ? node.term.trim() : '';
      const termKo = typeof node.term_ko === 'string' ? node.term_ko.trim() : '';
      const termEn = typeof node.term_en === 'string' ? node.term_en.trim() : '';
      const keyword = typeof node.keyword === 'string' ? node.keyword.trim() : '';
      const keywordKo = typeof node.keyword_ko === 'string' ? node.keyword_ko.trim() : '';

      processTerm(term);
      processTerm(termKo);
      processTerm(termEn);
      processTerm(keyword);
      processTerm(keywordKo);

      registerTranslation(term, termKo);
      registerTranslation(term, termEn);
      registerTranslation(termKo, termEn);
      registerTranslation(keyword, keywordKo);

      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') {
          visit(value);
        }
      }
    }
  }

  visit(tags);

  const deduped = dedupeKeywords(collected);
  console.log(`🆕 Extracted ${deduped.length} unique keyword candidates from tags.json`);
  return { keywords: deduped, translations };
}

function buildTranslationMap(existingTranslations, newTranslations, keywords) {
  const map = {};
  const keywordSet = new Set(keywords.map((kw) => normalizeForComparison(kw)).filter(Boolean));

  function shouldInclude(term) {
    if (!term) return false;
    const normalized = normalizeForComparison(term);
    if (!normalized || !keywordSet.has(normalized)) return false;
    return isLikelyKeyword(term);
  }

  if (existingTranslations && typeof existingTranslations === 'object') {
    for (const [key, value] of Object.entries(existingTranslations)) {
      if (typeof value !== 'string') continue;
      if (!shouldInclude(key)) continue;
      map[key] = value;
    }
  }

  if (newTranslations instanceof Map) {
    for (const [key, value] of newTranslations.entries()) {
      if (typeof value !== 'string') continue;
      if (!shouldInclude(key)) continue;
      map[key] = value;
    }
  }

  for (const keyword of keywords) {
    if (!keyword) continue;
    if (containsHangul(keyword)) continue;
    if (!shouldInclude(keyword)) continue;
    if (!map[keyword]) {
      map[keyword] = keyword;
    }
  }

  return map;
}

function generateFinanceKeywords() {
  const { keywords: existingKeywords, translations: existingTranslations } = loadExistingDictionary();
  const { keywords: derivedKeywords, translations: derivedTranslations } = extractKeywordsFromTags();

  const combinedKeywords = dedupeKeywords([...existingKeywords, ...derivedKeywords]);
  const finalTranslations = buildTranslationMap(existingTranslations, derivedTranslations, combinedKeywords);

  const payload = {
    finance_keywords: combinedKeywords,
    finance_keywords_en: finalTranslations,
  };

  fs.writeFileSync(FINANCE_KEYWORDS_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`💾 Wrote ${combinedKeywords.length} keywords to data/finance_keywords.json`);
  console.log(`🗺  Translation map now covers ${Object.keys(finalTranslations).length} terms`);

  return payload;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateFinanceKeywords();
}

const api = {
  generateFinanceKeywords,
  dedupeKeywords,
  normalizeForComparison,
  containsHangul,
};

export default api;
export { generateFinanceKeywords, dedupeKeywords, normalizeForComparison, containsHangul };

if (typeof module !== 'undefined') {
  module.exports = api;
}
