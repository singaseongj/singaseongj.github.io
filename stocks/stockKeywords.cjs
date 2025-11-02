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
const LLM_WORKER_URL =
  process.env.LLM_WORKER_URL || 'https://tight-cloud-0f5e.seongj1589.workers.dev/api/generate';
const LLM_MODEL = process.env.LLM_MODEL || 'tinyllama';
const LLM_REQUEST_TIMEOUT_MS = Number(process.env.LLM_REQUEST_TIMEOUT_MS) || 30000;

const CEREBRAS_API_URL =
  process.env.CEREBRAS_API_URL || 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY;
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || 'llama3.1-8b';
const CEREBRAS_REQUEST_TIMEOUT_MS =
  Number(process.env.CEREBRAS_REQUEST_TIMEOUT_MS) || 20000;
const CEREBRAS_MAX_TOKENS = Number(process.env.CEREBRAS_MAX_TOKENS) || 400;
const CEREBRAS_TEMPERATURE =
  process.env.CEREBRAS_TEMPERATURE !== undefined
    ? Number(process.env.CEREBRAS_TEMPERATURE)
    : 0.7;
const CEREBRAS_TOP_P =
  process.env.CEREBRAS_TOP_P !== undefined ? Number(process.env.CEREBRAS_TOP_P) : 0.85;

const SAMPLE_SIZE = 30;
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

function sanitizeKeywordList(keywords) {
  if (!Array.isArray(keywords)) return [];

  const cleaned = keywords
    .map((kw) => (typeof kw === 'string' ? kw.trim() : ''))
    .filter((kw) => kw.length > 0)
    .filter((kw) => kw.split(/\s+/).filter(Boolean).length <= 5);

  return dedupeKeywords(cleaned);
}

