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
const CEREBRAS_PROMPT_CHAR_LIMIT = Number(process.env.CEREBRAS_PROMPT_CHAR_LIMIT) || 7000;
const CEREBRAS_MIN_DYNAMIC_TEXT = Number(process.env.CEREBRAS_MIN_DYNAMIC_TEXT) || 1200;
const CEREBRAS_DYNAMIC_TEXT_CHAR_LIMIT =
  Number(process.env.CEREBRAS_DYNAMIC_TEXT_CHAR_LIMIT) || 3000;

const SAMPLE_SIZE = 30;
const OUTPUT_PATH = path.resolve(__dirname, '../data/tags.json');
const FINANCE_KEYWORDS_PATH = path.resolve(__dirname, '../data/finance_keywords.json');

const TRENDING_WINDOW_HOURS = Number(process.env.TRENDING_WINDOW_HOURS) || 24;
const TRENDING_BASELINE_DAYS = Number(process.env.TRENDING_BASELINE_DAYS) || 7;
const TRENDING_WINDOW_MAX_LLM_KEYWORDS = Number(process.env.TRENDING_WINDOW_MAX_LLM_KEYWORDS) || 50;
const TRENDING_WINDOW_TEXT_SLICE = Number(process.env.TRENDING_WINDOW_TEXT_SLICE) || 18000;

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

const KOREAN_CONTEXTUAL_SUFFIXES = [
  '주가 모멘텀',
  '실적 전망',
  '시장 반응',
  '투자 이슈',
  '규제 동향',
  '성장 전략',
];

const ENGLISH_CONTEXTUAL_SUFFIXES = [
  'earnings outlook',
  'market momentum',
  'innovation strategy',
  'regulatory shifts',
  'investor focus',
  'supply chain update',
];

const fallbackMaps = {
  EN: new Map(),
  KO: new Map(),
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const KST_TIME_ZONE = 'Asia/Seoul';
const kstDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: KST_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function formatDateKST(date) {
  return kstDateFormatter.format(date);
}

function last24hDatesKST() {
  const now = new Date();
  const endDate = formatDateKST(now);
  const startDate = formatDateKST(new Date(now.getTime() - ONE_DAY_MS));
  return { startDate, endDate };
}

function chunkArray(items, chunkSize) {
  const size = Math.max(1, Number(chunkSize) || 1);
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function limitWords(phrase, maxWords = 2) {
  if (!phrase) return '';
  const parts = String(phrase)
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '';
  const cap = Math.max(1, Number.isFinite(maxWords) ? Math.floor(maxWords) : 2);
  if (parts.length <= cap) {
    return parts.join(' ');
  }
  return parts.slice(0, cap).join(' ');
}

function enforceKeywordWordCount(keywords, { minWords = 1, maxWords = 5 } = {}) {
  if (!Array.isArray(keywords)) {
    return [];
  }

  const min = Math.max(1, Number.isFinite(minWords) ? Math.floor(minWords) : 1);
  const max = Math.max(min, Number.isFinite(maxWords) ? Math.floor(maxWords) : min);

  const truncated = keywords.map((keyword) => limitWords(keyword, max));
  const filtered = truncated.filter((keyword) => {
    const wordCount = keyword.split(/\s+/).filter(Boolean).length;
    return wordCount >= min && wordCount <= max;
  });

  return dedupeKeywords(filtered);
}

function keywordHash(value) {
  const str = String(value || '');
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0; // eslint-disable-line no-bitwise
  }
  return Math.abs(hash);
}

function shrinkPromptForCerebras(prompt, targetLength = CEREBRAS_PROMPT_CHAR_LIMIT) {
  if (!prompt) return '';
  const safeLimit = Math.max(400, Number(targetLength) || CEREBRAS_PROMPT_CHAR_LIMIT);
  if (prompt.length <= safeLimit) {
    return prompt;
  }

  const ellipsis = '\n[...trimmed due to length...]';
  const sliceLength = Math.max(100, safeLimit - ellipsis.length);
  const trimmed = prompt.slice(0, sliceLength);
  return `${trimmed}${ellipsis}`;
}

function isContextLengthError(error) {
  if (!error) return false;
  const message =
    typeof error === 'string'
      ? error
      : error.message || error?.response || error?.description || '';
  return /context_length_exceeded|reduce the length of the messages|too long/i.test(message);
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
        similar = true;
        break;
      }
    }

    if (similar) continue;

    seen.push(normalized);
    deduped.push(trimmed);
  }

  return deduped;
}

function stripKeywordLabel(value) {
  if (!value) return '';

  let stripped = String(value).trim();
  const labelPattern = /^(?:keywords?|keyword|overview|summary|키워드|개요)\s*[:：\-–—]?\s*/i;

  while (labelPattern.test(stripped)) {
    stripped = stripped.replace(labelPattern, '').trim();
  }

  return stripped;
}

