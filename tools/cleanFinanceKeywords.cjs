#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.resolve(__dirname, '../data/finance_keywords.json');
const LEGACY_PATH = path.resolve(__dirname, '../stocks/data/finance_keywords_old.json');

const bannedKeywords = new Set([
  '감자',
  '가까이',
  '가깝다',
  '가늠',
  '가능',
  '가능성',
  '가능할까',
  '가로막힌',
  '가리는',
  '가뭄',
  '가부좌',
  '가시권',
  '가시밭길',
  '가시적',
  '가압',
  '가열',
  '가운데',
  'organ',
  'jump',
  'ordinary',
  'Scale',
  'MY',
  'TV',
  'IT',
  'potato',
  '본문 바로가기',
  '메뉴 바로가기',
  '뉴스',
  '관련 서비스',
  '연예',
  '스포츠',
  '날씨',
  '메인메뉴',
  '기후/환경',
  '사회',
  '경제',
  '정치',
  '국제',
  '문화',
  '생활',
  'IT/과학',
  '인물',
  '지식/칼럼',
  '연재',
  '경제홈 하위메뉴',
  '경제홈',
  '연금/노후',
  '취업/고용',
  '소비자',
  '벤처/스타트업',
  '국제경제',
  '경제 주요뉴스',
]);

const englishStopwords = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'in',
  'is',
  'it',
  'its',
  'my',
  'of',
  'on',
  'or',
  'our',
  'scale',
  'organ',
  'jump',
  'ordinary',
  'tv',
  'the',
  'their',
  'this',
  'to',
  'was',
  'will',
]);