function extractKeywordsFromLLMResponse(rawText) {
  if (!rawText) return [];

  const trimmed = String(rawText).trim();
  if (!trimmed) return [];

  const candidates = [];
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    candidates.push(fencedMatch[1].trim());
  }
  candidates.push(trimmed);

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      if (parsed && Array.isArray(parsed.keywords)) {
        return parsed.keywords;
      }
      if (parsed && Array.isArray(parsed.items)) {
        return parsed.items;
      }
    } catch (err) {
      // Continue trying other parsing strategies.
    }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s\u2022*\-]*\d{0,2}[.)]?\s*/u, '').trim())
    .filter((line) => line.length > 0);

  if (lines.length === 1 && /[,;]/.test(lines[0])) {
    return lines[0]
      .split(/[,;]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  return lines;
}

function buildKeywordPrompt(desiredCount) {
  return `Output ONLY a valid JSON array of ${desiredCount} Latest trending search keywords (each <6 words). No code fences, no numbering, no extra text.`;
}


async function fetchCerebrasKeywords({ desiredCount = SAMPLE_SIZE, prompt } = {}) {
  if (!CEREBRAS_API_KEY) {
    console.warn('⚠️  CEREBRAS_API_KEY is not configured. Skipping Cerebras keyword generation.');
    return [];
  }

  const requestPrompt = prompt || buildKeywordPrompt(desiredCount);
  console.log('🤖 Requesting financial keywords from Cerebras…');

  const payload = {
    model: CEREBRAS_MODEL,
    messages: [
      { role: 'system', content: 'You are a helpful assistant that only returns valid JSON.' },
      { role: 'user', content: requestPrompt },
    ],
    max_completion_tokens: CEREBRAS_MAX_TOKENS,
    temperature: CEREBRAS_TEMPERATURE,
    top_p: CEREBRAS_TOP_P,
    stream: false,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CEREBRAS_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(CEREBRAS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CEREBRAS_API_KEY}`,
        'User-Agent': 'stocks-keywords-script',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const result = await response.json();
    const choice = Array.isArray(result.choices) ? result.choices[0] : undefined;
    const llmText = String(
      choice?.message?.content ||
        choice?.delta?.content ||
        result.response ||
        result.message?.content ||
        ''
    ).trim();

    if (!llmText) {
      throw new Error('Empty response from Cerebras.');
    }

    const extracted = extractKeywordsFromLLMResponse(llmText);
    const sanitized = sanitizeKeywordList(extracted).slice(0, desiredCount);

    if (!sanitized.length) {
      throw new Error('No keywords could be parsed from Cerebras response.');
    }

    console.log(`🤖 Cerebras provided ${sanitized.length} keyword candidates.`);
    return sanitized;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`⚠️  Cerebras request timed out after ${CEREBRAS_REQUEST_TIMEOUT_MS}ms.`);
    } else {
      console.warn(`⚠️  Failed to retrieve keywords from Cerebras: ${err.message}`);
    }
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchLLMKeywords({ desiredCount = SAMPLE_SIZE } = {}) {
  const prompt = buildKeywordPrompt(desiredCount);

  const cerebrasKeywords = await fetchCerebrasKeywords({ desiredCount, prompt });
  if (cerebrasKeywords.length) {
    return cerebrasKeywords;
  }

  if (!LLM_WORKER_URL) {
    console.warn('⚠️  LLM worker URL is not configured. Skipping fallback keyword generation.');
    return [];
  }

  console.log('🤖 Cerebras unavailable — falling back to tinyllama worker…');

  const payload = {
    model: LLM_MODEL,
    prompt,
    stream: false,
    history: [],
    messages: [{ role: 'user', content: prompt }],
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(LLM_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const result = await response.json();
    const llmText = String(result.response || result.message?.content || '').trim();

    if (!llmText) {
      throw new Error('Empty response from LLM worker.');
    }

    const extracted = extractKeywordsFromLLMResponse(llmText);
    const sanitized = sanitizeKeywordList(extracted).slice(0, desiredCount);

    if (!sanitized.length) {
      throw new Error('No keywords could be parsed from LLM response.');
    }

    console.log(`🤖 tinyllama provided ${sanitized.length} keyword candidates.`);
    return sanitized;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`⚠️  LLM request timed out after ${LLM_REQUEST_TIMEOUT_MS}ms.`);
    } else {
      console.warn(`⚠️  Failed to retrieve keywords from LLM worker: ${err.message}`);
    }
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

function commonPrefixLength(a, b) {
  const minLength = Math.min(a.length, b.length);
  let idx = 0;
  while (idx < minLength && a[idx] === b[idx]) {
    idx += 1;
  }
  return idx;
}

function levenshteinDistance(a, b) {
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0) return lenB;
  if (lenB === 0) return lenA;

  const dp = Array.from({ length: lenA + 1 }, () => new Array(lenB + 1).fill(0));
  for (let i = 0; i <= lenA; i += 1) dp[i][0] = i;
  for (let j = 0; j <= lenB; j += 1) dp[0][j] = j;

  for (let i = 1; i <= lenA; i += 1) {
    for (let j = 1; j <= lenB; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[lenA][lenB];
}

function areStringsSimilar(a, b) {
  const normA = normalizeForComparison(a);
  const normB = normalizeForComparison(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  if (normA.includes(normB) || normB.includes(normA)) {
    return true;
  }

  const prefix = commonPrefixLength(normA, normB);
  const minLength = Math.min(normA.length, normB.length);
  if (minLength <= 2) {
    return false;
  }

  if (prefix >= minLength - 1) {
    return true;
  }

  const distance = levenshteinDistance(normA, normB);
  const threshold = Math.max(1, Math.floor(minLength * 0.4));
  if (prefix >= 2 && distance <= threshold) {
    return true;
  }

  return false;
}

function areResultsSimilar(a, b) {
  if (!a || !b) return false;
  const primaryA = containsHangul(a.term_ko) ? a.term_ko : a.term;
  const primaryB = containsHangul(b.term_ko) ? b.term_ko : b.term;

  if (areStringsSimilar(primaryA, primaryB)) {
    return true;
  }

  if (a.term && b.term && !containsHangul(a.term) && !containsHangul(b.term)) {
    if (areStringsSimilar(a.term, b.term)) {
      return true;
    }
  }

  if (a.term_ko && b.term_ko) {
    if (areStringsSimilar(a.term_ko, b.term_ko)) {
      return true;
    }
  }

  return false;
}

function containsHangul(value) {
  return /[가-힣]/.test(String(value || ''));
}

function ensureLanguagePlacement(result, originalKeyword) {
  if (!result || typeof result !== 'object') return;

  const termHasHangul = containsHangul(result.term);
  const termKoHasHangul = containsHangul(result.term_ko);
  const originalIsKorean = containsHangul(originalKeyword);

  if (termHasHangul && !termKoHasHangul) {
    console.warn(
      `   🔁 Swapping term fields for "${originalKeyword}" to keep Korean in term_ko and English in term.`,
    );
    const originalTerm = result.term;
    result.term = result.term_ko;
    result.term_ko = originalTerm;
    return;
  }

  if (!termKoHasHangul) {
    if (originalIsKorean) {
      if (termHasHangul) {
        console.warn(`   ⚠️ Unable to translate Korean keyword "${originalKeyword}" into English.`);
        result.term = '';
      }
    } else if (result.term_ko) {
      console.warn(`   ⚠️ Unable to translate English keyword "${originalKeyword}" into Korean.`);
      result.term_ko = '';
    }
  }
}

const NAVER_NEWS_ENDPOINT = 'https://openapi.naver.com/v1/search/news.json';
const NAVER_DATALAB_ENDPOINT = 'https://openapi.naver.com/v1/datalab/search';
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

function formatDateForDatalab(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDatalabPeriod(period) {
  if (!period || typeof period !== 'string') return NaN;
  // Period strings are delivered as "YYYY-MM-DD" or "YYYY-MM-DD HH:00:00" when using timeUnit=hour
  const normalized = period.includes(' ') ? period.replace(' ', 'T') : `${period}T00:00:00`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function buildDatalabPayload(keyword, timeUnit) {
  const now = new Date();
  const endDate = new Date(now.getTime());
  const startDate = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);

  return {
    startDate: formatDateForDatalab(startDate),
    endDate: formatDateForDatalab(endDate),
    timeUnit,
    keywordGroups: [
      {
        groupName: keyword,
        keywords: [keyword],
      },
    ],
  };
}

async function requestDatalabTrend(keyword, timeUnit) {
  const payload = buildDatalabPayload(keyword, timeUnit);

  const res = await fetch(NAVER_DATALAB_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Naver-Client-Id': NAVER_CLIENT_ID,
      'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`NAVER DataLab error ${res.status}: ${text}`);
  }

  const json = await res.json();
  const rows = json?.results?.[0]?.data;
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map((row) => {
      const timestamp = parseDatalabPeriod(row.period);
      const ratio = Number(row.ratio);
      return {
        period: row.period,
        timestamp,
        value: Number.isFinite(ratio) ? ratio : 0,
      };
    })
    .filter((row) => Number.isFinite(row.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function isTimeUnitError(error) {
  if (!error) return false;
  const message = String(error.message || error || '').toLowerCase();
  if (!message) return false;
  return (
    message.includes('.timeunit') ||
    message.includes('"timeunit"') ||
    message.includes('should be equal to one of the allowed values')
  );
}

async function fetchSearchTrendData(keyword) {
  const attemptedTimeUnits = ['hour', 'date'];

  for (const timeUnit of attemptedTimeUnits) {
    try {
      const rows = await requestDatalabTrend(keyword, timeUnit);
      return { rows, timeUnit };
    } catch (err) {
      const isLastAttempt = timeUnit === attemptedTimeUnits[attemptedTimeUnits.length - 1];
      if (isLastAttempt) {
        throw err;
      }

      if (!isTimeUnitError(err)) {
        throw err;
      }

      console.warn(
        `   ⚠️ NAVER DataLab rejected timeUnit="${timeUnit}" for "${keyword}" — retrying with coarser granularity`
      );
    }
  }

  return { rows: [], timeUnit: null };
}

function computeTimeCorrection(timestamp) {
  const reference = Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
  const hour = reference.getHours();
  const day = reference.getDay();

  const circadian = Math.cos(((hour + 1) / 24) * Math.PI * 2) * 0.12;
  const weekendAdjustment = day === 0 || day === 6 ? 0.05 : 0;

  return Number((circadian + weekendAdjustment).toFixed(6));
}

function determineTimeResolution(metadata = {}) {
  const normalized = String(metadata?.timeUnit || '').trim().toLowerCase();
  if (normalized === 'hour' || normalized === 'date' || normalized === 'day' || normalized === 'week' || normalized === 'month') {
    return normalized === 'day' ? 'date' : normalized;
  }
  return null;
}

function calculateMedian(values) {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function inferTimeUnitFromData(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const deltas = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const curr = rows[i];
    if (!Number.isFinite(prev.timestamp) || !Number.isFinite(curr.timestamp)) continue;
    const delta = curr.timestamp - prev.timestamp;
    if (Number.isFinite(delta) && delta > 0) {
      deltas.push(delta);
    }
  }
  const medianDelta = calculateMedian(deltas);
  if (!Number.isFinite(medianDelta)) return null;

  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  const WEEK_MS = 7 * DAY_MS;

  if (medianDelta <= 2 * HOUR_MS) return 'hour';
  if (medianDelta <= 2 * DAY_MS) return 'date';
  if (medianDelta <= 2 * WEEK_MS) return 'week';
  return 'month';
}

function resolveBucketSize(rows, metadata = {}) {
  const declaredUnit = determineTimeResolution(metadata);
  const inferredUnit = inferTimeUnitFromData(rows);
  const effectiveUnit = declaredUnit || inferredUnit || 'hour';

  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  const WEEK_MS = 7 * DAY_MS;

  switch (effectiveUnit) {
    case 'hour':
      return { bucketMs: HOUR_MS, effectiveUnit };
    case 'date':
      return { bucketMs: DAY_MS, effectiveUnit };
    case 'week':
      return { bucketMs: WEEK_MS, effectiveUnit };
    case 'month':
      return { bucketMs: 30 * DAY_MS, effectiveUnit };
    default:
      return { bucketMs: HOUR_MS, effectiveUnit: 'hour' };
  }
}

function computeSearchScoreComponents(dataRows, options = {}) {
  const rows = Array.isArray(dataRows) ? dataRows : [];
  if (rows.length === 0) {
    return null;
  }

  const { bucketMs, effectiveUnit } = resolveBucketSize(rows, { timeUnit: options.timeUnit });
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;
  const WEEK_MS = 7 * DAY_MS;

  const shortWindowMs = bucketMs;
  const mediumWindowMs = Math.max(bucketMs * 3, effectiveUnit === 'hour' ? DAY_MS : bucketMs * 2);
  const longWindowMs = Math.max(bucketMs * 7, WEEK_MS);

  let lastTimestamp = null;
  let shortWindowVolume = 0;
  let mediumWindowVolume = 0;
  let longWindowVolume = 0;
  let longWindowDataPoints = 0;

  for (const entry of rows) {
    const { timestamp, value } = entry;
    if (!Number.isFinite(timestamp)) continue;
    if (!Number.isFinite(value)) continue;

    if (!lastTimestamp || timestamp > lastTimestamp) {
      lastTimestamp = timestamp;
    }

    const delta = now - timestamp;
    if (delta <= shortWindowMs) {
      shortWindowVolume += value;
    }
    if (delta <= mediumWindowMs) {
      mediumWindowVolume += value;
    }
    if (delta <= longWindowMs) {
      longWindowVolume += value;
      longWindowDataPoints += 1;
    }
  }

  if (!Number.isFinite(lastTimestamp)) {
    return null;
  }

  const weeklyAverageVolume =
    longWindowDataPoints > 0 ? longWindowVolume / longWindowDataPoints : 0;
  const safeShortWindow = shortWindowVolume || 0;
  const safeMediumWindow = mediumWindowVolume > 0 ? mediumWindowVolume : 1;
  const safeWeekAvg = weeklyAverageVolume > 0 ? weeklyAverageVolume : 1;

  const dayScore = safeShortWindow / safeMediumWindow;
  const weekScore = safeShortWindow / safeWeekAvg;
  const correctionFactor = computeTimeCorrection(lastTimestamp);
  const weeklySearchVolume = longWindowVolume;
  const decayFactor =
    weeklySearchVolume > 0 ? Math.pow(2, -Math.log(Math.max(weeklySearchVolume, 1))) : 1;

  const minimumHours = Math.max(bucketMs / HOUR_MS, 1 / 60);
  const hoursSinceLast = Math.max((now - lastTimestamp) / HOUR_MS, minimumHours);
  const timeWeight = 1 / hoursSinceLast;

  const rawScore = (dayScore * weekScore - correctionFactor) * decayFactor * timeWeight;
  const clampedRawScore = Number.isFinite(rawScore) ? rawScore : 0;
  const adjustedScore = Math.max(0, clampedRawScore);
  const scaledScore = adjustedScore * 1000;

  const recentWindowVolume = Number(safeShortWindow.toFixed(4));
  const mediumWindowTotal = Number(mediumWindowVolume.toFixed(4));
  const longWindowTotal = Number(longWindowVolume.toFixed(4));
  const weekAverageRounded = Number(weeklyAverageVolume.toFixed(4));

  return {
    timeUnit: effectiveUnit,
    bucketSizeHours: Number((bucketMs / HOUR_MS).toFixed(2)),
    shortWindowHours: Number((shortWindowMs / HOUR_MS).toFixed(2)),
    mediumWindowHours: Number((mediumWindowMs / HOUR_MS).toFixed(2)),
    longWindowHours: Number((longWindowMs / HOUR_MS).toFixed(2)),
    recentWindowVolume,
    comparisonWindowVolume: mediumWindowTotal,
    weeklySearchVolume: longWindowTotal,
    weeklyAverageVolume: weekAverageRounded,
    dayScore: Number(dayScore.toFixed(6)),
    weekScore: Number(weekScore.toFixed(6)),
    correctionFactor,
    decayFactor: Number(decayFactor.toFixed(6)),
    timeWeight: Number(timeWeight.toFixed(6)),
    lastTimestamp,
    rawScore: Number(clampedRawScore.toFixed(6)),
    scaledScore: Number(scaledScore.toFixed(2)),
    totalScore: Math.round(scaledScore),
    // Backwards compatible field names for existing downstream usage.
    recentHourVolume: recentWindowVolume,
    past24hVolume: mediumWindowTotal,
  };
}

async function evaluateKeyword(keyword) {
  let datalabRows = [];
  let datalabScores = null;
  let datalabTimeUnit = null;
  try {
    const datalabResult = await fetchSearchTrendData(keyword);
    datalabRows = datalabResult.rows;
    datalabTimeUnit = datalabResult.timeUnit || null;
    datalabScores = computeSearchScoreComponents(datalabRows, {
      timeUnit: datalabResult.timeUnit,
    });
  } catch (err) {
    console.warn(`   ⚠️ Failed to fetch DataLab stats for "${keyword}":`, err.message || err);
  }

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

  const fallbackScore = Math.round(total * 0.6 + items.length * 10 + recencyScore);
  const finalScore = datalabScores?.totalScore ?? fallbackScore;

  const topHeadlines = items.slice(0, 3).map((item) => ({
    title: cleanSnippet(item.title),
    summary: cleanSnippet(item.description),
    link: item.originallink || item.link || '',
    pubDate: item.pubDate || null,
  }));

  console.log(
    `🔎 ${keyword.padEnd(16, ' ')} → score ${String(finalScore).padStart(5)} (DataLab ${datalabScores?.totalScore ?? 'n/a'}, fallback ${fallbackScore})`
  );

  const mentions = Number.isFinite(datalabScores?.weeklySearchVolume)
    ? Math.round(datalabScores.weeklySearchVolume)
    : total;

  const evaluation = {
    source: 'naver_search_news',
    query: keyword,
    total_results: total,
    returned_results: items.length,
    display_count: displayCount,
    recency_weight: Number(recencyScore.toFixed(2)),
    last_build_date: data.lastBuildDate || null,
  };

  if (datalabScores) {
    const rowsToInclude = Math.min(
      datalabRows.length,
      datalabTimeUnit === 'hour' ? 24 : datalabRows.length
    );
    evaluation.search_trends = {
      source: 'naver_datalab_search',
      time_unit: datalabTimeUnit || datalabScores.timeUnit || 'unknown',
      bucket_size_hours: datalabScores.bucketSizeHours,
      rows: datalabRows.slice(-rowsToInclude),
    };
  }

  const result = {
    term: keyword,
    term_ko: keyword,
    significance_score: finalScore,
    mentions,
    evaluation,
    search: buildSearchLinks(keyword),
    top_headlines: topHeadlines,
  };

  if (datalabScores) {
    result.search_scores = {
      time_unit: datalabScores.timeUnit,
      bucket_size_hours: datalabScores.bucketSizeHours,
      short_window_hours: datalabScores.shortWindowHours,
      medium_window_hours: datalabScores.mediumWindowHours,
      long_window_hours: datalabScores.longWindowHours,
      recent_hour_volume: datalabScores.recentHourVolume,
      past_24h_volume: datalabScores.past24hVolume,
      weekly_search_volume: datalabScores.weeklySearchVolume,
      weekly_average_volume: datalabScores.weeklyAverageVolume,
      day_score: datalabScores.dayScore,
      week_score: datalabScores.weekScore,
      correction_factor: datalabScores.correctionFactor,
      decay_factor: datalabScores.decayFactor,
      time_weight: datalabScores.timeWeight,
      raw_score: datalabScores.rawScore,
      scaled_score: datalabScores.scaledScore,
      total_score: datalabScores.totalScore,
      last_observation: datalabScores.lastTimestamp,
    };
  }

  return result;
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

  let sampled = sanitizeKeywordList(await fetchLLMKeywords({ desiredCount: SAMPLE_SIZE }));
  let keywordCollectionMethod = 'naver_search_llm_seeded';

  if (!sampled.length) {
    const fallbackKeywordPool = loadFinanceKeywords();
    if (!fallbackKeywordPool.length) {
      throw new Error('finance_keywords.json does not contain any usable keywords.');
    }

    console.log(`📊 Total keywords available: ${fallbackKeywordPool.length}`);
    console.log(`   First 10: ${fallbackKeywordPool.slice(0, 10).join(', ')}`);
    console.log(
      `   Middle 10 (around #${Math.floor(fallbackKeywordPool.length / 2)}): ${fallbackKeywordPool
        .slice(Math.floor(fallbackKeywordPool.length / 2), Math.floor(fallbackKeywordPool.length / 2) + 10)
        .join(', ')}`,
    );
    console.log(`   Last 10: ${fallbackKeywordPool.slice(-10).join(', ')}`);

    sampled = sanitizeKeywordList(shuffleSample(fallbackKeywordPool, SAMPLE_SIZE));
    keywordCollectionMethod = 'naver_search_random_sample';
  }

  sampled = sampled.slice(0, SAMPLE_SIZE);

  if (!sampled.length) {
    throw new Error('Unable to obtain any keywords for evaluation.');
  }

  console.log(
    `🎯 Selected ${sampled.length} finance keywords for evaluation (${keywordCollectionMethod === 'naver_search_llm_seeded' ? 'tinyllama worker' : 'finance_keywords.json fallback'}).`,
  );

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
      translationStats[method] = (translationStats[method] || 0) + 1;
      result.term = translatedTerm;
    } else {
      result.term = keyword;
      const { text: translatedTerm, method } = await translateText(keyword, {
        sourceLang: 'EN',
        targetLang: 'KO',
      });
      translationStats[method] = (translationStats[method] || 0) + 1;
      result.term_ko = translatedTerm;
    }

    ensureLanguagePlacement(result, keyword);

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

  const uniqueEvaluated = [];
  const similarDiscarded = [];

  for (const item of evaluated) {
    const duplicate = uniqueEvaluated.find((existing) => areResultsSimilar(existing, item));
    if (duplicate) {
      similarDiscarded.push({ kept: duplicate, dropped: item });
      continue;
    }
    uniqueEvaluated.push(item);
  }

  if (similarDiscarded.length) {
    console.log(`\n🧮 Removed ${similarDiscarded.length} similar keywords after scoring.`);
    for (const { kept, dropped } of similarDiscarded.slice(0, 5)) {
      console.log(
        `   ↳ Dropped "${dropped.term_ko || dropped.term}" (score ${dropped.significance_score}) in favor of "${kept.term_ko || kept.term}" (score ${kept.significance_score}).`,
      );
    }
    if (similarDiscarded.length > 5) {
      console.log(`   …and ${similarDiscarded.length - 5} more similar pairs.`);
    }
  }

  const now = new Date();
  const fallbackKeywordSource = path.relative(process.cwd(), FINANCE_KEYWORDS_PATH);
  const metadata = {
    collection_method: keywordCollectionMethod,
    sample_size: SAMPLE_SIZE,
    generated_at: now.toISOString(),
    keyword_limit: SAMPLE_SIZE,
    lookback_hours: 12,
    keyword_source:
      keywordCollectionMethod === 'naver_search_llm_seeded' ? LLM_WORKER_URL : fallbackKeywordSource,
    fallback_keyword_source: fallbackKeywordSource,
    similar_keywords_removed: similarDiscarded.length,
  };

  if (keywordCollectionMethod === 'naver_search_llm_seeded') {
    metadata.llm_model = LLM_MODEL;
    metadata.llm_keywords_requested = SAMPLE_SIZE;
  }

  const result = {
    date: now.toISOString().split('T')[0],
    window: WINDOW_LABEL,
    total_phrases: uniqueEvaluated.length,
    discovered_keywords: uniqueEvaluated,
    metadata,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(`✅ Saved ${uniqueEvaluated.length} keywords to ${OUTPUT_PATH}`);
}

if (require.main === module) {
  buildTags().catch((err) => {
    console.error('❌ Generation failed:', err);
    process.exitCode = 1;
  });
}

module.exports = { buildTags };