function cleanKeyword(keyword) {
  if (typeof keyword !== 'string') {
    return '';
  }

  const withoutQuotes = String(keyword)
    .replace(/["'`""''‚‛„‟‹›«»]/g, '')
    .replace(/[，,]/g, ' ');

  let normalized = stripKeywordLabel(withoutQuotes);

  const colonPattern = /[:：]/;
  while (colonPattern.test(normalized)) {
    const colonIndex = normalized.search(colonPattern);
    normalized = normalized.slice(colonIndex + 1).trim();
  }

  return normalized.replace(/\s+/g, ' ').trim();
}

function isTooGenericKeyword(keyword) {
  if (!keyword) return true;

  const normalized = String(keyword).trim();
  if (!normalized) return true;

  const compact = normalized.replace(/\s+/g, ' ').toLowerCase();
  const tokens = compact.split(' ');

  const genericSingles = new Set([
    '정부', '비즈니스', '경제', '정치', '사회', '금융', '산업', '시장',
    '기술', '투자', '주식', '뉴스', '동향', '이슈', '관련', '분석',
    '전망', '업계', '기업', '회사', '증시', '코스피', '나스닥', 'kospi',
    '오늘', '내일', '어제', '최근', '현재', '상황',
    'business', 'government', 'economy', 'politics', 'society',
    'finance', 'industry', 'market', 'technology', 'investment',
    'stock', 'news', 'trend', 'issue', 'analysis', 'outlook',
    'sector', 'company', 'corporate', 'today', 'recent', 'current',
  ]);

  if (tokens.length === 1) {
    if (genericSingles.has(compact)) {
      return true;
    }
  }

  if (tokens.length === 2) {
    const genericPrefixes = new Set([
      '정부', '경제', '금융', '산업', '시장', '주식', '증시', '오늘',
      'stock', 'market', 'economic', 'financial', 'industry', 'today',
    ]);

    const genericSuffixes = new Set([
      '관련', '동향', '이슈', '뉴스', '전망', '분석', '시장', '상황',
      'news', 'trend', 'issue', 'market', 'outlook', 'analysis', 'situation',
    ]);

    if (genericPrefixes.has(tokens[0]) && genericSuffixes.has(tokens[1])) {
      return true;
    }
  }

  const vaguePatterns = [
    /^(경제|금융|산업|시장|정치|사회)\s+(동향|이슈|뉴스|상황|분석)/,
    /^(stock|market|economic|financial|political)\s+(news|trend|issue|situation|analysis)/,
    /관련\s*$/,
    /\s+related$/,
    /^.{1,2}$/,
  ];

  for (const pattern of vaguePatterns) {
    if (pattern.test(compact)) {
      return true;
    }
  }

  return false;
}

function calculateSpecificityScore(keyword) {
  if (!keyword) return 0;

  const normalized = String(keyword).trim().toLowerCase();
  const tokens = normalized.split(/\s+/).filter(Boolean);

  let score = 100;

  if (tokens.length === 1) score -= 20;

  if (tokens.length >= 2 && tokens.length <= 5) score += 20;

  const genericWords = new Set([
    '관련', '동향', '이슈', '뉴스', '시장', '산업', '상황', '분석',
    'related', 'trend', 'news', 'market', 'industry', 'situation', 'analysis',
  ]);

  for (const token of tokens) {
    if (genericWords.has(token)) score -= 20;
  }

  if (/[0-9]/.test(normalized)) score += 15;
  if (/[A-Z]{2,}/.test(keyword)) score += 10;

  const specificEntities = /삼성|현대|LG|SK|카카오|네이버|롤드컵|토트넘|맨유|손흥민|Apple|Tesla|Microsoft|Google|Amazon|NVIDIA|Champions|League/i;
  if (specificEntities.test(keyword)) score += 30;

  const viralCategories = /축구|야구|농구|게임|e스포츠|영화|드라마|아이돌|케이팝|football|soccer|basketball|game|esports|movie|drama|kpop/i;
  if (viralCategories.test(normalized)) score += 25;

  return Math.max(0, score);
}

function lookupFallbackTranslation(keyword) {
  if (!keyword) return '';

  const directKey = String(keyword).trim();
  const normalizedKey = normalizeForComparison(directKey);

  for (const map of Object.values(fallbackMaps)) {
    if (!map || map.size === 0) continue;
    const direct = map.get(directKey);
    if (direct) return String(direct).trim();
    const normalized = map.get(normalizedKey);
    if (normalized) return String(normalized).trim();
  }

  return '';
}

function buildContextualSuffix(keyword) {
  const base = containsHangul(keyword)
    ? KOREAN_CONTEXTUAL_SUFFIXES
    : ENGLISH_CONTEXTUAL_SUFFIXES;
  if (!base.length) {
    return '';
  }
  const index = keywordHash(keyword) % base.length;
  return base[index];
}

function upgradeKeywordSpecificity(keyword, { minWords = 2, maxWords = 5 } = {}) {
  if (!keyword) return '';

  const trimmed = String(keyword).trim();
  if (!trimmed) return '';

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= minWords) {
    return limitWords(trimmed, maxWords);
  }

  const translation = lookupFallbackTranslation(trimmed);
  if (translation) {
    const translationWords = translation.split(/\s+/).filter(Boolean);
    if (translationWords.length >= minWords) {
      if (containsHangul(trimmed) && /[a-z]/i.test(translation)) {
        const bilingual = `${trimmed} ${translation}`;
        return limitWords(bilingual, maxWords);
      }
      return limitWords(translation, maxWords);
    }
  }

  const contextualSuffix = buildContextualSuffix(trimmed);
  if (contextualSuffix) {
    const expanded = `${trimmed} ${contextualSuffix}`;
    return limitWords(expanded, maxWords);
  }

  return limitWords(trimmed, maxWords);
}

function sanitizeKeywordList(keywords, { minWords = 2, maxWords = 5 } = {}) {
  if (!Array.isArray(keywords)) return [];

  const cleaned = keywords
    .map((kw) => cleanKeyword(kw))
    .map((kw) => upgradeKeywordSpecificity(kw, { minWords, maxWords }))
    .filter((kw) => kw.length > 0)
    .filter((kw) => !isTooGenericKeyword(kw));

  return enforceKeywordWordCount(cleaned, { minWords, maxWords });
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
      // continue
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
  const count = Number.isFinite(desiredCount) && desiredCount > 0 ? Math.floor(desiredCount) : SAMPLE_SIZE;
  return [
    '다음 기사 전반에서 가장 화제가 되고 있는 구체적인 키워드와 이슈를 추출해 주세요.',
    `총 ${Math.min(Math.max(count, 10), SAMPLE_SIZE)}개의 항목을 목표로 해 주세요.`,
    '',
    '**중요 규칙:**',
    '- 구체적인 고유명사, 사건명, 인물명, 브랜드명 우선 (예: "롤드컵", "손흥민", "토트넘 대 맨유")',
    '- 일반적인 단어는 절대 금지 (예: "경제 뉴스", "시장 동향", "금융 이슈" 등)',
    '- 2~5어절의 구체적 표현',
    '- 실시간 검색어처럼 화제성 있는 키워드',
    '',
    '나쁜 예시: "경제 동향", "시장 이슈", "정치 뉴스"',
    '좋은 예시: "엔비디아 실적", "한국은행 금리 인상", "삼성 반도체", "넷플릭스 오징어게임"',
    '',
    '출력은 추가 설명, 코드 블록, 번호 매기기 없이 문자열만 담긴 JSON 배열 형식을 엄격히 지켜 주세요.',
  ].join('\n');
}

async function fetchCerebrasKeywords({ desiredCount = SAMPLE_SIZE, prompt, allowAutoTruncate = true } = {}) {
  if (!CEREBRAS_API_KEY) {
    console.warn('⚠️  CEREBRAS_API_KEY is not configured. Skipping Cerebras keyword generation.');
    return [];
  }

  let promptToUse = (prompt || buildKeywordPrompt(desiredCount)).trim();
  if (!promptToUse) {
    console.warn('⚠️  Attempted to call Cerebras with an empty prompt.');
    return [];
  }

  const maxAttempts = allowAutoTruncate ? 2 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt === 1) {
      console.log('🤖 Requesting trending keywords from Cerebras…');
    } else {
      console.log('🔁 Retrying Cerebras request with trimmed prompt…');
    }

    const payload = {
      model: CEREBRAS_MODEL,
      messages: [
        { role: 'system', content: 'You are a helpful assistant that extracts viral trending keywords and returns only valid JSON arrays.' },
        { role: 'user', content: promptToUse },
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
      const sanitized = sanitizeKeywordList(extracted);

      const specific = sanitized.filter((kw) => calculateSpecificityScore(kw) >= 60);
      const constrained = enforceKeywordWordCount(specific, { minWords: 2, maxWords: 5 }).slice(
        0,
        desiredCount,
      );

      if (!constrained.length) {
        throw new Error('No keywords met the specificity requirements from Cerebras response.');
      }

      console.log(`🤖 Cerebras provided ${constrained.length} specific keyword candidates.`);
      return constrained;
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn(`⚠️  Cerebras request timed out after ${CEREBRAS_REQUEST_TIMEOUT_MS}ms.`);
        return [];
      }

      if (
        allowAutoTruncate &&
        attempt < maxAttempts &&
        isContextLengthError(err) &&
        promptToUse.length > CEREBRAS_MIN_DYNAMIC_TEXT
      ) {
        const nextLimit = Math.max(
          CEREBRAS_MIN_DYNAMIC_TEXT,
          Math.min(CEREBRAS_PROMPT_CHAR_LIMIT, Math.floor(promptToUse.length * 0.8)),
        );
        const trimmedPrompt = shrinkPromptForCerebras(promptToUse, nextLimit);
        if (trimmedPrompt.length < promptToUse.length) {
          console.warn(
            `⚠️  Cerebras prompt too long (len=${promptToUse.length}). Retrying with ${trimmedPrompt.length} characters.`,
          );
          promptToUse = trimmedPrompt;
          continue;
        }
      }

      console.warn(`⚠️  Failed to retrieve keywords from Cerebras: ${err.message}`);
      return [];
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return [];
}

async function requestKeywordsFromWorker({ prompt, limit } = {}) {
  if (!LLM_WORKER_URL) {
    console.warn('⚠️  LLM worker URL is not configured. Skipping fallback keyword generation.');
    return [];
  }

  const effectiveLimit =
    Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), SAMPLE_SIZE * 2) : SAMPLE_SIZE;

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
    const sanitized = sanitizeKeywordList(extracted);

    const specific = sanitized.filter((kw) => calculateSpecificityScore(kw) >= 60);
    const constrained = enforceKeywordWordCount(specific, { minWords: 2, maxWords: 5 }).slice(
      0,
      effectiveLimit,
    );

    if (!constrained.length) {
      throw new Error('No keywords met the specificity requirements from LLM response.');
    }

    console.log(`🤖 tinyllama provided ${constrained.length} keyword candidates.`);
    return constrained;
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

