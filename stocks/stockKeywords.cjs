#!/usr/bin/env node
'use strict';

/**
 * stockKeywords.cjs — Naver search driven keyword scorer
 *
 * This script samples Korean finance/business keywords from data/finance_keywords.json,
 * evaluates their current relevance with the Naver Search Open API, and writes
 * the aggregated scores to data/tags.json so that the stocks.html page can
 * surface the top phrases for the day.
 */

const fs = require('fs');
const path = require('path');

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || process.env.DEEPL_AUTH_KEY;
const DEEPL_API_URL = process.env.DEEPL_API_URL || 'https://api-free.deepl.com/v2/translate';

const OUTPUT_PATH = path.resolve(__dirname, '../data/tags.json');
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

const fallbackMaps = {
  EN: new Map(),
  KO: new Map(),
};

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

function buildFallbackMap(source) {
  for (const map of Object.values(fallbackMaps)) {
    map.clear();
  }
  if (!source || typeof source !== 'object') return;

  const entries = Object.entries(source);
  console.log(`📚 Loading ${entries.length} pre-translated terms from finance_keywords_en`);

  for (const [koTerm, enTerm] of entries) {
    registerFallback(koTerm, enTerm, 'EN');
    registerFallback(enTerm, koTerm, 'KO');
  }

  const totalMappings = Object.values(fallbackMaps).reduce((sum, map) => sum + map.size, 0);
  console.log(`✅ Loaded ${totalMappings} translation mappings across languages`);
}

function registerFallback(sourceTerm, translatedTerm, targetLang) {
  const normalized = normalizeForComparison(sourceTerm);
  const cleanTranslation = String(translatedTerm || '').trim();
  const map = fallbackMaps[targetLang];
  if (!normalized || !cleanTranslation || !map) {
    return;
  }

  map.set(sourceTerm, cleanTranslation);
  map.set(normalized, cleanTranslation);
}

function dedupeKeywords(rawKeywords) {
  const deduped = [];
  const seen = [];

  for (const keyword of rawKeywords) {
    const trimmed = String(keyword || '').trim();
    if (!trimmed) continue;

    const normalized = normalizeForComparison(trimmed);
    if (!normalized) continue;

    let similar = false;
    for (const existing of seen) {
      if (existing === normalized) {
        similar = true;
        break;
      }
      if (existing.includes(normalized) || normalized.includes(existing)) {
        const lengthDiff = Math.abs(existing.length - normalized.length);
        if (lengthDiff <= 2) {
          similar = true;
          break;
        }
      }
    }

    if (similar) continue;

    seen.push(normalized);
    deduped.push(trimmed);
  }

  return deduped;
}

function containsHangul(value) {
  return /[가-힣]/.test(String(value || ''));
}

const SAMPLE_SIZE = 30;
const NAVER_NEWS_ENDPOINT = 'https://openapi.naver.com/v1/search/news.json';
const REQUEST_DELAY_MS = 180;
const WINDOW_LABEL = '12_hours';

if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
  console.error('❌ NAVER_CLIENT_ID and NAVER_CLIENT_SECRET environment variables are required.');
  console.error('   Please obtain credentials from https://developers.naver.com and set them before running this script.');
  process.exit(1);
}

if (!DEEPL_API_KEY) {
  console.error('❌ DEEPL_API_KEY (or DEEPL_AUTH_KEY) environment variable is required for DeepL translation.');
  console.error('   Please provide a valid DeepL API key to generate translated terms.');
  process.exit(1);
}

function loadFinanceKeywords() {
  const raw = JSON.parse(fs.readFileSync(FINANCE_KEYWORDS_PATH, 'utf8'));
  const keywords = Array.isArray(raw.finance_keywords) ? raw.finance_keywords : [];

  console.log(`📥 Loaded ${keywords.length} keywords from file`);

  const cleaned = keywords
    .map((kw) => (typeof kw === 'string' ? kw.trim() : ''))
    .filter((kw) => kw.length > 0);

  const koreanCount = cleaned.filter((kw) => containsHangul(kw)).length;
  const nonKoreanCount = cleaned.length - koreanCount;

  console.log(
    `🧹 After trimming invalid entries: ${cleaned.length} keywords (KO: ${koreanCount}, EN/Other: ${nonKoreanCount})`,
  );

  const deduped = dedupeKeywords(cleaned);
  console.log(`🔄 After deduplication: ${deduped.length} keywords`);

  // Build fallback map BEFORE returning
  buildFallbackMap(raw.finance_keywords_en);
  return deduped;
}