const disallowedPatterns = [
  /@/,
  /\\\\/, // stray backslash
  /\"/,
  /`/,
  /[<>]/,
  /\?/, // remove interrogative keywords
  /…/,
  /\.\.\./,
  /\n/,
  /\uFFFD/,
];

const bannedSubstrings = [
  '홈 화면',
  '화면 스타일',
  '음성검색',
  '뉴스홈',
  '매일 경제',
  '매일경제',
  '매경',
  'MK ',
  'MK\n',
  'MK-',
  'Pulse',
  '스타투데이',
  '매경게임진',
  '빌리어드뉴스',
  '미라클아이',
  '매경여행',
  'MK여행',
  '프리미엄 콘텐츠',
  '위클리연재',
  '오늘의 매경',
  'AI 오디오 뉴스',
  '뉴스레터',
  'YouTube',
  '핵심 요약쏙',
  '미디어그룹',
  '매일경제TV',
  '매경이코노미',
  '매경 LUXMEN',
  '시티라이프',
  '매경GOLF',
  '세계지식포럼',
  'M-Print',
  'KDX한국데이터거래소',
  '매경출판',
  '시사 경제 용어',
  '매경TEST',
  'M PLAY',
  'MK멤버십',
  '구독신청',
  'e신문',
  '모바일 앱',
  '모바일 쿠폰',
  'MK Frame',
  '미라클랩',
  'MK 장례',
  'MK 운세',
  '와글와글',
  'AI GAMES',
  '회사소개',
  '광고안내',
  '인재채용',
  '독자의견',
  '서비스문의',
  '경제 많이 본 기사',
  '최신뉴스',
  '바로가기',
  '공지',
  '로그인',
  '주요채널',
  '이용약관',
  '개인정보',
  'PC버전',
  '포토',
  'ZUM',
  'Special Edition',
  '전문뉴스',
  '스타투데이',
  '매경게임진',
  'MK MALL',
  'MK빌리어드뉴스',
  'MK위클리연재',
  '매경엠플러스',
  'MK AI',
  '매경 LUX',
  '디그(dig)',
  'Pulse',
];

function normalizeEnglishWord(word) {
  return word.replace(/[^a-z]/gi, '').toLowerCase();
}

function containsHangul(value) {
  return /[가-힣]/.test(value);
}

function hasInvalidCharacters(value) {
  return disallowedPatterns.some((pattern) => pattern.test(value));
}

function isMostlyPunctuation(value) {
  const stripped = value.replace(/[\p{L}\p{N}\s]/gu, '');
  return stripped.length > value.length / 2;
}

function isLikelyEnglishFinanceKeyword(keyword) {
  if (typeof keyword !== 'string') return false;

  const trimmed = keyword.trim();
  if (!trimmed) return false;
  if (bannedKeywords.has(trimmed)) return false;
  if (bannedSubstrings.some((snippet) => trimmed.includes(snippet))) return false;
  if (trimmed.length > 60) return false;
  if (hasInvalidCharacters(trimmed)) return false;
  if (/https?:\/\//i.test(trimmed)) return false;
  if (/^[0-9\-.,]+$/.test(trimmed)) return false;
  if (isMostlyPunctuation(trimmed)) return false;

  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount > 5) return false;

  const containsLatin = /[a-zA-Z]/.test(trimmed);
  if (!containsLatin) return false;
  if (containsHangul(trimmed)) return false;

  const englishWords = trimmed
    .split(/\s+/)
    .map(normalizeEnglishWord)
    .filter(Boolean);

  if (!englishWords.length) return false;

  const allStopwords = englishWords.every((word) => englishStopwords.has(word));
  if (allStopwords) return false;

  const hasMeaningfulLength = englishWords.some((word) => word.length >= 3);
  if (!hasMeaningfulLength) {
    const specials = ['ai', 'etf', 'ipo', 'esg', 'gdp', 'cpi'];
    if (!specials.some((term) => englishWords.includes(term))) {
      const alphaNumeric = trimmed.toLowerCase();
      if (!/^[0-9]*[a-z][0-9a-z]*$/.test(alphaNumeric)) {
        return false;
      }
    }
  }

  return true;
}

function loadLegacyKeywords() {
  const legacyRaw = JSON.parse(fs.readFileSync(LEGACY_PATH, 'utf8'));
  const legacyKeywords = Array.isArray(legacyRaw.finance_keywords) ? legacyRaw.finance_keywords : [];
  const ordered = [];
  const seen = new Set();

  for (const keyword of legacyKeywords) {
    const trimmed = typeof keyword === 'string' ? keyword.trim() : '';
    if (!trimmed) continue;
    if (bannedKeywords.has(trimmed)) continue;

    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) continue;

    ordered.push(trimmed);
    seen.add(normalized);
  }

  return { ordered, seen };
}

function cleanFinanceKeywords() {
  const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const originalKeywords = Array.isArray(raw.finance_keywords) ? raw.finance_keywords : [];
  const translationMap = raw.finance_keywords_en && typeof raw.finance_keywords_en === 'object'
    ? raw.finance_keywords_en
    : {};

  const { ordered: baseKeywords, seen } = loadLegacyKeywords();
  const extras = [];
  const skipped = [];

  for (const keyword of originalKeywords) {
    const trimmed = typeof keyword === 'string' ? keyword.trim() : '';
    if (!trimmed || bannedKeywords.has(trimmed)) {
      continue;
    }

    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    if (containsHangul(trimmed)) {
      skipped.push(trimmed);
      continue;
    }

    if (!isLikelyEnglishFinanceKeyword(trimmed)) {
      skipped.push(trimmed);
      continue;
    }

    extras.push(trimmed);
    seen.add(normalized);
  }

  const finalKeywords = [...baseKeywords, ...extras];

  const cleanedTranslations = {};
  for (const [key, value] of Object.entries(translationMap)) {
    const trimmedKey = typeof key === 'string' ? key.trim() : '';
    if (!trimmedKey) {
      continue;
    }
    if (!seen.has(trimmedKey.toLowerCase())) {
      continue;
    }
    if (typeof value === 'string' && value.trim()) {
      cleanedTranslations[trimmedKey] = value;
    }
  }

  raw.finance_keywords = finalKeywords;
  raw.finance_keywords_en = cleanedTranslations;

  fs.writeFileSync(DATA_PATH, JSON.stringify(raw, null, 2));

  console.log(`Legacy keywords retained: ${baseKeywords.length}`);
  console.log(`Additional English keywords kept: ${extras.length}`);
  console.log(`Final keyword count: ${finalKeywords.length}`);
  console.log(`Skipped keywords: ${skipped.length}`);

  if (extras.length) {
    console.log('\nSample English keywords kept:');
    console.log(extras.slice(0, 20).join(', '));
  }

  if (skipped.length) {
    console.log('\nSample keywords removed:');
    console.log(skipped.slice(0, 20).join(', '));
  }
}

if (require.main === module) {
  cleanFinanceKeywords();
}

module.exports = { cleanFinanceKeywords, isLikelyEnglishFinanceKeyword };