function nowKST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: KST_TIME_ZONE }));
}

function subHours(date, hours) {
  return new Date(date.getTime() - hours * 60 * 60 * 1000);
}

function fmtYMD(date) {
  return date.toISOString().slice(0, 10);
}

function yyyymmddToDateKST(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length < 8) {
    return new Date(NaN);
  }
  const iso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}T00:00:00+09:00`;
  return new Date(iso);
}

async function naverDatalabDaily(groups, { startDate, endDate }) {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
    throw new Error('NAVER credentials are required for DataLab API.');
  }

  const payload = {
    startDate,
    endDate,
    timeUnit: 'date',
    keywordGroups: groups,
  };

  const response = await fetch(NAVER_DATALAB_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Naver-Client-Id': NAVER_CLIENT_ID,
      'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Datalab error ${response.status}: ${text.slice(0, 120)}`);
  }

  const json = await response.json();
  return Array.isArray(json?.results) ? json.results : [];
}

function stripMarkup(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchGoogleDailyTrends({ geo = 'KR', hl = 'ko', tz = -540, date } = {}) {
  const params = new URLSearchParams({ geo, hl, tz: String(tz) });
  if (date) {
    params.set('ed', date);
  }

  const url = `https://trends.google.com/trends/api/dailytrends?${params.toString()}`;
  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Trends error ${response.status}: ${text.slice(0, 120)}`);
  }

  const raw = await response.text();
  const sanitized = raw.replace(/^\)\]\}'\s*/, '');

  try {
    const parsed = JSON.parse(sanitized);
    const days = parsed?.default?.trendingSearchesDays;
    return Array.isArray(days) ? days : [];
  } catch (err) {
    throw new Error(`Failed to parse Google Trends response: ${err.message}`);
  }
}

function parseGoogleTrendsDate(day) {
  const yyyymmdd = String(day?.date || '');
  if (/^\d{8}$/.test(yyyymmdd)) {
    const year = yyyymmdd.slice(0, 4);
    const month = yyyymmdd.slice(4, 6);
    const dayOfMonth = yyyymmdd.slice(6, 8);
    const iso = `${year}-${month}-${dayOfMonth}T00:00:00+09:00`;
    const timestamp = Date.parse(iso);
    if (Number.isFinite(timestamp)) {
      return new Date(timestamp);
    }
  }

  const fallback = Date.parse(day?.formattedDate || '');
  if (Number.isFinite(fallback)) {
    return new Date(fallback);
  }

  return nowKST();
}

function extractGoogleTrendDocuments(days) {
  const documents = [];
  for (const day of days) {
    const dayStart = parseGoogleTrendsDate(day);
    const searches = Array.isArray(day?.trendingSearches) ? day.trendingSearches : [];

    for (const search of searches) {
      const keyword = search?.title?.query || search?.title || '';
      const articles = Array.isArray(search?.articles) ? search.articles : [];

      for (const article of articles) {
        const text = stripMarkup(`${article.title || ''} ${article.snippet || ''}`);
        documents.push({
          keyword,
          text,
          when: dayStart,
          source: 'google_trends',
        });
      }
    }
  }

  return documents;
}

async function collectGoogleTrendWindow({
  hours = TRENDING_WINDOW_HOURS,
  baselineDays = TRENDING_BASELINE_DAYS,
} = {}) {
  const now = nowKST();
  const since = subHours(now, hours);
  const baselineStart = subHours(since, baselineDays * 24);

  const days = await fetchGoogleDailyTrends({ geo: 'KR', hl: 'ko', tz: -540 });
  const documents = extractGoogleTrendDocuments(days);

  const windowDocs = [];
  const baselineDocs = [];

  for (const doc of documents) {
    const when = doc.when instanceof Date ? doc.when : new Date(doc.when || now);
    if (when >= since) {
      windowDocs.push(doc);
    } else if (when >= baselineStart && when < since) {
      baselineDocs.push(doc);
    }
  }

  console.log(
    `📊 Collected ${windowDocs.length} Google Trends articles for the ${hours}h window and ${baselineDocs.length} baseline articles`,
  );

  return {
    windowDocs,
    baselineDocs,
    since,
    now,
  };
}

const GOOGLE_TRENDS_CACHE_TTL_MS = 10 * 60 * 1000;
let googleTrendsCache = { fetchedAt: 0, days: [] };

async function loadGoogleTrendDays() {
  const now = Date.now();
  if (now - googleTrendsCache.fetchedAt < GOOGLE_TRENDS_CACHE_TTL_MS && googleTrendsCache.days.length) {
    return googleTrendsCache.days;
  }

  const days = await fetchGoogleDailyTrends({ geo: 'KR', hl: 'ko', tz: -540 });
  googleTrendsCache = { fetchedAt: now, days };
  return days;
}

function findGoogleTrendArticles(keyword, days) {
  if (!keyword) return [];
  const articles = [];

  for (const day of days) {
    const dayDate = parseGoogleTrendsDate(day);
    const searches = Array.isArray(day?.trendingSearches) ? day.trendingSearches : [];

    for (const search of searches) {
      const query = search?.title?.query || search?.title || '';
      if (!query) continue;
      if (!areStringsSimilar(query, keyword) && !areStringsSimilar(keyword, query)) {
        continue;
      }

      const trendArticles = Array.isArray(search?.articles) ? search.articles : [];
      for (const article of trendArticles) {
        articles.push({
          title: cleanSnippet(article.title || ''),
          summary: cleanSnippet(article.snippet || ''),
          link: article.url || article.newsUrl || '',
          timeAgo: article.timeAgo || null,
          when: dayDate,
          source: article.source || null,
        });
      }
    }
  }

  return articles;
}

function buildWindowExtractionPrompt(text, maxKeywords) {
  const safeMax = Number.isFinite(maxKeywords) && maxKeywords > 0 ? Math.floor(maxKeywords) : 0;
  const instructionLines = [
    `아래의 한국어 뉴스/블로그 텍스트에서 실시간으로 가장 화제가 되는 구체적인 키워드를 최대 ${safeMax || TRENDING_WINDOW_MAX_LLM_KEYWORDS}개 도출하세요.`,
    '',
    '**중요 규칙:**',
    '- 구체적인 고유명사만 추출 (인물, 팀명, 브랜드, 사건명 등)',
    '- 2~5어절의 구체적 표현',
    '- 일반 명사는 절대 금지 (경제, 시장, 동향, 이슈 등)',
    '- 실시간 검색어나 구글 트렌드에 나올 법한 화제성 키워드',
    '- 결과는 JSON 배열 형식만 출력 (설명 금지)',
    '',
    '나쁜 예시: "경제 동향", "시장 이슈", "금융 뉴스"',
    '좋은 예시: "롤드컵 결승", "손흥민 골", "삼성전자 실적", "넷플릭스 오징어게임"',
    '',
    '텍스트:',
  ];

  const header = instructionLines.join('\n');
  const headerWithNewline = `${header}\n`;
  const rawInput = String(text || '').slice(0, TRENDING_WINDOW_TEXT_SLICE);

  const remainingBudget = CEREBRAS_PROMPT_CHAR_LIMIT - headerWithNewline.length;
  const minimumBudget = Math.min(CEREBRAS_MIN_DYNAMIC_TEXT, Math.max(0, remainingBudget));
  const dynamicBudget = remainingBudget > 0 ? remainingBudget : minimumBudget;
  const cappedBudget = Math.min(
    TRENDING_WINDOW_TEXT_SLICE,
    CEREBRAS_DYNAMIC_TEXT_CHAR_LIMIT,
    dynamicBudget,
  );
  const effectiveBudget = Math.max(0, Math.floor(cappedBudget));

  let snippet = rawInput.slice(0, effectiveBudget);
  const wasTruncated = rawInput.length > snippet.length;
  if (wasTruncated && snippet.length > 0) {
    const marker = '\n[중략]\n';
    const adjusted = Math.max(0, effectiveBudget - marker.length);
    snippet = `${snippet.slice(0, adjusted)}${marker}`;
  }

  const prompt = `${headerWithNewline}${snippet}`;

  return {
    prompt,
    truncated: wasTruncated,
    snippetLength: snippet.length,
    originalLength: text ? String(text).length : 0,
  };
}

async function extractWindowKeywordsKorean(text, max = TRENDING_WINDOW_MAX_LLM_KEYWORDS) {
  if (!text) {
    return [];
  }

  const { prompt, truncated, snippetLength, originalLength } = buildWindowExtractionPrompt(text, max);
  if (truncated) {
    console.log(
      `✂️  Trimmed news/blog sample for Cerebras from ${originalLength} to ${snippetLength} characters.`,
    );
  }

  const cerebrasKeywords = await fetchCerebrasKeywords({ desiredCount: max, prompt });
  if (cerebrasKeywords.length) {
    return cerebrasKeywords;
  }

  const fallback = await requestKeywordsFromWorker({ prompt, limit: max });
  return fallback.slice(0, max);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countFreq(texts, phrase) {
  if (!phrase || !Array.isArray(texts) || !texts.length) {
    return 0;
  }
  const joined = texts.join('\n');
  const matches = joined.match(new RegExp(escapeRegExp(phrase), 'g')) || [];
  return matches.length;
}

function burstScore(keyword, windowTexts, baselineTexts, hours = TRENDING_WINDOW_HOURS, baselineDays = TRENDING_BASELINE_DAYS, alpha = 1) {
  const c24 = countFreq(windowTexts, keyword);
  const c7d = countFreq(baselineTexts, keyword);
  const expected24 = baselineDays > 0 ? c7d / baselineDays : 0;

  const lift = c24 > 0 && expected24 === 0 ? 1000 : (c24 + alpha) / (expected24 + alpha);

  return { c24, c7d, lift };
}

async function datalabMomentum(keywords) {
  if (!Array.isArray(keywords) || !keywords.length) {
    return [];
  }

  const end = fmtYMD(nowKST());
  const start = fmtYMD(subHours(nowKST(), 72));
  const results = [];

  for (let i = 0; i < keywords.length; i += 5) {
    const groupSlice = keywords.slice(i, i + 5);
    const groups = groupSlice.map((keyword) => ({ groupName: keyword, keywords: [keyword] }));

    try {
      const response = await naverDatalabDaily(groups, { startDate: start, endDate: end });
      for (const entry of response) {
        const data = Array.isArray(entry?.data) ? entry.data : [];
        if (data.length >= 2) {
          const latest = Number(data[data.length - 1]?.ratio) || 0;
          const previous = Number(data[data.length - 2]?.ratio) || 0;
          results.push({ keyword: entry.title, dl_momentum: latest - previous, dl_latest: latest });
        } else {
          results.push({ keyword: entry?.title, dl_momentum: 0, dl_latest: 0 });
        }
      }
    } catch (err) {
      console.warn(`⚠️  Failed to retrieve DataLab momentum for [${groupSlice.join(', ')}]: ${err.message}`);
      for (const keyword of groupSlice) {
        results.push({ keyword, dl_momentum: 0, dl_latest: 0 });
      }
    }
  }

  return results;
}

async function trending24h({
  hours = TRENDING_WINDOW_HOURS,
  baselineDays = TRENDING_BASELINE_DAYS,
} = {}) {
  const { windowDocs, baselineDocs, since, now } = await collectGoogleTrendWindow({
    hours,
    baselineDays,
  });

  const windowTexts = windowDocs.map((item) => item.text).filter(Boolean);
  if (!windowTexts.length) {
    throw new Error('Google Trends window did not yield any documents.');
  }

  const sampleForLLM = windowTexts.join('\n');
  const candidates = await extractWindowKeywordsKorean(sampleForLLM, TRENDING_WINDOW_MAX_LLM_KEYWORDS);

  if (!candidates.length) {
    throw new Error('LLM did not return any candidate keywords for the Google Trends window.');
  }

  console.log(`🎯 LLM extracted ${candidates.length} candidate keywords from ${windowTexts.length} documents`);

  const baselineTexts = baselineDocs.map((item) => item.text).filter(Boolean);

  const burst = candidates.map((keyword) => ({
    keyword,
    ...burstScore(keyword, windowTexts, baselineTexts, hours, baselineDays, 1),
  }));

  const momentum = await datalabMomentum(candidates);
  const momentumMap = new Map(momentum.map((entry) => [entry.keyword, entry]));
  const tanh = (value) => Math.tanh(value);

  const scored = burst
    .map((entry) => {
      const dataLab = momentumMap.get(entry.keyword) || { dl_momentum: 0, dl_latest: 0 };
      const specificityBonus = calculateSpecificityScore(entry.keyword) / 100;

      const finalScore =
        0.5 * tanh(Math.log(entry.lift || 1)) +
        0.3 * tanh((dataLab.dl_momentum || 0) / 10) +
        0.2 * specificityBonus;

      return { ...entry, ...dataLab, score: finalScore, specificityScore: specificityBonus * 100 };
    })
    .sort((a, b) => b.score - a.score);

  const topics = windowDocs
    .map((doc) => doc.keyword)
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);

  return {
    hours,
    baselineDays,
    window: { since: since.toISOString(), now: now.toISOString() },
    top: scored,
    topics,
  };
}

async function fetchTrendingKeywordsFromWindow({ limit = SAMPLE_SIZE } = {}) {
  try {
    const trending = await trending24h({});
    const keywords = sanitizeKeywordList((trending?.top || []).map((item) => item.keyword)).slice(0, limit);

    console.log(`\n🔥 Top ${Math.min(10, keywords.length)} viral keywords by score:`);
    trending.top.slice(0, 10).forEach((item, idx) => {
      console.log(`   ${idx + 1}. ${item.keyword} (score: ${item.score.toFixed(4)}, lift: ${item.lift.toFixed(2)}, specificity: ${item.specificityScore.toFixed(0)})`);
    });

    return {
      keywords,
      metadata: {
        window: trending?.window || null,
        hours: trending?.hours || TRENDING_WINDOW_HOURS,
        baselineDays: trending?.baselineDays || TRENDING_BASELINE_DAYS,
        candidateCount: Array.isArray(trending?.top) ? trending.top.length : 0,
        topics: trending?.topics || [],
      },
    };
  } catch (err) {
    console.warn(`⚠️  Failed to build 24h trending keywords: ${err.message}`);
    return { keywords: [], metadata: null };
  }
}

async function fetchLLMKeywords({ desiredCount = SAMPLE_SIZE } = {}) {
  const limit =
    Number.isFinite(desiredCount) && desiredCount > 0 ? Math.min(Math.floor(desiredCount), SAMPLE_SIZE * 2) : SAMPLE_SIZE;

  console.log('🔍 Attempting to fetch viral trending keywords from the Google Trends 24h window...');
  const windowTrending = await fetchTrendingKeywordsFromWindow({ limit });
  if (windowTrending.keywords.length) {
    console.log(`📈 Using ${windowTrending.keywords.length} viral keywords from Google Trends window pipeline.`);
    return {
      keywords: windowTrending.keywords,
      method: 'google_trends_window',
      windowMetadata: windowTrending.metadata,
    };
  }

  const trendingSeeds = await fetchTrendingKeywordsFromNaver({ limit });
  if (trendingSeeds.length) {
    try {
      const trimmed = await trimKeywordsWithCerebras(trendingSeeds, { maxWords: 2, limit });
      if (trimmed.length) {
        console.log(`📈 Using ${trimmed.length} trending keywords from NAVER DataLab.`);
        return { keywords: trimmed, method: 'naver_datalab_trending_seeded' };
      }
    } catch (err) {
      console.warn(`⚠️  Failed to trim NAVER trending keywords with Cerebras: ${err.message}`);
    }

    const locallyTrimmed = sanitizeKeywordList(trendingSeeds.map((kw) => limitWords(kw, 2))).slice(0, limit);
    if (locallyTrimmed.length) {
      console.log(`📈 Using ${locallyTrimmed.length} NAVER trending keywords with local trimming.`);
      return { keywords: locallyTrimmed, method: 'naver_datalab_trending_seeded' };
    }
  }

  const prompt = buildKeywordPrompt(limit);

  const cerebrasKeywords = await fetchCerebrasKeywords({ desiredCount: limit, prompt });
  if (cerebrasKeywords.length) {
    return { keywords: cerebrasKeywords, method: 'llm_seeded' };
  }

  console.log('🤖 Cerebras unavailable — falling back to tinyllama worker…');
  const workerKeywords = await requestKeywordsFromWorker({ prompt, limit });
  if (workerKeywords.length) {
    return { keywords: workerKeywords, method: 'llm_seeded' };
  }

  return { keywords: [], method: 'llm_seeded' };
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

  if (minLength <= 3) {
    return normA === normB;
  }

  if (prefix >= minLength - 1) {
    return true;
  }

  const distance = levenshteinDistance(normA, normB);
  const threshold = Math.max(1, Math.floor(minLength * 0.25));

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

const NAVER_DATALAB_ENDPOINT = 'https://openapi.naver.com/v1/datalab/search';
const NAVER_TREND_MAX_KEYWORDS_PER_REQUEST = 5;
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
    .map((kw) => cleanKeyword(kw))
    .filter((kw) => kw.length > 0);

  const koreanCount = cleaned.filter((kw) => containsHangul(kw)).length;
  const nonKoreanCount = cleaned.length - koreanCount;

  console.log(
    `🧹 After trimming invalid entries: ${cleaned.length} keywords (KO: ${koreanCount}, EN/Other: ${nonKoreanCount})`,
  );

  const deduped = dedupeKeywords(cleaned);
  console.log(`🔄 After deduplication: ${deduped.length} keywords`);

  buildFallbackMap(raw.finance_keywords_en);
  return deduped;
}

function shuffleSample(list, size) {
  const pool = [...list];

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

function buildTrendLinks(keyword) {
  const query = encodeURIComponent(keyword);
  return {
    google_trends: `https://trends.google.com/trends/explore?geo=KR&q=${query}`,
    naver_datalab: `https://datalab.naver.com/keyword/trendResult.naver?keyword=${query}`,
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
  const normalized = period.includes(' ') ? period.replace(' ', 'T') : `${period}T00:00:00`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function buildDatalabPayload(keyword, timeUnit) {
  const now = new Date();
  const endDate = new Date(now.getTime());

  const lookbackDays = (() => {
    const normalized = String(timeUnit || '').toLowerCase();
    switch (normalized) {
      case 'hour':
        return 2; // The public API rejects long hourly windows; limit to roughly 48 hours.
      case 'week':
        return 8 * 7; // Eight weeks of history to provide enough context for weekly buckets.
      case 'month':
        return 365; // Roughly one year of data for monthly aggregation.
      default:
        return 8; // Default to just over a week of data for daily buckets.
    }
  })();

  const startDate = new Date(endDate.getTime() - lookbackDays * ONE_DAY_MS);

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
  const attemptedTimeUnits = ['date', 'week'];

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
  const scaledScore = Number((adjustedScore * 1000).toFixed(2));

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
    rawScore: Number(adjustedScore.toFixed(6)),
    scaledScore,
    totalScore: Math.round(scaledScore),
    recentHourVolume: recentWindowVolume,
    past_24h_volume: mediumWindowTotal,
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

  let googleArticles = [];
  try {
    const days = await loadGoogleTrendDays();
    googleArticles = findGoogleTrendArticles(keyword, days);
  } catch (err) {
    console.warn(`   ⚠️ Failed to fetch Google Trends stories for "${keyword}":`, err.message || err);
  }

  const now = Date.now();
  const googleArticleScore = googleArticles.reduce((sum, article) => {
    let weight = 80;
    if (article.timeAgo && /\d+/.test(article.timeAgo)) {
      const hoursMatch = article.timeAgo.match(/(\d+)\s*시간/);
      const minutesMatch = article.timeAgo.match(/(\d+)\s*분/);
      if (hoursMatch) {
        const hours = Number(hoursMatch[1]);
        weight += Math.max(0, 120 - hours * 10);
      } else if (minutesMatch) {
        const minutes = Number(minutesMatch[1]);
        weight += Math.max(0, 140 - minutes);
      }
    } else if (article.when instanceof Date && !Number.isNaN(+article.when)) {
      const hoursAgo = (now - article.when.getTime()) / (1000 * 60 * 60);
      weight += Math.max(0, 120 - hoursAgo * 10);
    }
    return sum + weight;
  }, 0);

  const fallbackScore = Math.round(Math.max(googleArticleScore, googleArticles.length * 80));
  const finalScore = datalabScores?.totalScore ?? fallbackScore;

  const topHeadlines = googleArticles.slice(0, 3).map((article) => ({
    title: article.title,
    summary: article.summary,
    link: article.link,
    timeAgo: article.timeAgo,
    pubDate: article.when instanceof Date && !Number.isNaN(+article.when)
      ? article.when.toISOString()
      : null,
    source: article.source || null,
  }));

  console.log(
    `🔎 ${keyword.padEnd(20, ' ')} → score ${String(finalScore).padStart(5)} (DataLab ${datalabScores?.totalScore ?? 'n/a'}, Google fallback ${fallbackScore})`
  );

  const mentions = Number.isFinite(datalabScores?.weeklySearchVolume)
    ? Math.round(datalabScores.weeklySearchVolume)
    : Math.max(googleArticles.length * 100, fallbackScore);

  const evaluation = {
    source: 'naver_datalab_search',
    query: keyword,
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

  if (googleArticles.length) {
    evaluation.google_trends = {
      matches: googleArticles.length,
      article_sample: topHeadlines,
    };
  }

  const result = {
    term: keyword,
    term_ko: keyword,
    significance_score: finalScore,
    mentions,
    evaluation,
    search: buildTrendLinks(keyword),
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

function computeTrendScoreFromSeries(series) {
  const values = Array.isArray(series)
    ? series
        .map((entry) => {
          const raw = entry?.ratio ?? entry?.value ?? entry?.searches;
          const numeric = Number(raw);
          return Number.isFinite(numeric) ? numeric : null;
        })
        .filter((value) => value !== null)
    : [];

  if (!values.length) {
    return null;
  }

  const last = values[values.length - 1];
  const prev = values.length > 1 ? values[values.length - 2] : last;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const peak = values.reduce((max, value) => (value > max ? value : max), values[0]);

  const momentum = last - prev;
  const deviation = last - avg;
  const normalizedPeak = peak > 0 ? last / peak : 0;
  const score = last * 0.6 + momentum * 0.3 + deviation * 0.1 + normalizedPeak * 10;

  return {
    score,
    last,
    momentum,
    deviation,
    normalizedPeak,
  };
}

async function fetchTrendingKeywordsFromNaver({ limit = SAMPLE_SIZE, sampleSize } = {}) {
  const effectiveLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), SAMPLE_SIZE * 2) : SAMPLE_SIZE;
  const effectiveSampleSize = Number.isFinite(sampleSize) && sampleSize > 0
    ? Math.max(Math.floor(sampleSize), effectiveLimit)
    : Math.max(effectiveLimit * 3, 30);

  let fallbackKeywordPool;
  try {
    fallbackKeywordPool = loadFinanceKeywords();
  } catch (err) {
    console.warn(`⚠️  Unable to load finance keywords for NAVER trend seeding: ${err.message}`);
    return [];
  }

  if (!Array.isArray(fallbackKeywordPool) || !fallbackKeywordPool.length) {
    console.warn('⚠️  Finance keyword list is empty; skipping NAVER trend seeding.');
    return [];
  }

  const samplePool = shuffleSample(fallbackKeywordPool, effectiveSampleSize);
  if (!samplePool.length) {
    return [];
  }

  console.log(`📈 Probing NAVER DataLab for trending keywords using ${samplePool.length} samples…`);
  const { startDate, endDate } = last24hDatesKST();
  const batches = chunkArray(samplePool, NAVER_TREND_MAX_KEYWORDS_PER_REQUEST);
  const candidateScores = [];

  for (const batch of batches) {
    const payload = {
      startDate,
      endDate,
      timeUnit: 'date',
      keywordGroups: batch.map((keyword) => ({ groupName: keyword, keywords: [keyword] })),
    };

    try {
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
        console.warn(
          `⚠️  NAVER DataLab trend seed request failed (${res.status}): ${text.slice(0, 120)}`,
        );
      } else {
        const json = await res.json();
        const results = Array.isArray(json?.results) ? json.results : [];
        for (const item of results) {
          const keyword = item?.title || batch[0];
          const scoreInfo = computeTrendScoreFromSeries(item?.data);
          if (!scoreInfo) continue;
          candidateScores.push({
            keyword,
            score: scoreInfo.score,
            lastValue: scoreInfo.last,
          });
        }
      }
    } catch (err) {
      console.warn(`⚠️  Failed to fetch NAVER trend seeds for [${batch.join(', ')}]: ${err.message}`);
    }

    if (batches.length > 1) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  if (!candidateScores.length) {
    console.warn('⚠️  No trending keywords retrieved from NAVER DataLab.');
    return [];
  }

  candidateScores.sort((a, b) => {
    if (!Number.isFinite(b.score) && !Number.isFinite(a.score)) return 0;
    if (!Number.isFinite(b.score)) return -1;
    if (!Number.isFinite(a.score)) return 1;
    if (b.score === a.score) {
      return (b.lastValue || 0) - (a.lastValue || 0);
    }
    return b.score - a.score;
  });

  const orderedKeywords = candidateScores.map((entry) => entry.keyword);
  const sanitized = sanitizeKeywordList(orderedKeywords).slice(0, effectiveLimit);

  if (!sanitized.length) {
    return [];
  }

  console.log(`📈 NAVER DataLab provided ${sanitized.length} trending keyword candidates.`);
  return sanitized;
}

async function topOffKeywordsWithDataLab(keywords, desiredCount = SAMPLE_SIZE) {
  const sanitizedBase = sanitizeKeywordList(Array.isArray(keywords) ? keywords : []);
  const target =
    Number.isFinite(desiredCount) && desiredCount > 0 ? Math.floor(desiredCount) : SAMPLE_SIZE;
  const cappedBase = sanitizedBase.slice(0, target);

  if (cappedBase.length >= target) {
    return { keywords: cappedBase, added: [] };
  }

  let datalabCandidates = [];
  try {
    datalabCandidates = await fetchTrendingKeywordsFromNaver({
      limit: Math.max(target * 2, SAMPLE_SIZE),
    });
  } catch (err) {
    console.warn(`⚠️  Unable to retrieve NAVER DataLab candidates for top-off: ${err.message}`);
  }

  if (!datalabCandidates.length) {
    return { keywords: cappedBase, added: [] };
  }

  const missing = target - cappedBase.length;
  const existing = new Set(cappedBase);
  const additions = [];

  for (const candidate of datalabCandidates) {
    if (existing.has(candidate)) continue;
    additions.push(candidate);
    existing.add(candidate);
    if (additions.length >= missing) {
      break;
    }
  }

  if (!additions.length) {
    return { keywords: cappedBase, added: [] };
  }

  const combined = sanitizeKeywordList([...cappedBase, ...additions]).slice(0, target);

  return { keywords: combined, added: additions.slice(0, missing) };
}

async function trimKeywordsWithCerebras(keywords, { maxWords = 2, limit } = {}) {
  const baseList = sanitizeKeywordList(Array.isArray(keywords) ? keywords : []);
  if (!baseList.length) {
    return [];
  }

  const effectiveLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), baseList.length) : baseList.length;
  const truncated = baseList.map((kw) => limitWords(kw, maxWords));

  if (!CEREBRAS_API_KEY) {
    console.warn('⚠️  CEREBRAS_API_KEY is not configured. Returning locally trimmed keywords.');
    return truncated.slice(0, effectiveLimit);
  }

  console.log(`✂️  Trimming ${effectiveLimit} NAVER trending keywords with Cerebras (≤${maxWords} words)…`);

  const prompt = [
    `You will receive a JSON array of trending keywords.`,
    `Rewrite each keyword so it contains between 2 and ${maxWords} words, adding a vivid descriptor (event, timeframe, reaction, etc.) to keep it specific while preserving the original language.`,
    `Avoid generic phrases like "시장 동향" or "market news" without a concrete subject.`,
    `Return ONLY a JSON array of ${effectiveLimit} trimmed keywords in the same order. No explanations, numbering, or code fences.`,
    `Keywords: ${JSON.stringify(truncated.slice(0, effectiveLimit))}`,
  ].join(' ');

  const trimmed = await fetchCerebrasKeywords({
    desiredCount: effectiveLimit,
    prompt,
    allowAutoTruncate: false,
  });
  const cleaned = sanitizeKeywordList((trimmed.length ? trimmed : truncated).map((kw) => limitWords(kw, maxWords)));

  if (!cleaned.length) {
    return truncated.slice(0, effectiveLimit);
  }

  return cleaned.slice(0, effectiveLimit);
}

async function buildTags() {
  console.log('🚀 Generating data/tags.json with viral trending keywords');
  console.log(`🕐 Execution time: ${new Date().toISOString()}`);
  console.log(`🎲 Random seed check: ${Math.random()}`);

  const llmSeedResult = await fetchLLMKeywords({ desiredCount: SAMPLE_SIZE });
  let sampled = sanitizeKeywordList(llmSeedResult?.keywords || []);
  let keywordCollectionMethod = llmSeedResult?.method || 'llm_seeded';
  const windowMetadata = llmSeedResult?.windowMetadata;
  let datalabTopOffKeywords = [];
  let financeTopOffKeywords = [];

  if (sampled.length < SAMPLE_SIZE) {
    const { keywords: toppedOff, added } = await topOffKeywordsWithDataLab(sampled, SAMPLE_SIZE);
    if (added.length) {
      console.log(
        `📈 Filled ${added.length} missing keywords from NAVER DataLab trending candidates to reach ${
          toppedOff.length
        } entries.`,
      );
      sampled = toppedOff;
      datalabTopOffKeywords = added;
    }
  }

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
    keywordCollectionMethod = 'finance_keywords_random_sample';
  } else if (sampled.length < SAMPLE_SIZE) {
    try {
      const fallbackKeywordPool = loadFinanceKeywords();
      const missing = SAMPLE_SIZE - sampled.length;
      const existing = new Set(sampled);
      const additions = [];
      for (const candidate of fallbackKeywordPool) {
        if (existing.has(candidate)) continue;
        additions.push(candidate);
        existing.add(candidate);
        if (additions.length >= missing) break;
      }
      if (additions.length) {
        sampled = sanitizeKeywordList([...sampled, ...additions]).slice(0, SAMPLE_SIZE);
        financeTopOffKeywords = additions.slice(0, missing);
        console.log(
          `📥 Added ${financeTopOffKeywords.length} fallback finance keywords to reach ${sampled.length}.`,
        );
      }
    } catch (err) {
      console.warn(`⚠️  Unable to load finance keywords for fallback: ${err.message}`);
    }
  }

  sampled = sampled.slice(0, SAMPLE_SIZE);

  if (!sampled.length) {
    throw new Error('Unable to obtain any keywords for evaluation.');
  }

  const methodDescriptionMap = {
    google_trends_window: 'Google Trends 24h viral pipeline',
    naver_datalab_trending_seeded: 'NAVER DataLab trending feed',
    llm_seeded: 'tinyllama worker',
    finance_keywords_random_sample: 'finance_keywords.json fallback',
  };

  const methodDescription = methodDescriptionMap[keywordCollectionMethod] || keywordCollectionMethod;
  console.log(`🎯 Selected ${sampled.length} keywords for evaluation (${methodDescription}).`);

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
          source: 'evaluation_error',
          query: keyword,
          error: err.message,
        },
        search: buildTrendLinks(keyword),
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

  evaluated.sort((a, b) => b.significance_score - a.significance_score);

  const uniqueEvaluated = [];
  const similarDiscarded = [];
  const seenNormalizations = new Set();

  for (const item of evaluated) {
    const itemNormalized = normalizeForComparison(item.term_ko || item.term);

    if (seenNormalizations.has(itemNormalized)) {
      similarDiscarded.push({ kept: null, dropped: item, reason: 'exact_match' });
      continue;
    }

    const duplicate = uniqueEvaluated.find((existing) => {
      return areStringsSimilar(existing.term_ko || existing.term, item.term_ko || item.term) ||
             areStringsSimilar(existing.term, item.term);
    });

    if (duplicate) {
      similarDiscarded.push({ kept: duplicate, dropped: item, reason: 'similar' });
      continue;
    }

    const specificityScore = calculateSpecificityScore(item.term_ko || item.term);
    if (specificityScore < 50) {
      similarDiscarded.push({ kept: null, dropped: item, reason: 'too_generic' });
      continue;
    }

    seenNormalizations.add(itemNormalized);
    uniqueEvaluated.push(item);
  }

  if (similarDiscarded.length) {
    console.log(`\n🧮 Removed ${similarDiscarded.length} keywords after deduplication and specificity filtering.`);

    const reasonCounts = {
      exact_match: 0,
      similar: 0,
      too_generic: 0,
    };

    for (const { reason } of similarDiscarded) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }

    console.log(`   📊 Removal breakdown:`);
    console.log(`      - Exact matches: ${reasonCounts.exact_match}`);
    console.log(`      - Similar keywords: ${reasonCounts.similar}`);
    console.log(`      - Too generic: ${reasonCounts.too_generic}`);

    console.log(`\n   🔍 Examples of removed keywords:`);
    for (const { kept, dropped, reason } of similarDiscarded.slice(0, 5)) {
      if (reason === 'too_generic') {
        console.log(
          `   ↳ Dropped "${dropped.term_ko || dropped.term}" (score ${dropped.significance_score}) - ${reason}`
        );
      } else if (kept) {
        console.log(
          `   ↳ Dropped "${dropped.term_ko || dropped.term}" (score ${dropped.significance_score}) in favor of "${kept.term_ko || kept.term}" (score ${kept.significance_score}) - ${reason}`
        );
      } else {
        console.log(
          `   ↳ Dropped "${dropped.term_ko || dropped.term}" (score ${dropped.significance_score}) - ${reason}`
        );
      }
    }
    if (similarDiscarded.length > 5) {
      console.log(`   …and ${similarDiscarded.length - 5} more.`);
    }
  }

  const now = new Date();
  const fallbackKeywordSource = path.relative(process.cwd(), FINANCE_KEYWORDS_PATH);
  const { startDate: trendStart, endDate: trendEnd } = last24hDatesKST();
  let keywordSource;
  if (keywordCollectionMethod === 'llm_seeded') {
    keywordSource = LLM_WORKER_URL;
  } else if (keywordCollectionMethod === 'naver_datalab_trending_seeded') {
    keywordSource = `NAVER DataLab ${trendStart}→${trendEnd}`;
  } else if (keywordCollectionMethod === 'google_trends_window') {
    const windowRange = windowMetadata?.window
      ? `${windowMetadata.window.since}→${windowMetadata.window.now}`
      : `${trendStart}→${trendEnd}`;
    keywordSource = `Google Trends 24h viral window ${windowRange} (Cerebras ${CEREBRAS_MODEL})`;
  } else {
    keywordSource = fallbackKeywordSource;
  }

  const metadata = {
    collection_method: keywordCollectionMethod,
    sample_size: SAMPLE_SIZE,
    generated_at: now.toISOString(),
    keyword_limit: SAMPLE_SIZE,
    lookback_hours: 12,
    keyword_source: keywordSource,
    fallback_keyword_source: fallbackKeywordSource,
    similar_keywords_removed: similarDiscarded.length,
    removal_breakdown: {
      exact_match: similarDiscarded.filter((d) => d.reason === 'exact_match').length,
      similar: similarDiscarded.filter((d) => d.reason === 'similar').length,
      too_generic: similarDiscarded.filter((d) => d.reason === 'too_generic').length,
    },
  };

  if (keywordCollectionMethod === 'llm_seeded') {
    metadata.llm_model = LLM_MODEL;
    metadata.llm_keywords_requested = SAMPLE_SIZE;
  }

  if (keywordCollectionMethod === 'google_trends_window') {
    metadata.llm_model = CEREBRAS_MODEL;
    metadata.llm_keywords_requested = SAMPLE_SIZE;
    if (windowMetadata) {
      metadata.window_trending = {
        window: windowMetadata.window,
        hours: windowMetadata.hours,
        baseline_days: windowMetadata.baselineDays,
        candidate_count: windowMetadata.candidateCount,
        topics: windowMetadata.topics,
      };
    }
  }

  if (datalabTopOffKeywords.length) {
    metadata.datalab_top_off = {
      added: datalabTopOffKeywords.length,
      keywords: datalabTopOffKeywords,
    };
  }

  if (financeTopOffKeywords.length) {
    metadata.finance_fallback_top_off = {
      added: financeTopOffKeywords.length,
      keywords: financeTopOffKeywords,
    };
  }

  const result = {
    date: now.toISOString().split('T')[0],
    window: WINDOW_LABEL,
    total_phrases: uniqueEvaluated.length,
    discovered_keywords: uniqueEvaluated,
    metadata,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(`\n✅ Saved ${uniqueEvaluated.length} viral trending keywords to ${OUTPUT_PATH}`);

  console.log(`\n🔥 Top 10 viral keywords by significance score:`);
  uniqueEvaluated.slice(0, 10).forEach((item, idx) => {
    const specificityScore = calculateSpecificityScore(item.term_ko || item.term);
    console.log(`   ${idx + 1}. ${(item.term_ko || item.term).padEnd(25)} (score: ${item.significance_score}, specificity: ${specificityScore.toFixed(0)})`);
  });
}

if (require.main === module) {
  buildTags().catch((err) => {
    console.error('❌ Generation failed:', err);
    process.exitCode = 1;
  });
}

module.exports = { buildTags };