function shuffleSample(list, size) {
  const pool = [...list];
  
  // Fisher-Yates shuffle with enhanced randomness
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  
  const sampled = pool.slice(0, Math.min(size, pool.length));
  
  console.log(`🔀 Shuffled ${pool.length} keywords, selected first ${sampled.length}`);
  console.log(`   First 5 from shuffled pool: ${sampled.slice(0, 5).join(', ')}`);
  console.log(`   Last 5 from shuffled pool: ${sampled.slice(-5).join(', ')}`);
  
  return sampled;
}

function cleanSnippet(value) {
  if (!value) return '';
  return String(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSearchLinks(keyword) {
  const query = encodeURIComponent(keyword);
  return {
    news: `https://search.naver.com/search.naver?where=news&query=${query}`,
    blog: `https://search.naver.com/search.naver?where=blog&query=${query}`,
    cafe: `https://search.naver.com/search.naver?where=post&query=${query}`,
  };
}

async function evaluateKeyword(keyword) {
  const url = `${NAVER_NEWS_ENDPOINT}?query=${encodeURIComponent(keyword)}&display=20&sort=date`;
  const headers = {
    'X-Naver-Client-Id': NAVER_CLIENT_ID,
    'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
  };

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`NAVER API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const total = Number(data.total) || 0;
  const items = Array.isArray(data.items) ? data.items : [];
  const now = Date.now();
  const recencyScore = items.reduce((sum, item) => {
    const timestamp = Date.parse(item.pubDate || '');
    if (!Number.isFinite(timestamp)) return sum;
    const hoursAgo = (now - timestamp) / (1000 * 60 * 60);
    const weight = Math.max(0, 72 - hoursAgo);
    return sum + weight;
  }, 0);
  const displayCount = Number(data.display) || items.length;
  const score = Math.round(total * 0.6 + items.length * 10 + recencyScore);

  const topHeadlines = items.slice(0, 3).map((item) => ({
    title: cleanSnippet(item.title),
    summary: cleanSnippet(item.description),
    link: item.originallink || item.link || '',
    pubDate: item.pubDate || null,
  }));

  console.log(
    `🔎 ${keyword.padEnd(16, ' ')} → score ${String(score).padStart(5)} (total ${String(total).padStart(4)}, recent ${String(items.length).padStart(2)})`
  );

  return {
    term: keyword,
    term_ko: keyword,
    significance_score: score,
    mentions: total,
    evaluation: {
      source: 'naver_search_news',
      query: keyword,
      total_results: total,
      returned_results: items.length,
      display_count: displayCount,
      recency_weight: Number(recencyScore.toFixed(2)),
      last_build_date: data.lastBuildDate || null,
    },
    search: buildSearchLinks(keyword),
    top_headlines: topHeadlines,
  };
}

const translationCache = new Map();

async function translateText(text, { targetLang, sourceLang } = {}) {
  const normalized = (text || '').trim();
  if (!normalized) {
    return { text: '', method: 'failed' };
  }

  const cacheKey = `${targetLang || 'UNK'}::${normalized}`;
  if (translationCache.has(cacheKey)) {
    const cached = translationCache.get(cacheKey);
    console.log(
      `   💾 Using cached (${sourceLang || 'auto'}→${targetLang || 'auto'}): "${normalized}" → "${cached}"`,
    );
    return { text: cached, method: 'cached' };
  }

  const normalizedKey = normalizeForComparison(normalized);
  const fallbackMap = targetLang ? fallbackMaps[targetLang] : undefined;
  const fallbackTranslation = fallbackMap && (fallbackMap.get(normalized) || fallbackMap.get(normalizedKey));

  if (fallbackTranslation && fallbackTranslation !== normalized) {
    console.log(
      `   📖 Using pre-translated (${sourceLang || 'auto'}→${targetLang}): "${normalized}" → "${fallbackTranslation}"`,
    );
    translationCache.set(cacheKey, fallbackTranslation);
    return { text: fallbackTranslation, method: 'preTranslated' };
  }

  console.log(`   🌐 Calling DeepL API (${sourceLang || 'auto'}→${targetLang}) for: "${normalized}"`);
  const params = new URLSearchParams();
  params.append('auth_key', DEEPL_API_KEY);
  params.append('text', normalized);
  if (targetLang) params.append('target_lang', targetLang);
  if (sourceLang) params.append('source_lang', sourceLang);

  try {
    const res = await fetch(DEEPL_API_URL, {
      method: 'POST',
      body: params,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`DeepL error ${res.status}: ${errText}`);
    }
    const data = await res.json();
    const translation =
      (Array.isArray(data.translations) && data.translations[0] && data.translations[0].text) || '';
    const translated = translation.trim();
    const finalTranslation = translated || normalized;

    translationCache.set(cacheKey, finalTranslation);
    if (targetLang) {
      registerFallback(normalized, finalTranslation, targetLang);
    }
    if (sourceLang && finalTranslation !== normalized) {
      registerFallback(finalTranslation, normalized, sourceLang);
    }

    console.log(
      `   ✅ DeepL translated (${sourceLang || 'auto'}→${targetLang || 'auto'}): "${normalized}" → "${finalTranslation}"`,
    );
    return { text: finalTranslation, method: 'deepl' };
  } catch (err) {
    console.warn(`⚠️  Failed to translate "${normalized}": ${err.message}`);
    translationCache.set(cacheKey, normalized);
    return { text: normalized, method: 'failed' };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildTags() {
  console.log('🚀 Generating data/tags.json from finance_keywords.json');
  console.log(`🕐 Execution time: ${new Date().toISOString()}`);
  console.log(`🎲 Random seed check: ${Math.random()}`);
  
  const keywords = loadFinanceKeywords();
  if (!keywords.length) {
    throw new Error('finance_keywords.json does not contain any usable keywords.');
  }

  console.log(`📊 Total keywords available: ${keywords.length}`);
  console.log(`   First 10: ${keywords.slice(0, 10).join(', ')}`);
  console.log(`   Middle 10 (around #${Math.floor(keywords.length/2)}): ${keywords.slice(Math.floor(keywords.length/2), Math.floor(keywords.length/2) + 10).join(', ')}`);
  console.log(`   Last 10: ${keywords.slice(-10).join(', ')}`);

  const sampled = shuffleSample(keywords, SAMPLE_SIZE);
  console.log(`🎯 Selected ${sampled.length} random finance keywords for evaluation.`);

  const evaluated = [];
  const translationStats = {
    cached: 0,
    preTranslated: 0,
    deepl: 0,
    failed: 0,
  };

  for (const keyword of sampled) {
    let result;
    try {
      result = await evaluateKeyword(keyword);
    } catch (err) {
      console.warn(`⚠️  Failed to evaluate "${keyword}": ${err.message}`);
      result = {
        term: keyword,
        term_ko: keyword,
        significance_score: 0,
        mentions: 0,
        evaluation: {
          source: 'naver_search_news',
          query: keyword,
          error: err.message,
        },
        search: buildSearchLinks(keyword),
        top_headlines: [],
      };
    }

    const keywordIsKorean = containsHangul(keyword);

    if (keywordIsKorean) {
      result.term_ko = keyword;
      const { text: translatedTerm, method } = await translateText(keyword, {
        sourceLang: 'KO',
        targetLang: 'EN',
      });
      if (translationStats[method] === undefined) {
        translationStats[method] = 0;
      }
      translationStats[method] += 1;
      result.term = translatedTerm;
    } else {
      result.term = keyword;
      const { text: translatedTerm, method } = await translateText(keyword, {
        sourceLang: 'EN',
        targetLang: 'KO',
      });
      if (translationStats[method] === undefined) {
        translationStats[method] = 0;
      }
      translationStats[method] += 1;
      result.term_ko = translatedTerm;
    }

    evaluated.push(result);
    await delay(REQUEST_DELAY_MS + Math.floor(Math.random() * 120));
  }

  console.log('\n📊 Translation Statistics:');
  console.log(`   💾 Cached: ${translationStats.cached}`);
  console.log(`   📖 Pre-translated: ${translationStats.preTranslated}`);
  console.log(`   🌐 DeepL API calls: ${translationStats.deepl}`);
  console.log(`   ⚠️  Failed: ${translationStats.failed}`);

  // Sort by significance score (highest first) - THIS is why it looks "alphabetic"
  // The original random order is being overwritten here!
  evaluated.sort((a, b) => b.significance_score - a.significance_score);

  const now = new Date();
  const result = {
    date: now.toISOString().split('T')[0],
    window: WINDOW_LABEL,
    total_phrases: evaluated.length,
    discovered_keywords: evaluated,
    metadata: {
      collection_method: 'naver_search_random_sample',
      sample_size: SAMPLE_SIZE,
      generated_at: now.toISOString(),
      keyword_limit: SAMPLE_SIZE,
      lookback_hours: 12,
      keyword_source: path.relative(process.cwd(), FINANCE_KEYWORDS_PATH),
    },
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(`✅ Saved ${evaluated.length} keywords to ${OUTPUT_PATH}`);
}

if (require.main === module) {
  buildTags().catch((err) => {
    console.error('❌ Generation failed:', err);
    process.exitCode = 1;
  });
}

module.exports = { buildTags };
