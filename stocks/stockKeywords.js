import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { parse } from 'node-html-parser';
import { fileURLToPath } from 'url';
import natural from 'natural';
import sw from 'stopword';
import pos from 'pos';

const defaultHeaders = {
  'User-Agent': 'stock-recs/1.1 (+ci)',
  'Accept': 'application/json,text/*;q=0.9,*/*;q=0.8',
  'Accept-Encoding': 'gzip,deflate',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SKIP_NAVER = process.env.SKIP_NAVER === '1';
const DEEPL_API_KEY = (process.env.DEEPL_API_KEY || '').trim();
const DEEPL_API_URL = (process.env.DEEPL_API_URL || '').trim();
const NAVER_CLIENT_ID = (process.env.NAVER_CLIENT_ID || '').trim();
const NAVER_CLIENT_SECRET = (process.env.NAVER_CLIENT_SECRET || '').trim();
const PYTHON_BIN = (process.env.PYTHON_BIN || process.env.PYTHON || 'python3').trim();
const KRWORDRANK_TIMEOUT_MS = Number(process.env.KRWORDRANK_TIMEOUT_MS || 20000);
const KRWORDRANK_SCRIPT = path.join(__dirname, '..', 'tools', 'krwordrank_fetcher.py');

const KEYWORD_MARKET_QUERIES = [
  { market: 'KOSPI', queries: ['코스피', 'KOSPI index', 'KOSPI market trend'], locales: ['ko', 'en'] },
  { market: 'KOSDAQ', queries: ['코스닥', 'KOSDAQ', 'KOSDAQ market outlook'], locales: ['ko', 'en'] },
  { market: 'NASDAQ 100', queries: ['NASDAQ 100', 'Nasdaq 100 technology stocks'], locales: ['en'] },
  { market: 'S&P 500', queries: ['S&P 500', 'S&P500 economy', '미국 증시 S&P500'], locales: ['en', 'ko'] }
];

const TAG_OUTPUT_FILE = process.env.MARKET_TAG_FILE || 'tags.json';
const KEYWORD_OUTPUT_FILE = process.env.MARKET_KEYWORD_FILE || TAG_OUTPUT_FILE;
const TAG_TIMEZONE = process.env.TAG_TIMEZONE || 'Asia/Seoul';
const TAG_COLLECTION_WINDOW_DAYS = Number(process.env.TAG_COLLECTION_LOOKBACK_DAYS || 14);
const TAG_COLLECTION_PAGE_LIMIT = Number(process.env.TAG_COLLECTION_PAGE_LIMIT || 5);
const TAG_COLLECTION_PAGE_SIZE = Number(process.env.TAG_COLLECTION_PAGE_SIZE || 40);
const TAG_RECENCY_LOOKBACK_HOURS = Math.max(TAG_COLLECTION_WINDOW_DAYS || 0, 1) * 24;
const ENGLISH_TAG_REGEX = /^[A-Za-z0-9][A-Za-z0-9\-\s&()/.,']{1,60}$/;
const TAG_STOPWORD_PHRASES = new Set([
  'nasdaq', 'nasdaq 100', '100', '200', '300', '400', '500', 'to'
]);
const TAG_STOPWORD_TOKENS = new Set([
  'nasdaq', 'dow', 'jones', 'sp', 's', 'p', 'index', 'indices', 'market', 'markets',
  '100', '200', '300', '400', '500', '600', '700', '800', '900', '1000',
  'the', 'and', 'or', 'for', 'of', 'in', 'on', 'at', 'by', 'from', 'with', 'without',
  'to', 'vs', 'vs.', 'a', 'an', 'per', 'amid'
]);

const TAG_KO_DICTIONARY = new Map(Object.entries({
  'ai': '인공지능',
  'artificial intelligence': '인공지능',
  'battery': '배터리',
  'batteries': '배터리',
  'battery materials': '배터리 소재',
  'blockchain': '블록체인',
  'cloud computing': '클라우드 컴퓨팅',
  'consumer spending': '소비 지출',
  'cryptocurrency': '암호화폐',
  'currency': '통화',
  'digital transformation': '디지털 전환',
  'electric vehicle': '전기차',
  'electric vehicles': '전기차',
  'energy transition': '에너지 전환',
  'energy': '에너지',
  'exports': '수출',
  'federal reserve': '미 연준',
  'financial markets': '금융 시장',
  'finance': '금융',
  'foreign exchange': '외환',
  'gdp': '국내총생산',
  'green energy': '친환경 에너지',
  'healthcare': '헬스케어',
  'inflation': '인플레이션',
  'interest rate': '금리',
  'interest rates': '금리',
  'ipo': '기업공개',
  'logistics': '물류',
  'machine learning': '머신러닝',
  'manufacturing': '제조업',
  'mergers and acquisitions': '인수합병',
  'monetary policy': '통화 정책',
  'nasdaq': '나스닥',
  'oil prices': '유가',
  'private equity': '사모펀드',
  'renewable energy': '재생 에너지',
  'recession': '경기침체',
  'semiconductor': '반도체',
  'semiconductors': '반도체',
  'shipping': '해운',
  'supply chain': '공급망',
  'supply chains': '공급망',
  'supply shortage': '공급 부족',
  'stock market': '증시',
  'tech stocks': '기술주',
  'trade balance': '무역수지',
  'venture capital': '벤처 투자'
}));

const EIEC_TREND_URL = 'https://eiec.kdi.re.kr/bigdata/issueTrend.do?cat=%EC%A0%84%EC%B2%B4';
const INVEST_ZUM_URL = 'https://invest.zum.com/';

const DEFAULT_DATALAB_KEYWORD_QUERY = '주식';
const DATALAB_KEYWORD_QUERY = (process.env.DATALAB_KEYWORD_QUERY || DEFAULT_DATALAB_KEYWORD_QUERY).trim() || DEFAULT_DATALAB_KEYWORD_QUERY;
const DATALAB_KEYWORD_COUNT = Number(process.env.DATALAB_KEYWORD_COUNT || 50);
const HANGUL_REGEX = /[\u3131-\u318E\uAC00-\uD7A3]/;

const TAG_CREDIT_FILE = process.env.MARKET_TAG_CREDIT_FILE
  ? path.resolve(process.env.MARKET_TAG_CREDIT_FILE)
  : path.join(__dirname, 'data', 'tags-credit.json');
const TAG_CREDIT_DECAY = Math.min(Math.max(Number(process.env.TAG_CREDIT_DECAY || 0.9), 0), 0.999);
const TAG_CREDIT_REWARD = Math.max(Number(process.env.TAG_CREDIT_REWARD || 1), 0);
const TAG_CREDIT_CAP = Math.max(Number(process.env.TAG_CREDIT_CAP || 6), 0);
const TAG_CREDIT_WEIGHT = Math.max(Number(process.env.TAG_CREDIT_WEIGHT || 0.12), 0);
const TAG_CREDIT_MAX_BOOST = Math.max(Number(process.env.TAG_CREDIT_MAX_BOOST || 0.6), 0);
const FINANCE_KEYWORDS_FILE = path.join(__dirname, 'data', 'finance_keywords.json');

async function runExtractKeywords({ tagsPath = null } = {}) {
  const scriptPath = path.join(__dirname, 'extractKeywords.js');
  const env = { ...process.env };
  if (tagsPath) {
    env.MARKET_TAG_FILE = tagsPath;
  }

  await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [scriptPath], {
      stdio: 'inherit',
      env,
    });

    proc.on('error', reject);
    proc.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        const reason =
          code !== null
            ? new Error(`extractKeywords exited with code ${code}`)
            : new Error(`extractKeywords exited due to signal ${signal}`);
        reject(reason);
      }
    });
  });
}

function ensureDirFor(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {}
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function loadRawTagCredit() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TAG_CREDIT_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      const terms = parsed.terms && typeof parsed.terms === 'object' ? parsed.terms : {};
      return {
        terms,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      };
    }
  } catch {}
  return { terms: {}, updatedAt: null };
}

let TAG_CREDIT_STATE = null;

function loadTagCreditState() {
  if (TAG_CREDIT_STATE) return TAG_CREDIT_STATE;
  TAG_CREDIT_STATE = loadRawTagCredit();
  return TAG_CREDIT_STATE;
}

function getTagCreditValue(termKo) {
  if (!termKo) return 0;
  const key = normalizeKoKeywordTerm(termKo).toLowerCase();
  if (!key) return 0;
  const state = loadTagCreditState();
  const value = Number(state.terms[key]);
  return Number.isFinite(value) ? Math.max(value, 0) : 0;
}

async function saveTagCreditState(state) {
  const snapshot = state || loadTagCreditState();
  ensureDirFor(TAG_CREDIT_FILE);
  await fsp.writeFile(TAG_CREDIT_FILE, JSON.stringify(snapshot, null, 2));
}

async function applyTagCreditFromSnapshot(snapshot, { decay = TAG_CREDIT_DECAY, reward = TAG_CREDIT_REWARD } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return false;

  const keywords = Array.isArray(snapshot.discovered_keywords)
    ? snapshot.discovered_keywords
    : Array.isArray(snapshot.keywords)
      ? snapshot.keywords
      : [];

  if (!keywords.length) return false;

  const state = loadTagCreditState();
  const entries = { ...state.terms };
  const clampedDecay = Number.isFinite(decay) ? Math.min(Math.max(decay, 0), 0.999) : TAG_CREDIT_DECAY;
  const clampedReward = Number.isFinite(reward) ? Math.max(reward, 0) : TAG_CREDIT_REWARD;

  for (const key of Object.keys(entries)) {
    const decayed = entries[key] * clampedDecay;
    if (decayed < 0.01) delete entries[key];
    else entries[key] = decayed;
  }

  let applied = 0;
  for (const keyword of keywords) {
    const termKo = normalizeKoKeywordTerm(keyword.term_ko || keyword.term || '');
    if (!termKo) continue;
    const lower = termKo.toLowerCase();
    const current = Number(entries[lower]) || 0;
    const next = Math.min(current + clampedReward, TAG_CREDIT_CAP);
    entries[lower] = next;
    applied += 1;
  }

  state.terms = entries;
  state.updatedAt = new Date().toISOString();
  TAG_CREDIT_STATE = state;
  await saveTagCreditState(state);
  console.log(`[learning] updated tag credit for ${applied} keywords (decay=${clampedDecay}, reward=${clampedReward})`);
  return true;
}

function iso(date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
}

async function naverSearch({ query, NAVER_ID, NAVER_SECRET }) {
  if (SKIP_NAVER) return { items: [] };
  const id = (NAVER_ID || NAVER_CLIENT_ID || '').trim();
  const secret = (NAVER_SECRET || NAVER_CLIENT_SECRET || '').trim();
  if (!id || !secret || !query) return { items: [] };

  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=20&sort=date`;
  const headers = {
    ...defaultHeaders,
    'X-Naver-Client-Id': id,
    'X-Naver-Client-Secret': secret,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data && typeof data === 'object') {
        return data;
      }
    } catch (err) {
      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  return { items: [] };
}

const FINANCE_TREND_KEYWORD_GROUPS = [
  { category: 'Stock Market', keywords: ['주식', '코스피', '코스닥', '주가'] },
  { category: 'Economy', keywords: ['환율', '금리', '경제 전망', 'GDP'] },
  { category: 'Business', keywords: ['삼성전자', '현대자동차', '네이버', '카카오'] },
  { category: 'Finance', keywords: ['비트코인', 'ETF', '채권', '펀드'] }
];

const DATALAB_FALLBACK_KEYWORDS = [
  {
    text: { ko: 'AI 반도체 투자', en: 'AI semiconductor investment' },
    datalabKeyword: 'AI 반도체 투자',
    markets: ['KOSPI', 'NASDAQ 100'],
    articleQueries: [
      { query: 'AI 반도체 투자', locales: ['ko'] }
      // EN 쿼리 제거하여 API 호출 절반으로
    ]
  },
  {
    text: { ko: '반도체 공급망', en: 'Semiconductor supply chain' },
    datalabKeyword: '반도체 공급망',
    markets: ['NASDAQ 100', 'S&P 500'],
    articleQueries: [
      { query: '반도체 공급망', locales: ['ko'] }
    ]
  },
  {
    text: { ko: '원달러 환율', en: 'KRW USD stability' },
    datalabKeyword: '원달러 환율',
    markets: ['KOSPI'],
    articleQueries: [
      { query: '원달러 환율', locales: ['ko'] }
    ]
  },
  {
    text: { ko: '2차전지 소재', en: 'Battery materials demand' },
    datalabKeyword: '2차전지 소재',
    markets: ['KOSDAQ'],
    articleQueries: [
      { query: '2차전지 소재', locales: ['ko'] }
    ]
  },
  {
    text: { ko: '바이오 헬스케어', en: 'Bio healthcare innovation' },
    datalabKeyword: '바이오 헬스케어',
    markets: ['KOSDAQ', 'NASDAQ 100'],
    articleQueries: [
      { query: '바이오 헬스케어', locales: ['ko'] }
    ]
  },
  {
    text: { ko: '미 연준 금리', en: 'US Fed rate' },
    datalabKeyword: '미 연준 금리',
    markets: ['S&P 500'],
    articleQueries: [
      { query: '미 연준 금리', locales: ['ko'] }
    ]
  },
  // 나머지 4개는 조건부로만 사용
  {
    text: { ko: '친환경 에너지', en: 'Green energy transition' },
    datalabKeyword: '친환경 에너지',
    markets: ['KOSDAQ', 'S&P 500'],
    articleQueries: [
      { query: '친환경 에너지', locales: ['ko'] }
    ]
  },
  {
    text: { ko: 'IT 서비스 업황', en: 'IT services outlook' },
    datalabKeyword: 'IT 서비스 업황',
    markets: ['KOSPI', 'S&P 500'],
    articleQueries: [
      { query: 'IT 서비스 업황', locales: ['ko'] }
    ]
  },
  {
    text: { ko: '미국 CPI', en: 'US CPI outlook' },
    datalabKeyword: '미국 CPI',
    markets: ['S&P 500'],
    articleQueries: [
      { query: '미국 CPI', locales: ['ko'] }
    ]
  },
  {
    text: { ko: '환율 변동성', en: 'FX volatility' },
    datalabKeyword: '환율 변동성',
    markets: ['KOSPI'],
    articleQueries: [
      { query: '환율 변동성', locales: ['ko'] }
    ]
  }
];

const STOPWORDS_EN = new Set([
  'the','and','for','with','from','that','this','have','has','into','over','under','after','before','will','would','could','should',
  'market','markets','stock','stocks','index','indices','latest','today','news','report','reports','analysis','update','updates',
  'price','prices','data','economic','economy','global','investors','fund','funds','company','companies','trend','trends','focus',
  'seoul','exchange','korea','south','north','gains','losses','falls','rise','boost','indexes','futures','trading'
]);

const STOPWORDS_KO = new Set([
  '및','그리고','관련','보도','뉴스','증시','시장','동향','지수','코스피','코스닥','투자','경제','이번','오늘','최근','전망','업데이트',
  '마감','증가','감소','상승','하락','포커스','리포트','분석','데이터','글로벌','투자자','기업','회사','기준','발표','속보','주가','주식'
]);

function stripHtml(input){
  return String(input || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsHangul(str){
  return /[\u3131-\u318E\uAC00-\uD7A3]/.test(str || '');
}

function normalizeWord(word){
  return String(word || '').replace(/["'`’”\(\)\[\]\{\}:;!?]/g, '').trim();
}

function toUniqueStrings(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  for (const entry of arr) {
    let str = '';
    if (typeof entry === 'string') {
      str = entry;
    } else if (entry && typeof entry === 'object') {
      if (typeof entry.name === 'string') str = entry.name;
      else if (typeof entry.label === 'string') str = entry.label;
      else if (typeof entry.value === 'string') str = entry.value;
    }
    const cleaned = normalizeWord(str);
    if (cleaned && cleaned.length > 1) {
      out.push(cleaned);
    }
  }
  return Array.from(new Set(out));
}

function buildGoogleSearchUrl(query, locale = 'en'){
  const q = String(query || '').trim();
  if (!q) return '';
  const params = new URLSearchParams();
  params.set('q', q);
  params.set('tbm', 'nws');
  const lang = locale === 'ko' ? 'ko' : 'en';
  if (lang === 'ko') {
    params.set('hl', 'ko');
    params.set('gl', 'KR');
    params.set('ceid', 'KR:ko');
  } else {
    params.set('hl', 'en');
    params.set('gl', 'US');
    params.set('ceid', 'US:en');
  }
  return `https://www.google.com/search?${params.toString()}`;
}

function extractEnglishKeywords(text){
  if (!text) return [];
  const tokens = [];
  const matches = text.match(/\b(?:[A-Z]{2,}(?:\s+[A-Z]{2,})*|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}|(?:AI|ETF|GDP|CPI|FOMC|Fed))(?:\b|$)/g) || [];
  for (const raw of matches){
    const token = normalizeWord(raw);
    if (!token || token.length < 2) continue;
    const lower = token.toLowerCase();
    if (STOPWORDS_EN.has(lower)) continue;
    tokens.push({ token, locale: 'en' });
  }
  return tokens;
}

function extractKoreanKeywords(text){
  if (!text) return [];
  const tokens = [];
  const matches = text.match(/[가-힣A-Za-z0-9·]{2,}/g) || [];
  for (const raw of matches){
    const token = normalizeWord(raw);
    if (!token || token.length < 2) continue;
    const lower = token.toLowerCase();
    if (containsHangul(token) && STOPWORDS_KO.has(token)) continue;
    if (!containsHangul(token) && STOPWORDS_EN.has(lower)) continue;
    tokens.push({ token, locale: containsHangul(token) ? 'ko' : 'en' });
  }
  return tokens;
}

function splitMeaningfulWords(text){
  if (!text) return [];
  const cleaned = stripHtml(text)
    .replace(/[\u201c\u201d\u2018\u2019]/g, '')
    .replace(/[^0-9A-Za-z가-힣·\s]/g, ' ');
  const parts = cleaned.split(/\s+/).map(normalizeWord).filter(Boolean);
  const result = [];
  for (const part of parts){
    if (!part || part.length < 2) continue;
    const hasHangul = containsHangul(part);
    const lower = part.toLowerCase();
    if (hasHangul && STOPWORDS_KO.has(part)) continue;
    if (!hasHangul && STOPWORDS_EN.has(lower)) continue;
    result.push({ token: part, locale: hasHangul ? 'ko' : 'en' });
  }
  return result;
}

function extractKeywordPhrases(text){
  if (!text) return [];
  const words = splitMeaningfulWords(text);
  const phrases = [];
  const seen = new Set();
  for (let i = 0; i < words.length; i++){
    const slice = [];
    for (let len = 1; len <= 3 && i + len <= words.length; len++){
      slice.push(words[i + len - 1]);
      if (!slice.length) continue;
      const phrase = slice.map(it => it.token).join(' ');
      if (!phrase || phrase.length < 3) continue;
      if (phrase.split(' ').length === 1) continue;
      const locales = new Set(slice.map(it => it.locale));
      const locale = locales.has('ko') ? 'ko' : 'en';
      const hasMeaningful = slice.some(it => {
        if (containsHangul(it.token)) return !STOPWORDS_KO.has(it.token);
        return !STOPWORDS_EN.has(it.token.toLowerCase());
      });
      if (!hasMeaningful) continue;
      const key = `${locale}:${phrase.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      phrases.push({ token: phrase, locale });
    }
  }
  return phrases;
}

function addKeywordCandidate(map, key, info){
  if (!key) return;
  const norm = key.toLowerCase();
  if (!norm) return;
  const entry = map.get(norm) || {
    text: { ko: '', en: '' },
    markets: new Set(),
    sources: new Set(),
    mentions: 0,
    headlines: []
  };
  entry.mentions += 1;
  if (info.market) entry.markets.add(info.market);
  if (info.source) entry.sources.add(info.source);
  if (info.locale === 'ko' && !entry.text.ko) entry.text.ko = key;
  if (info.locale !== 'ko' && !entry.text.en) entry.text.en = key;
  if (info.headline && entry.headlines.length < 3) entry.headlines.push(info.headline);
  map.set(norm, entry);
}

async function fetchWithTimeout(url, { headers = {}, timeout = REQ_TIMEOUT_MS, signal } = {}){
  const controller = new AbortController();
  const timeoutId = timeout ? setTimeout(() => controller.abort(), timeout) : null;
  try {
    const res = await fetch(url, {
      headers: { ...defaultHeaders, ...headers },
      signal: signal || controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function fetchJsonWithTimeout(url, opts){
  const res = await fetchWithTimeout(url, opts);
  return res.json();
}

async function fetchNaverKeywordArticles(query){
  const id = process.env.NAVER_CLIENT_ID || process.env.NAVER_ID;
  const secret = process.env.NAVER_CLIENT_SECRET || process.env.NAVER_SECRET;
  if (!id || !secret || SKIP_NAVER) return [];
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=20&sort=date`;
  try {
    const data = await fetchJsonWithTimeout(url, {
      headers: {
        'X-Naver-Client-Id': id,
        'X-Naver-Client-Secret': secret
      }
    });
    if (!data?.items) return [];
    return data.items.map(item => ({
      title: stripHtml(item.title),
      description: stripHtml(item.description),
      url: item.originallink || item.link,
      publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : null,
      source: 'naver'
    }));
  } catch (err) {
    console.warn('[keywords] naver fetch failed:', err.message || err);
    return [];
  }
}

async function fetchSerpKeywordArticles(query, { hl = 'en', gl = 'us' } = {}){
  const key = process.env.SERP_API_KEY;
  if (!key) return [];
  const params = new URLSearchParams({ engine: 'google_news', q: query, hl, gl, api_key: key });
  const url = `https://serpapi.com/search?${params.toString()}`;
  try {
    const data = await fetchJsonWithTimeout(url, {});
    const results = data?.news_results;
    if (!Array.isArray(results)) return [];
    return results.map(item => ({
      title: stripHtml(item.title),
      description: stripHtml(item.snippet),
      url: item.link,
      publishedAt: item.date || null,
      source: 'serpapi'
    }));
  } catch (err) {
    console.warn('[keywords] serpapi fetch failed:', err.message || err);
    return [];
  }
}

async function fetchNewsApiArticles(query){
  const key = process.env.NEWSAPI_KEY;
  if (!key) return [];
  const now = new Date();
  const from = new Date(now.getTime() - 48 * 3600 * 1000).toISOString();
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&from=${from}&sortBy=publishedAt&apiKey=${key}`;
  try {
    const data = await fetchJsonWithTimeout(url, {});
    if (!Array.isArray(data?.articles)) return [];
    return data.articles.map(item => ({
      title: stripHtml(item.title),
      description: stripHtml(item.description),
      url: item.url,
      publishedAt: item.publishedAt || null,
      source: 'newsapi'
    }));
  } catch (err) {
    console.warn('[keywords] newsapi fetch failed:', err.message || err);
    return [];
  }
}

async function fetchNewsDataArticles(query){
  const key = process.env.NEWSDATA_API_KEY;
  if (!key) return [];
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    apikey: key,
    qInTitle: query,
    language: 'en,ko',
    from_date: from,
    to_date: to
  });
  const url = `https://newsdata.io/api/1/archive?${params.toString()}`;
  try {
    const data = await fetchJsonWithTimeout(url, {});
    const results = data?.results;
    if (!Array.isArray(results)) return [];
    return results.map(item => ({
      title: stripHtml(item.title),
      description: stripHtml(item.description || item.content),
      url: item.link,
      publishedAt: item.pubDate || null,
      source: 'newsdata'
    }));
  } catch (err) {
    console.warn('[keywords] newsdata fetch failed:', err.message || err);
    return [];
  }
}

async function fetchGNewsArticles(query, { lang = 'en' } = {}){
  const key = process.env.GNEWS_API;
  if (!key) return [];
  const params = new URLSearchParams({ q: query, lang, max: '10', apikey: key, sortby: 'publishedAt' });
  const url = `https://gnews.io/api/v4/search?${params.toString()}`;
  try {
    const data = await fetchJsonWithTimeout(url, {});
    if (!Array.isArray(data?.articles)) return [];
    return data.articles.map(item => ({
      title: stripHtml(item.title),
      description: stripHtml(item.description || item.content),
      url: item.url,
      publishedAt: item.publishedAt || null,
      source: 'gnews'
    }));
  } catch (err) {
    console.warn('[keywords] gnews fetch failed:', err.message || err);
    return [];
  }
}

async function collectMarketArticles({ market, queries, locales }){
  const results = [];
  for (const query of queries) {
    const tasks = [
      fetchNaverKeywordArticles(query),
      fetchSerpKeywordArticles(query, { hl: locales.includes('ko') ? 'ko' : 'en', gl: locales.includes('ko') ? 'kr' : 'us' }),
      fetchNewsApiArticles(query),
      fetchNewsDataArticles(query),
      fetchGNewsArticles(query, { lang: locales.includes('ko') ? 'ko' : 'en' })
    ];
    const settled = await Promise.allSettled(tasks);
    for (const res of settled) {
      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        for (const article of res.value) {
          results.push({ ...article, market });
        }
      }
    }
  }
  return results;
}

async function fetchDatalabKeywordMetrics(configs){
  const NAVER_ID = process.env.NAVER_CLIENT_ID || process.env.NAVER_ID || '';
  const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || process.env.NAVER_SECRET || '';
  if (!NAVER_ID || !NAVER_SECRET || SKIP_NAVER || !configs.length) return new Map();

  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  const lookbackDays = Number(process.env.DATALAB_KEYWORD_LOOKBACK_DAYS || 120);
  const start = new Date(today.getTime() - lookbackDays * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const metrics = new Map();
  const groups = configs.map(cfg => {
    const keyword = cfg.datalabKeyword || cfg.text?.ko || cfg.text?.en;
    return { config: cfg, groupName: keyword, keyword };
  }).filter(g => g.keyword);

  for (const batch of chunk(groups, 5)) {
    const res = await fetchNaverDataLabBatch(batch, {
      startDate: start,
      endDate: end,
      timeUnit: 'date',
      NAVER_ID,
      NAVER_SECRET
    }).catch(() => ({}));
    const resEntries = Object.entries(res || {});
    const usedKeys = new Set();
    for (const item of batch) {
      const key = item.groupName;
      let data = res?.[key] || res?.[item.keyword];
      if (!data) {
        const fallback = resEntries.find(([k]) => !usedKeys.has(k));
        if (fallback) {
          usedKeys.add(fallback[0]);
          data = fallback[1];
        }
      } else {
        usedKeys.add(key);
      }
      if (data) {
        metrics.set(item.config, data);
      }
    }
  }

  return metrics;
}

async function fetchFinanceTrendKeywords({ lookbackDays = 35, limit = 16 } = {}) {
  const NAVER_ID = process.env.NAVER_CLIENT_ID || process.env.NAVER_ID || '';
  const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || process.env.NAVER_SECRET || '';
  if (!NAVER_ID || !NAVER_SECRET || SKIP_NAVER) return [];

  const now = new Date();
  const endDate = now.toISOString().slice(0, 10);
  const lookback = Math.max(7, Number.isFinite(lookbackDays) ? lookbackDays : 35);
  const startDate = new Date(now.getTime() - lookback * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const groups = [];
  const metaByGroup = new Map();
  for (const cfg of FINANCE_TREND_KEYWORD_GROUPS) {
    if (!cfg || !Array.isArray(cfg.keywords)) continue;
    for (const keyword of cfg.keywords) {
      const term = String(keyword || '').trim();
      if (!term) continue;
      const groupName = `${cfg.category}:${term}`;
      groups.push({ groupName, keyword: term });
      metaByGroup.set(groupName, { category: cfg.category, term });
    }
  }

  if (!groups.length) return [];

  const collected = [];
  for (const batch of chunk(groups, 5)) {
    let res = {};
    try {
      res = await fetchNaverDataLabBatch(batch, {
        startDate,
        endDate,
        timeUnit: 'week',
        NAVER_ID,
        NAVER_SECRET
      });
    } catch (err) {
      console.warn('[keywords] failed to fetch finance trend batch:', err?.message || err);
      continue;
    }

    for (const entry of batch) {
      const key = entry.groupName;
      const metrics = res?.[key] || res?.[entry.keyword];
      if (!metrics) continue;
      const meta = metaByGroup.get(key) || { category: '', term: entry.keyword };
      const popularity = Number.isFinite(metrics.popularity01) ? Math.max(0, metrics.popularity01) : 0;
      const asvi = Number.isFinite(metrics.lastAsvi) ? metrics.lastAsvi / 100 : 0;
      const spikeBonus = metrics.spike ? 0.18 : 0;
      const persistBonus = metrics.persist ? 0.1 : 0;
      const score = popularity * 0.6 + Math.max(0, asvi) * 0.3 + spikeBonus + persistBonus;

      collected.push({
        term_ko: meta.term,
        category: meta.category || '',
        score,
        metrics: {
          popularity,
          lastAsvi: Number.isFinite(metrics.lastAsvi) ? metrics.lastAsvi : 0,
          spike: !!metrics.spike,
          persist: !!metrics.persist
        }
      });
    }
  }

  if (!collected.length) return [];

  const deduped = new Map();
  for (const item of collected) {
    if (!item?.term_ko) continue;
    const key = item.term_ko;
    const existing = deduped.get(key);
    if (!existing || item.score > existing.score) {
      deduped.set(key, item);
    }
  }

  const ranked = Array.from(deduped.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.term_ko.localeCompare(b.term_ko);
  });

  return ranked.slice(0, Math.max(1, limit));
}

function dedupeArticlesByUrl(articles){
  const seen = new Set();
  const out = [];
  for (const article of articles) {
    const url = article?.url || '';
    const key = url || `${article?.title || ''}__${article?.source || ''}`;
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(article);
  }
  return out;
}

async function collectDatalabKeywordSeeds({ query = DATALAB_KEYWORD_QUERY, limit = DATALAB_KEYWORD_COUNT } = {}) {
  const cleanedQuery = String(query || '').trim() || '주식';
  const desired = Math.max(1, Number.isFinite(limit) ? limit : 50);
  const NAVER_ID = process.env.NAVER_CLIENT_ID || process.env.NAVER_ID || '';
  const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || process.env.NAVER_SECRET || '';
  const seeds = new Map();

  const pushSeed = (term, weight = 1) => {
    const normalized = normalizeKoKeywordTerm(term);
    if (!normalized) return;
    const hasHangul = hasHangulText(normalized);
    if (!hasHangul) return;
    if (STOPWORDS_KO.has(normalized) || STOPWORDS_KO.has(term)) return;
    const key = normalized.toLowerCase();
    if (!key) return;
    const existing = seeds.get(key);
    if (existing) {
      existing.score += weight;
    } else {
      seeds.set(key, { term: normalized, score: weight });
    }
  };

  if (!SKIP_NAVER && NAVER_ID && NAVER_SECRET) {
    try {
      // Focus on stock market queries across multiple indices
      const stockQueries = [
        '주식',
        '주식 시장',
        '코스피',
        '코스닥',
        'S&P 500',
        'NASDAQ'
      ];
      const allItems = [];
      for (const q of stockQueries) {
        const res = await naverSearch({ query: q, NAVER_ID, NAVER_SECRET });
        allItems.push(...(res?.items || []));
      }
      for (const item of allItems) {
        const title = stripHtml(item?.title || '');
        const description = stripHtml(item?.description || '');
        const text = `${title} ${description}`.trim();
        if (!text) continue;
        const tokens = extractKoreanKeywords(text);
        for (const token of tokens) {
          if (!token?.token) continue;
          pushSeed(token.token, 1);
        }
      }
    } catch (err) {
      console.warn('[keywords] Naver DataLab seeds failed for stock queries:', err?.message || err);
    }
  }

  if (!seeds.size) {
    pushSeed(cleanedQuery, 1);
  }

  for (const fallback of DATALAB_FALLBACK_KEYWORDS) {
    const base = fallback?.datalabKeyword || fallback?.text?.ko || fallback?.text?.en || '';
    if (base) pushSeed(base, 0.5);
  }

  const ranked = Array.from(seeds.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.term.localeCompare(b.term);
  });

  return ranked.slice(0, desired);
}

async function gatherArticlesForDatalabKeyword(config){
  const articles = [];
  const market = config.markets?.[0] || 'GLOBAL';
  for (const queryInfo of config.articleQueries || []) {
    if (!queryInfo?.query) continue;
    const locales = Array.isArray(queryInfo.locales) && queryInfo.locales.length ? queryInfo.locales : ['en'];
    const collected = await collectMarketArticles({ market, queries: [queryInfo.query], locales });
    articles.push(...collected);
  }
  return dedupeArticlesByUrl(articles);
}

function computeDatalabRawScore(metrics, mentions){
  if (!metrics) return 0;
  const asviScore = Math.max(0, Number(metrics.lastAsvi || 0)) / 100;
  const popularity = Math.max(0, Math.min(1, Number(metrics.popularity01 || 0)));
  const mentionScore = mentions > 0 ? Math.min(1, Math.log10(mentions + 1) / Math.log10(11)) : 0;
  const spikeBonus = metrics.spike ? 0.15 : 0;
  const persistBonus = metrics.persist ? 0.1 : 0;
  return asviScore * 0.5 + popularity * 0.3 + mentionScore * 0.2 + spikeBonus + persistBonus;
}

async function buildDatalabKeywordEntries(){
  const seeds = await collectDatalabKeywordSeeds({ query: DATALAB_KEYWORD_QUERY, limit: DATALAB_KEYWORD_COUNT });
  const datalabConfigs = [];
  const translationCache = new Map();
  let translationWarned = false;

  for (const seed of seeds) {
    const koTerm = seed?.term || '';
    if (!koTerm) continue;
    let enTerm = '';
    if (translationCache.has(koTerm)) {
      enTerm = translationCache.get(koTerm);
    } else if (hasHangulText(koTerm)) {
      try {
        const translation = await translateKoTermToEn(koTerm, { includeMeta: true });
        if (translation?.text) {
          enTerm = formatTagDisplay(translation.text);
        }
      } catch (err) {
        if (!translationWarned) {
          console.warn('[keywords] translation failed for datalab seed:', err?.message || err);
          translationWarned = true;
        }
      }
      translationCache.set(koTerm, enTerm);
    }

    datalabConfigs.push({
      text: { ko: koTerm, en: enTerm },
      datalabKeyword: koTerm,
      markets: enTerm ? ['KOSPI', 'KOSDAQ', 'NASDAQ 100', 'S&P 500'] : ['KOSPI', 'KOSDAQ'],
      articleQueries: [{ query: koTerm, locales: ['ko'] }],
      seedScore: Number(seed?.score || 0)
    });
  }

  if (!datalabConfigs.length) {
    for (const fallback of DATALAB_FALLBACK_KEYWORDS.slice(0, Math.max(1, DATALAB_KEYWORD_COUNT))) {
      datalabConfigs.push({ ...fallback, seedScore: 0 });
    }
  }

  let metricsMap = await fetchDatalabKeywordMetrics(datalabConfigs);
  if (!metricsMap.size && datalabConfigs !== DATALAB_FALLBACK_KEYWORDS) {
    const fallbackConfigs = DATALAB_FALLBACK_KEYWORDS.slice(0, Math.max(1, DATALAB_KEYWORD_COUNT)).map(cfg => ({ ...cfg, seedScore: 0 }));
    metricsMap = await fetchDatalabKeywordMetrics(fallbackConfigs);
    if (metricsMap.size) {
      datalabConfigs.length = 0;
      datalabConfigs.push(...fallbackConfigs);
    }
  }

  if (!metricsMap.size) return [];

  const rawEntries = [];
  for (const config of datalabConfigs) {
    const metrics = metricsMap.get(config);
    if (!metrics) continue;
    const articles = await gatherArticlesForDatalabKeyword(config);
    const mentions = articles.length;
    const sources = new Set(articles.map(a => a.source).filter(Boolean));
    sources.add('naver-datalab');
    const sourcesList = Array.from(sources).sort();
    const sampleHeadlines = articles
      .filter(a => a?.title && a?.url)
      .slice(0, 3)
      .map(a => ({ title: a.title, url: a.url, source: a.source }));

    const searchUrl = {};
    if (config.text?.ko) searchUrl.ko = buildGoogleSearchUrl(config.text.ko, 'ko');
    if (config.text?.en) searchUrl.en = buildGoogleSearchUrl(config.text.en, 'en');

    const baseScore = computeDatalabRawScore(metrics, mentions);
    const seedBonus = Number(config.seedScore || 0);
    const rawScore = baseScore + Math.min(0.3, seedBonus / 50);

    rawEntries.push({
      rawScore,
      entry: {
        text: {
          ko: config.text?.ko || config.text?.en || '',
          en: config.text?.en || config.text?.ko || ''
        },
        markets: Array.from(new Set(config.markets || [])),
        sources: sourcesList,
        mentions,
        score: rawScore,
        sampleHeadlines,
        searchUrl
      }
    });
  }

  if (!rawEntries.length) return [];

  const maxScore = rawEntries.reduce((m, r) => Math.max(m, r.rawScore), 0) || 1;
  return rawEntries
    .sort((a, b) => {
      if (b.rawScore !== a.rawScore) return b.rawScore - a.rawScore;
      if (b.entry.mentions !== a.entry.mentions) return b.entry.mentions - a.entry.mentions;
      return (b.entry.text.en || '').localeCompare(a.entry.text.en || '');
    })
    .slice(0, 10)
    .map(({ entry, rawScore }) => ({
      ...entry,
      score: Number((rawScore / maxScore).toFixed(3))
    }));
}

function buildKeywordSummaryLegacy(articles){
  const map = new Map();
  for (const article of articles) {
    const text = `${article.title || ''} ${article.description || ''}`;
    const english = extractEnglishKeywords(text);
    const korean  = extractKoreanKeywords(text);
    const phrases = extractKeywordPhrases(text);
    const tokens = [...phrases, ...english, ...korean];
    for (const { token, locale } of tokens) {
      if (!token) continue;
      addKeywordCandidate(map, token, {
        market: article.market,
        source: article.source,
        locale,
        headline: article.title ? { title: article.title, url: article.url, source: article.source } : null
      });
    }
  }

  const list = Array.from(map.values()).map(entry => {
    const markets = Array.from(entry.markets);
    const sources = Array.from(entry.sources);
    const normalizedScore = entry.mentions;
    return {
      text: {
        ko: entry.text.ko || entry.text.en || '',
        en: entry.text.en || entry.text.ko || ''
      },
      markets,
      sources,
      mentions: entry.mentions,
      score: normalizedScore,
      sampleHeadlines: entry.headlines
    };
  }).filter(item => item.text.ko || item.text.en);

  list.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.markets.length !== a.markets.length) return b.markets.length - a.markets.length;
    return (b.text.en || b.text.ko || '').length - (a.text.en || a.text.ko || '').length;
  });

  const top = list.slice(0, 10);
  const maxScore = Math.max(...top.map(it => it.score), 1);
  return top.map(item => ({
    ...item,
    score: Number((item.score / maxScore).toFixed(3)),
    searchUrl: (() => {
      const koQuery = item.text.ko || item.text.en || '';
      const enQuery = item.text.en || item.text.ko || '';
      const localized = {
        ko: buildGoogleSearchUrl(koQuery, 'ko'),
        en: buildGoogleSearchUrl(enQuery, 'en')
      };
      if (!localized.ko) delete localized.ko;
      if (!localized.en) delete localized.en;
      return localized;
    })()
  }));
}

const FINANCE_TFIDF_PHRASE_MIN = 1;
const FINANCE_TFIDF_PHRASE_MAX = 3;
const FINANCE_TFIDF_TREND_WINDOW_HOURS = 12;
const FINANCE_TFIDF_OUTPUT_LIMIT = 30;
const FINANCE_TFIDF_MIN_SCORE = 0.5;
const FINANCE_TFIDF_KEYWORDS = [
  '주식', '주가', '코스피', '코스닥', 'etf', '공매도', '배당',
  '매수', '매도', '상장', '증권', '지수', '펀드'
];
const FINANCE_TFIDF_KEYWORD_SET = new Set(FINANCE_TFIDF_KEYWORDS.map(k => k.toLowerCase()));
const FINANCE_TFIDF_EXCLUDE_PATTERN = /(include|invest|bond|blend|fund)/i;
const financePhraseTagger = new pos.Tagger();

function extractFinancePhrasesNormalized(text, minLen = FINANCE_TFIDF_PHRASE_MIN, maxLen = FINANCE_TFIDF_PHRASE_MAX) {
  const cleaned = stripHtml(text || '');
  if (!cleaned) return [];
  const words = new pos.Lexer().lex(cleaned);
  if (!words.length) return [];
  const tagged = financePhraseTagger.tag(words);
  const phrases = new Set();

  for (let i = 0; i < tagged.length; i += 1) {
    for (let len = minLen; len <= maxLen; len += 1) {
      if (i + len > tagged.length) break;
      const chunk = tagged.slice(i, i + len);
      const hasNoun = chunk.some(([word, tag]) => {
        if (!word) return false;
        if (tag && tag.startsWith('NN')) return true;
        return /[가-힣]/.test(word);
      });
      if (!hasNoun) continue;
      const phrase = chunk.map(([word]) => word).join(' ').replace(/\s+/g, ' ').trim();
      if (!phrase || phrase.length < 2) continue;
      if (!/[A-Za-z가-힣]/.test(phrase)) continue;
      phrases.add(phrase.toLowerCase());
    }
  }

  return Array.from(phrases);
}

function buildFinanceDocTokens(text) {
  const cleaned = stripHtml(text || '');
  if (!cleaned) {
    return { tokens: [], phraseSet: new Set() };
  }

  const baseTokens = splitMeaningfulWords(cleaned)
    .map(item => item.token.toLowerCase())
    .filter(Boolean);
  const filteredTokens = sw.removeStopwords(baseTokens);
  const phraseList = extractFinancePhrasesNormalized(cleaned);
  const phraseSet = new Set();

  for (const phrase of phraseList) {
    const normalized = phrase.replace(/\s+/g, ' ').trim();
    if (normalized) {
      phraseSet.add(normalized);
    }
  }

  const tokenSet = new Set();
  for (const token of filteredTokens) {
    const normalized = token.replace(/\s+/g, ' ').trim();
    if (normalized && normalized.length > 1) {
      tokenSet.add(normalized);
    }
  }

  for (const phrase of phraseSet) {
    if (phrase.length > 1) {
      tokenSet.add(phrase);
    }
  }

  return { tokens: Array.from(tokenSet), phraseSet };
}

function computeFinanceTrendWeight(timestamp) {
  if (!Number.isFinite(timestamp)) return 1;
  const now = Date.now();
  const ageHours = Math.max(0, (now - timestamp) / 36e5);
  if (ageHours < 6) return 1.5;
  if (ageHours < FINANCE_TFIDF_TREND_WINDOW_HOURS) return 1.2;
  return 1;
}

function computeFinanceKeywordFinanceBoost(term) {
  const lower = term.toLowerCase();
  for (const keyword of FINANCE_TFIDF_KEYWORD_SET) {
    if (lower.includes(keyword)) {
      return 3;
    }
  }
  return 1;
}

function computeFinanceKeywordScore(tfidfScore, mentions, financeBoost, trendWeight) {
  return 0.5 * tfidfScore + 0.3 * mentions + 0.2 * financeBoost + 100 * trendWeight;
}

function buildFinanceTfIdfSummary(articles) {
  if (!Array.isArray(articles) || !articles.length) return [];

  const documents = [];
  for (const article of articles) {
    const text = `${stripHtml(article.title || '')} ${stripHtml(article.description || '')}`.trim();
    if (!text) continue;
    const { tokens, phraseSet } = buildFinanceDocTokens(text);
    if (!tokens.length) continue;
    const published = article.publishedAt ? new Date(article.publishedAt) : null;
    const timestamp = published && Number.isFinite(published.getTime()) ? published.getTime() : Date.now();
    const meta = {
      market: article.market,
      source: article.source,
      headline: article.title && article.url
        ? { title: stripHtml(article.title), url: article.url, source: article.source }
        : null
    };
    documents.push({ tokens, phraseSet, timestamp, meta });
  }

  if (!documents.length) return [];

  const tfidf = new natural.TfIdf();
  for (const doc of documents) {
    tfidf.addDocument(doc.tokens);
  }

  const aggregated = new Map();

  documents.forEach((doc, docIndex) => {
    const allowed = doc.phraseSet.size ? doc.phraseSet : new Set(doc.tokens.map(t => t.toLowerCase()));
    const trendWeight = computeFinanceTrendWeight(doc.timestamp);
    const terms = tfidf.listTerms(docIndex);

    for (const item of terms) {
      const rawTerm = typeof item.term === 'string' ? item.term : '';
      const normalized = rawTerm.replace(/\s+/g, ' ').trim();
      if (!normalized) continue;

      const lowerTerm = normalized.toLowerCase();
      if (allowed.size && !allowed.has(lowerTerm)) continue;

      const wordCount = lowerTerm.split(' ').filter(Boolean).length;
      if (wordCount < FINANCE_TFIDF_PHRASE_MIN || wordCount > FINANCE_TFIDF_PHRASE_MAX) continue;
      if (!/[a-z0-9가-힣]/i.test(lowerTerm)) continue;
      if (FINANCE_TFIDF_EXCLUDE_PATTERN.test(lowerTerm)) continue;

      const financeBoost = computeFinanceKeywordFinanceBoost(lowerTerm);
      const mentions = Number.isFinite(item.count) ? Math.max(1, item.count) : 1;
      const combinedScore = computeFinanceKeywordScore(item.tfidf || 0, mentions, financeBoost, trendWeight);

      let entry = aggregated.get(lowerTerm);
      if (!entry) {
        entry = {
          term: normalized,
          totalScore: 0,
          mentions: 0,
          maxTfidf: 0,
          financeBoost,
          maxTrendWeight: trendWeight,
          markets: new Set(),
          sources: new Set(),
          headlines: [],
          headlineKeys: new Set(),
          seenDocs: new Set()
        };
        aggregated.set(lowerTerm, entry);
      }

      entry.totalScore += combinedScore;
      entry.maxTfidf = Math.max(entry.maxTfidf, item.tfidf || 0);
      entry.financeBoost = Math.max(entry.financeBoost, financeBoost);
      entry.maxTrendWeight = Math.max(entry.maxTrendWeight, trendWeight);
      entry.seenDocs.add(docIndex);
      entry.mentions = entry.seenDocs.size;

      if (doc.meta?.market) entry.markets.add(doc.meta.market);
      if (doc.meta?.source) entry.sources.add(doc.meta.source);
      if (doc.meta?.headline) {
        const key = `${doc.meta.headline.title || ''}__${doc.meta.headline.url || ''}`;
        if (!entry.headlineKeys.has(key) && entry.headlines.length < 3) {
          entry.headlineKeys.add(key);
          entry.headlines.push(doc.meta.headline);
        }
      }
    }
  });

  const scored = Array.from(aggregated.values())
    // Optional: apply embedding similarity to merge near-duplicate phrases.
    .map(entry => ({
      term: entry.term,
      totalScore: entry.totalScore,
      mentions: entry.mentions,
      markets: Array.from(entry.markets),
      sources: Array.from(entry.sources),
      sampleHeadlines: entry.headlines,
      financeBoost: entry.financeBoost,
      maxTfidf: entry.maxTfidf
    }))
    .filter(entry => entry.totalScore > FINANCE_TFIDF_MIN_SCORE)
    .sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      if (b.mentions !== a.mentions) return b.mentions - a.mentions;
      return b.maxTfidf - a.maxTfidf;
    })
    .slice(0, Math.min(FINANCE_TFIDF_OUTPUT_LIMIT, 30));

  if (!scored.length) return [];

  const topCount = Math.min(10, scored.length);
  const top = scored.slice(0, topCount);
  const maxScore = top.reduce((max, item) => Math.max(max, item.totalScore), 0) || 1;

  return top.map(item => {
    const formatted = formatTagDisplay(item.term);
    const hasHangul = hasHangulText(formatted);
    const text = {
      ko: hasHangul ? formatted : '',
      en: hasHangul ? formatted : formatted
    };
    if (!text.ko) text.ko = text.en;
    if (!text.en) text.en = text.ko;

    const koQuery = text.ko || text.en;
    const enQuery = text.en || text.ko;
    const searchUrl = {
      ko: buildGoogleSearchUrl(koQuery, 'ko'),
      en: buildGoogleSearchUrl(enQuery, 'en')
    };
    if (!searchUrl.ko) delete searchUrl.ko;
    if (!searchUrl.en) delete searchUrl.en;

    return {
      text,
      markets: item.markets,
      sources: item.sources,
      mentions: item.mentions,
      score: Number((item.totalScore / maxScore).toFixed(3)),
      sampleHeadlines: item.sampleHeadlines,
      searchUrl
    };
  });
}

function buildKeywordSummary(articles) {
  const enhanced = buildFinanceTfIdfSummary(articles);
  if (enhanced.length) return enhanced;
  return buildKeywordSummaryLegacy(articles);
}

function isMeaningfulTagCandidate(str) {
  if (!str) return false;
  const lower = String(str).toLowerCase().trim();
  if (!lower) return false;
  if (TAG_STOPWORD_PHRASES.has(lower)) return false;
  const normalizedPhrase = lower.replace(/-/g, ' ');
  if (TAG_STOPWORD_PHRASES.has(normalizedPhrase)) return false;
  if (/^\d+$/.test(lower)) return false;
  const tokens = normalizedPhrase.split(/[^a-z0-9]+/).filter(Boolean);
  if (!tokens.length) return false;
  return tokens.some(token => {
    if (!token) return false;
    if (/^\d+$/.test(token)) return false;
    return !TAG_STOPWORD_TOKENS.has(token);
  });
}

function normalizeTagCandidate(raw) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/[“”‘’]/g, "'")
    .replace(/[·•]/g, ' ')
    .replace(/[^A-Za-z0-9&()/.,'\-\s]/g, ' ')
    .trim();
  if (!cleaned) return null;
  const collapsed = cleaned.replace(/\s+/g, ' ').trim();
  if (!collapsed || !/[A-Za-z]/.test(collapsed)) return null;
  if (!ENGLISH_TAG_REGEX.test(collapsed)) return null;
  if (!isMeaningfulTagCandidate(collapsed)) return null;
  return collapsed;
}

function formatTagDisplay(str) {
  const text = String(str || '').trim();
  if (!text) return '';
  const lower = text.toLowerCase();
  if (text.length <= 3 && /[a-z]/i.test(text)) return text.toUpperCase();
  if (text === lower) {
    return lower
      .split(' ')
      .map(part => part ? part[0].toUpperCase() + part.slice(1) : '')
      .join(' ');
  }
  return text;
}

function translateTagToKo(tag) {
  const text = String(tag || '').trim();
  if (!text) return '';
  const lower = text.toLowerCase();
  if (TAG_KO_DICTIONARY.has(lower)) return TAG_KO_DICTIONARY.get(lower);
  if (lower.endsWith('es') && TAG_KO_DICTIONARY.has(lower.slice(0, -2))) return TAG_KO_DICTIONARY.get(lower.slice(0, -2));
  if (lower.endsWith('s') && TAG_KO_DICTIONARY.has(lower.slice(0, -1))) return TAG_KO_DICTIONARY.get(lower.slice(0, -1));
  if (lower.includes('&')) {
    const parts = lower.split('&').map(p => p.trim());
    const translated = parts.map(p => TAG_KO_DICTIONARY.get(p) || '').filter(Boolean);
    if (translated.length) return translated.join(' & ');
  }
  return text;
}

const TRANSLATION_CACHE = new Map();
let translationModulePromise = null;

function setTranslationCache(en, ko) {
  const enText = String(en || '').trim();
  const koText = String(ko || '').trim();
  if (!enText || !koText) return;
  TRANSLATION_CACHE.set(enText.toLowerCase(), koText);
}

function hasHangulText(value) {
  return HANGUL_REGEX.test(String(value || ''));
}

function resolveDeepLEndpoint() {
  if (DEEPL_API_URL) {
    return DEEPL_API_URL.replace(/\/?$/, '') + '/v2/translate';
  }
  const isFreeKey = /:fx$/i.test(DEEPL_API_KEY);
  const base = isFreeKey ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  return `${base}/v2/translate`;
}

async function translateWithDeepL(text, { targetLang = 'KO', sourceLang = 'EN' } = {}) {
  if (!DEEPL_API_KEY) return null;
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    const endpoint = resolveDeepLEndpoint();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'stock-recs/1.2 (+github-actions)'
      },
      body: JSON.stringify({
        text: [raw],
        target_lang: String(targetLang || 'KO').toUpperCase(),
        source_lang: String(sourceLang || 'EN').toUpperCase()
      })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      console.warn(`[keywords] DeepL translation failed (${res.status}) via ${endpoint}:`, errText);
      return null;
    }
    const data = await res.json().catch(() => null);
    const translated = data?.translations?.[0]?.text;
    if (translated) {
      return String(translated).trim();
    }
  } catch (err) {
    console.warn(`[keywords] DeepL request failed for "${raw}":`, err?.message || err);
  }
  return null;
}

async function ensureTranslationModule() {
  if (!translationModulePromise) {
    translationModulePromise = import('@vitalets/google-translate-api')
      .then(mod => {
        const candidates = [
          mod?.default,
          mod?.default?.translate,
          mod?.translate,
          mod
        ];
        for (const candidate of candidates) {
          if (typeof candidate === 'function') {
            return candidate;
          }
        }
        console.warn('[keywords] translation module did not provide a callable export.');
        return null;
      })
      .catch(err => {
        console.warn('[keywords] failed to load translation module:', err?.message || err);
        return null;
      });
  }
  return translationModulePromise;
}

function isCompleteKoTranslation(en, candidate) {
  const enText = String(en || '').trim().toLowerCase();
  const koText = String(candidate || '').trim();
  if (!koText) return false;
  if (hasHangulText(koText)) return true;
  if (!enText) return false;
  return koText.toLowerCase() !== enText;
}

async function translateKoTermToEn(koText, { includeMeta = false } = {}) {
  const raw = String(koText || '').trim();
  if (!raw) return includeMeta ? { text: '', translator: '' } : '';

  const buildResult = (text, translator) => includeMeta
    ? { text: String(text || '').trim(), translator: String(translator || '').trim() }
    : String(text || '').trim();

  if (DEEPL_API_KEY) {
    const deepl = await translateWithDeepL(raw, { sourceLang: 'KO', targetLang: 'EN' });
    const deeplText = String(deepl || '').trim();
    if (deeplText) {
      return buildResult(deeplText, 'deepl');
    }
  }

  const translatorModule = await ensureTranslationModule();
  if (translatorModule) {
    try {
      const result = await translatorModule(raw, { from: 'ko', to: 'en' });
      const translated = String(result?.text || '').trim();
      if (translated) {
        return buildResult(translated, 'google');
      }
    } catch (err) {
      console.warn(`[keywords] failed to translate Korean term "${raw}" with Google:`, err?.message || err);
    }
  }

  return '';
}

async function getLocalizedKeywordTexts(enText) {
  const en = String(enText || '').trim();
  if (!en) return { en: '', ko: '' };

  const dictionaryKoRaw = translateTagToKo(en);
  const dictionaryKoHasHangul = dictionaryKoRaw && hasHangulText(dictionaryKoRaw);
  if (dictionaryKoHasHangul) {
    const finalKo = String(dictionaryKoRaw || '').trim();
    setTranslationCache(en, finalKo);
    return { en, ko: finalKo, meta: { translator: 'dictionary', attemptedDeepL: false, usedDeepL: false, complete: true } };
  }

  const cacheKey = en.toLowerCase();
  if (TRANSLATION_CACHE.has(cacheKey)) {
    const cachedKo = TRANSLATION_CACHE.get(cacheKey);
    return {
      en,
      ko: cachedKo,
      meta: {
        translator: 'cache',
        attemptedDeepL: false,
        usedDeepL: false,
        complete: isCompleteKoTranslation(en, cachedKo)
      }
    };
  }

  let ko = '';
  let translator = 'none';
  let attemptedDeepL = false;
  let usedDeepL = false;
  let attemptedGoogle = false;
  let usedGoogle = false;
  let complete = false;
  const fallbackDictionary = String(dictionaryKoRaw || '').trim();

  if (DEEPL_API_KEY) {
    attemptedDeepL = true;
    const deeplResult = await translateWithDeepL(en, { sourceLang: 'EN', targetLang: 'KO' });
    const deeplText = String(deeplResult || '').trim();
    if (deeplText) {
      if (isCompleteKoTranslation(en, deeplText)) {
        ko = deeplText;
        translator = 'deepl';
        usedDeepL = true;
        complete = true;
      } else {
        translator = 'deepl-incomplete';
        console.warn(`[keywords] DeepL returned incomplete translation for "${en}":`, deeplText);
      }
    }
  }

  if (!ko) {
    const translatorModule = await ensureTranslationModule();
    if (translatorModule) {
      attemptedGoogle = true;
      try {
        const result = await translatorModule(en, { from: 'en', to: 'ko' });
        const translated = String(result?.text || '').trim();
        if (translated) {
          if (isCompleteKoTranslation(en, translated)) {
            ko = translated;
            translator = usedDeepL ? 'deepl+google' : 'google';
            usedGoogle = true;
            complete = true;
          } else {
            console.warn(`[keywords] Google translation incomplete for "${en}":`, translated);
          }
        }
      } catch (err) {
        console.warn(`[keywords] failed to translate "${en}":`, err?.message || err);
      }
    }
  }

  if (!ko && fallbackDictionary && fallbackDictionary.toLowerCase() !== en.toLowerCase()) {
    ko = fallbackDictionary;
    translator = translator === 'none' ? 'dictionary-fallback' : `${translator}+dictionary`;
    complete = isCompleteKoTranslation(en, ko);
  }

  if (!ko) {
    ko = en;
    translator = translator === 'none' ? 'identity' : `${translator}+identity`;
    complete = false;
  }

  setTranslationCache(en, ko);
  return { en, ko, meta: { translator, attemptedDeepL, usedDeepL, attemptedGoogle, usedGoogle, complete } };
}

async function runKrWordRankCollector({ limit = 30, queries = [] } = {}) {
  try {
    await fsp.access(KRWORDRANK_SCRIPT);
  } catch {
    return null;
  }

  const args = [KRWORDRANK_SCRIPT, '--limit', String(limit)];
  for (const q of queries) {
    const cleaned = String(q || '').trim();
    if (cleaned) {
      args.push('--query', cleaned);
    }
  }

  return await new Promise((resolve) => {
    const proc = spawn(PYTHON_BIN || 'python3', args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      console.warn('[keywords] KR-WordRank collector timed out; terminating process');
      proc.kill('SIGTERM');
    }, Math.max(5000, KRWORDRANK_TIMEOUT_MS));

    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });

    proc.on('error', err => {
      clearTimeout(timer);
      console.warn('[keywords] failed to run KR-WordRank collector:', err?.message || err);
      resolve(null);
    });

    proc.on('close', code => {
      clearTimeout(timer);
      if (stderr.trim()) {
        console.warn('[keywords] KR-WordRank stderr:', stderr.trim());
      }
      if (code !== 0) {
        console.warn(`[keywords] KR-WordRank collector exited with code ${code}`);
        return resolve(null);
      }
      if (!stdout.trim()) {
        return resolve(null);
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed);
      } catch (err) {
        console.warn('[keywords] failed to parse KR-WordRank output:', err?.message || err);
        resolve(null);
      }
    });
  });
}

async function fetchTextWithFallback(attempts = [], { timeoutMs = 8000, label = 'source' } = {}) {
  for (const attempt of attempts) {
    if (!attempt || !attempt.url) continue;
    const headers = { ...defaultHeaders, ...(attempt.headers || {}) };
    const attemptTimeout = Number.isFinite(attempt.timeoutMs)
      ? Math.max(0, Number(attempt.timeoutMs))
      : timeoutMs;
    const controller = attemptTimeout > 0 ? new AbortController() : null;
    let timer = null;
    if (controller && attemptTimeout > 0) {
      timer = setTimeout(() => controller.abort(), attemptTimeout);
    }
    try {
      const res = await fetch(attempt.url, {
        headers,
        signal: controller ? controller.signal : undefined,
        redirect: attempt.redirect || 'follow'
      });
      if (timer) clearTimeout(timer);
      if (!res.ok) {
        console.warn(`[keywords] ${label} request to ${attempt.url} returned status ${res.status}`);
        continue;
      }
      const text = await res.text();
      if (text && text.trim()) {
        return text;
      }
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (err?.name === 'AbortError') {
        console.warn(`[keywords] ${label} request to ${attempt.url} timed out after ${attemptTimeout || timeoutMs}ms`);
      } else {
        console.warn(`[keywords] failed to fetch ${label} from ${attempt.url}:`, err?.message || err);
      }
    }
  }
  return '';
}

function normalizeKoKeywordTerm(value) {
  const cleaned = String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/[\[\]{}]/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/[`*_]/g, ' ')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';
  if (cleaned.includes('\uFFFD')) return '';
  if (/https?:\/\//i.test(cleaned)) return '';

  const compact = cleaned.replace(/\s+/g, '');
  if (compact.length < 2 || compact.length > 40) return '';
  if (!hasHangulText(cleaned)) return '';

  return cleaned;
}

let FINANCE_KEYWORD_CACHE = null;

function loadFinanceKeywordList() {
  if (Array.isArray(FINANCE_KEYWORD_CACHE) && FINANCE_KEYWORD_CACHE.length) {
    return [...FINANCE_KEYWORD_CACHE];
  }

  try {
    const raw = JSON.parse(fs.readFileSync(FINANCE_KEYWORDS_FILE, 'utf8'));
    const keywords = Array.isArray(raw?.finance_keywords) ? raw.finance_keywords : [];
    FINANCE_KEYWORD_CACHE = keywords
      .map(item => String(item || '').trim())
      .filter(Boolean);
  } catch (err) {
    console.warn('[keywords] failed to load finance keywords:', err?.message || err);
    FINANCE_KEYWORD_CACHE = [];
  }

  return [...FINANCE_KEYWORD_CACHE];
}

function sampleFinanceKeywords(list, count) {
  if (!Array.isArray(list) || list.length === 0 || count <= 0) return [];
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}

function normalizeKoreanMultiwordPhrase(value) {
  const normalized = normalizeKoKeywordTerm(value);
  if (!normalized) return '';
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 3) return '';
  return normalized;
}

async function fetchNaverRelatedKeywords(query) {
  const searchUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(query)}`;
  try {
    const res = await fetchWithTimeout(searchUrl, { timeout: 7000 });
    const html = await res.text();
    const root = parse(html);

    const anchors = root.querySelectorAll('ul._related_keyword a, div.related_srch a');
    const keywords = anchors.map(a => a.text.trim()).filter(k => k && k !== query);
    return Array.from(new Set(keywords)).slice(0, 10);
  } catch (err) {
    console.warn(`[related] failed for "${query}":`, err?.message || err);
    return [];
  }
}

async function collectRandomFinanceKeywordSearchPhrases({
  sampleSize = 30,
  perKeywordLimit: _perKeywordLimit = 6,
  totalLimit = 50
} = {}) {
  if (SKIP_NAVER) return [];
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) return [];
  void _perKeywordLimit;

  const financeKeywords = loadFinanceKeywordList();
  if (!financeKeywords.length) return [];

  const koreanOnly = financeKeywords.filter(k => HANGUL_REGEX.test(k));
  if (!koreanOnly.length) return [];

  const desiredCount = Math.max(1, sampleSize);
  const initialPool = sampleFinanceKeywords(koreanOnly, Math.max(desiredCount, 50));

  const stockCandidates = [];
  const nonStockCandidates = [];
  for (const term of initialPool) {
    const trimmed = String(term || '').trim();
    if (!trimmed) continue;
    if (trimmed.includes('주식')) stockCandidates.push(trimmed);
    else nonStockCandidates.push(trimmed);
  }

  const maxStockShare = Math.max(0, Math.floor(desiredCount * 0.3));
  const stockSample = stockCandidates.slice(0, maxStockShare || 1);

  const isValidWordCount = (value) => {
    const words = String(value || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return words.length >= 2 && words.length <= 3;
  };

  const nonStockSample = [];
  for (const term of nonStockCandidates) {
    if (!isValidWordCount(term)) continue;
    nonStockSample.push(term);
    if (nonStockSample.length >= desiredCount - stockSample.length) break;
  }

  const addMoreFromPool = (targetSet) => {
    if (targetSet.size >= desiredCount) return;
    const shuffledPool = sampleFinanceKeywords(koreanOnly, koreanOnly.length);
    for (const term of shuffledPool) {
      if (targetSet.size >= desiredCount) break;
      if (!isValidWordCount(term)) continue;
      const normalized = normalizeKoreanMultiwordPhrase(term);
      if (normalized) targetSet.add(normalized);
    }
  };

  const candidateSet = new Set();
  for (const term of [...stockSample, ...nonStockSample]) {
    const normalized = normalizeKoreanMultiwordPhrase(term);
    if (normalized) candidateSet.add(normalized);
  }

  addMoreFromPool(candidateSet);

  try {
    const relatedToStock = await fetchNaverRelatedKeywords('주식');
    for (const related of relatedToStock) {
      const normalized = normalizeKoreanMultiwordPhrase(related);
      if (normalized) candidateSet.add(normalized);
    }
  } catch (err) {
    console.warn('[keywords] failed to fetch related stock keywords:', err?.message || err);
  }

  addMoreFromPool(candidateSet);

  if (!candidateSet.size) return [];

  const candidateList = Array.from(candidateSet);
  const shuffledCandidates = sampleFinanceKeywords(candidateList, candidateList.length);
  const limitedCandidates = shuffledCandidates.slice(0, desiredCount);

  const aggregated = new Map();

  for (const keyword of limitedCandidates) {
    const normalizedKeyword = normalizeKoreanMultiwordPhrase(keyword);
    if (!normalizedKeyword) continue;
    try {
      const articles = await fetchNaverKeywordArticles(normalizedKeyword);
      const totalArticles = Array.isArray(articles) ? articles.length : 0;
      const matchScore = Array.isArray(articles)
        ? articles.filter(article => (article?.title || '').includes(normalizedKeyword)).length
        : 0;
      const baseScore = Math.min(1, (totalArticles * 0.04) + (matchScore * 0.1));
      const mentions = Math.max(1, matchScore || Math.round(totalArticles * 0.2));

      const entry = {
        term_ko: normalizedKeyword,
        score: Number(baseScore.toFixed(2)),
        mentions,
        keywords: [normalizedKeyword]
      };
      aggregated.set(normalizedKeyword.toLowerCase(), entry);
    } catch (err) {
      console.warn('[keywords] failed to score keyword', normalizedKeyword, err?.message || err);
    }
  }

  if (!aggregated.size) return [];

  console.log(`[keywords] scored ${aggregated.size} finance keyword phrases from ${limitedCandidates.length} keywords (pool ${candidateSet.size})`);

  return Array.from(aggregated.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.mentions !== a.mentions) return b.mentions - a.mentions;
      return a.term_ko.localeCompare(b.term_ko);
    })
    .slice(0, Math.max(1, Math.min(totalLimit, aggregated.size)));
}

const KO_SIGNATURE_NOISE = new Set([
  '호조', '호조에', '급등', '급락', '재상승', '재하락', '재상승은', '재하락은',
  '앞두고', '꼽은', 'quot', 'vs', 'vs', 'vs.', '재상승도', '재상승이', '재하락이',
  '재하락도', '애널리스트', '애널리스트는', '낮은', '높은'
]);

const KO_SIGNATURE_WEAK = new Set(['금리', '환율', '수혜', '금융', '주가']);

const KO_SIGNATURE_CANONICAL = new Map([
  ['국채금리', '채권금리'],
  ['국채 금리', '채권금리'],
  ['국채', '채권'],
  ['미국채', '미국 채권']
]);

const KO_PARTICLE_REGEX = /(에서|으로써|으로서|으로는|으로도|으로|로써|로서|로는|로도|로|에게서|에게|까지|부터|만|이나|이라도|이라고|이라며|이라면|이라니|이라서|이라는|이라며|이라|이며|으며|으로|로|은|는|이|가|을|를|와|과|도|에|에서|께|까지|부터|년)$/;

function stripKoParticles(token) {
  let result = token;
  while (result.length > 1) {
    const next = result.replace(KO_PARTICLE_REGEX, '');
    if (next === result) break;
    result = next;
  }
  return result;
}

function buildKoKeywordSignature(value) {
  const normalized = normalizeKoKeywordTerm(value);
  if (!normalized) return '';
  const rawTokens = normalized.split(/\s+/);
  const tokens = [];
  for (const raw of rawTokens) {
    let token = raw.replace(/[^\uAC00-\uD7A30-9]/g, '');
    if (!token) continue;
    token = stripKoParticles(token);
    if (!token || token.length < 2) continue;
    if (/^\d+$/.test(token)) continue;
    if (STOPWORDS_KO.has(token)) continue;
    const canonical = KO_SIGNATURE_CANONICAL.get(token) || KO_SIGNATURE_CANONICAL.get(token.replace(/\s+/g, '')) || token;
    if (KO_SIGNATURE_NOISE.has(canonical)) continue;
    tokens.push(canonical);
  }

  if (!tokens.length) return '';

  if (tokens.length > 1) {
    const filtered = tokens.filter(token => !KO_SIGNATURE_WEAK.has(token));
    if (filtered.length) {
      tokens.length = 0;
      tokens.push(...filtered);
    }
  }

  const unique = [];
  const seen = new Set();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }

  if (!unique.length) return '';
  return unique.join('|');
}

function parseEIECKeywordText(text, { maxEntries = 60 } = {}) {
  if (!text) return [];
  const plain = String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*/g, ' ')
    .replace(/__+/g, ' ')
    .replace(/\u00A0/g, ' ');
  const lines = plain
    .split(/\n|\r/)
    .map(line => line.trim())
    .filter(Boolean);
  const keywords = [];
  let currentPeriod = '';
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const periodMatch = line.match(/^(\d{4}\.\d{1,2})$/);
    if (periodMatch) {
      currentPeriod = periodMatch[1];
      continue;
    }
    const entryMatch = line.match(/^(\d+)\.\s+(\d+)\s+(.+)$/);
    if (!entryMatch) continue;
    let termPart = entryMatch[3].trim();
    let count = 0;
    const countMatch = termPart.match(/(\d{1,3}(?:,\d{3})*)\s*$/);
    if (countMatch) {
      count = Number(countMatch[1].replace(/,/g, ''));
      termPart = termPart.slice(0, countMatch.index).trim();
    }
    termPart = termPart
      .replace(/\bNEW\b/gi, ' ')
      .replace(/\bpick\b/gi, ' ')
      .replace(/\bpick_\b/gi, ' ')
      .replace(/\s+-\s*$/, ' ')
      .replace(/[_*]/g, ' ')
      .replace(/[()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const normalized = normalizeKoKeywordTerm(termPart);
    if (!normalized || !hasHangulText(normalized)) continue;
    const weight = Number.isFinite(count) && count > 0 ? count : 1;
    keywords.push({
      term: '',
      term_ko: normalized,
      score: weight,
      count: weight,
      period: currentPeriod,
      source: 'eiec'
    });
    if (maxEntries > 0 && keywords.length >= maxEntries) break;
  }
  return keywords;
}

async function fetchEIECEconomyKeywords({ maxEntries = 60 } = {}) {
  const text = await fetchTextWithFallback([
    { url: EIEC_TREND_URL, headers: { Accept: 'text/html,application/xhtml+xml;q=0.9' } },
    { url: `https://r.jina.ai/${EIEC_TREND_URL}`, headers: { Accept: 'text/markdown,text/plain;q=0.9' } }
  ], { timeoutMs: 9000, label: 'EIEC keyword trend' });
  if (!text) return [];
  return parseEIECKeywordText(text, { maxEntries });
}

function parseInvestZumKeywordText(text, { maxEntries = 40 } = {}) {
  if (!text) return [];
  const plain = String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00A0/g, ' ')
    .replace(/\*\*/g, ' ')
    .replace(/__+/g, ' ');
  const anchor = plain.includes('오늘의 이슈 종목')
    ? plain.slice(plain.indexOf('오늘의 이슈 종목'))
    : plain;
  const tailIndex = anchor.indexOf('ZUM에서 제공');
  const segment = tailIndex > 0 ? anchor.slice(0, tailIndex) : anchor;
  const regex = /\]\s*([^\]\$\n]+?)\s*\$[\d,.]+/g;
  const map = new Map();
  let match;
  while ((match = regex.exec(segment)) !== null) {
    let name = match[1] || '';
    name = name.replace(/[!()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    const normalized = normalizeKoKeywordTerm(name);
    if (!normalized || !hasHangulText(normalized)) continue;
    const key = normalized.toLowerCase();
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      existing.score = Math.max(existing.score, existing.count);
    } else {
      map.set(key, { term: '', term_ko: normalized, score: 1, count: 1, source: 'invest-zum' });
      if (maxEntries > 0 && map.size >= maxEntries) break;
    }
  }
  return Array.from(map.values());
}

async function fetchInvestZumIssueKeywords({ maxEntries = 40 } = {}) {
  const text = await fetchTextWithFallback([
    { url: INVEST_ZUM_URL, headers: { Accept: 'text/html,application/xhtml+xml;q=0.9' } },
    { url: `https://r.jina.ai/${INVEST_ZUM_URL}`, headers: { Accept: 'text/markdown,text/plain;q=0.9' } }
  ], { timeoutMs: 9000, label: 'Invest ZUM issues' });
  if (!text) return [];
  return parseInvestZumKeywordText(text, { maxEntries });
}

async function collectEconomyKoKeywords({ limit = 30 } = {}) {
  const aggregated = new Map();
  const pushKeyword = (entry = {}) => {
    const rawKo = entry.term_ko || entry.term || '';
    const normalizedKo = normalizeKoKeywordTerm(rawKo);
    if (!normalizedKo || !hasHangulText(normalizedKo)) return;
    const key = normalizedKo.toLowerCase();
    const rawScore = Number(entry.score);
    const rawCount = Number(entry.count);
    const weight = (Number.isFinite(rawScore) && rawScore > 0)
      ? rawScore
      : (Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 1);
    const source = entry.source ? String(entry.source) : '';
    const enTerm = entry.term && entry.term !== normalizedKo ? entry.term : '';
    if (aggregated.has(key)) {
      const existing = aggregated.get(key);
      if (enTerm && (!existing.term || existing.term === existing.term_ko)) {
        existing.term = enTerm;
      }
      existing.count += weight;
      if (weight > existing.score) {
        existing.score = weight;
      }
      if (source) existing.sources.add(source);
    } else {
      aggregated.set(key, {
        term: enTerm,
        term_ko: normalizedKo,
        score: weight,
        count: weight,
        sources: new Set(source ? [source] : [])
      });
    }
  };

  const supplementalLimit = limit && Number.isFinite(limit) ? limit : 30;
  const eiecKeywords = await fetchEIECEconomyKeywords({ maxEntries: supplementalLimit * 3 });
  for (const item of eiecKeywords) {
    pushKeyword(item);
  }

  const zumKeywords = await fetchInvestZumIssueKeywords({ maxEntries: supplementalLimit * 2 });
  for (const item of zumKeywords) {
    pushKeyword(item);
  }

  if (NAVER_CLIENT_ID && NAVER_CLIENT_SECRET) {
    const queries = [
      '주식'
    ];
    const result = await runKrWordRankCollector({ limit: supplementalLimit, queries });
    if (result && Array.isArray(result?.keywords)) {
      for (const entry of result.keywords) {
        pushKeyword({
          term: entry?.term || entry?.term_en || '',
          term_ko: entry?.term_ko || entry?.term || '',
          score: Number(entry?.score ?? entry?.weight ?? 0),
          count: Number(entry?.count ?? 0),
          source: 'krwordrank'
        });
      }
    }
  } else {
    console.warn('[keywords] NAVER credentials missing; skipping KR-WordRank collector');
  }

  let results = Array.from(aggregated.values()).map(entry => ({
    term: entry.term,
    term_ko: entry.term_ko,
    score: Number(entry.score) || Number(entry.count) || 1,
    count: Number(entry.count) || Number(entry.score) || 1,
    source: entry.sources.size ? Array.from(entry.sources).join('+') : undefined
  }));

  results = results.filter(entry => entry.term_ko);
  results.sort((a, b) => {
    if ((b.count || 0) !== (a.count || 0)) return (b.count || 0) - (a.count || 0);
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    return a.term_ko.localeCompare(b.term_ko, 'ko');
  });

  if (limit && Number.isFinite(limit) && results.length > limit) {
    results = results.slice(0, limit);
  }

  return results;
}

function chooseTagDisplay(entry) {
  if (!entry) return '';
  const forms = Array.from(entry.forms || []);
  if (!forms.length) return formatTagDisplay(entry.display || '');
  forms.sort((a, b) => b.length - a.length);
  const proper = forms.find(f => /[A-Z]/.test(f.slice(1)));
  return formatTagDisplay(proper || forms[0]);
}

function normalizeTimestampValue(value) {
  if (!value && value !== 0) return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0;
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return 0;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  const str = String(value || '').trim();
  if (!str) return 0;
  if (/^\d{13}$/.test(str)) {
    const num = Number(str);
    return Number.isFinite(num) ? num : 0;
  }
  if (/^\d{10}$/.test(str)) {
    const num = Number(str) * 1000;
    return Number.isFinite(num) ? num : 0;
  }
  const parsed = Date.parse(str);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function extractArticleTimestamp(article) {
  if (!article || typeof article !== 'object') return 0;
  const sources = [article, article.meta || null, article.extra || null];
  const fields = [
    'publishedAt', 'published_at', 'publishedAtMs', 'published_at_ms', 'pubDate', 'pub_date',
    'date', 'datetime', 'timestamp', 'time', 'updatedAt', 'updated_at', 'firstSeenAt',
    'first_seen_at', 'lastUpdated', 'last_updated', 'lastSeenAt', 'last_seen_at'
  ];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const field of fields) {
      if (!(field in source)) continue;
      const ms = normalizeTimestampValue(source[field]);
      if (ms) return ms;
    }
  }
  return 0;
}

function recordTagStat({ stats, tag, article, markets = [], sourceLabel = '', collected, targetCount }) {
  const normalized = normalizeTagCandidate(tag);
  if (!normalized) return false;
  const key = normalized.toLowerCase();
  let entry = stats.get(key);
  if (!entry) {
    entry = {
      key,
      forms: new Set(),
      display: normalized,
      count: 0,
      markets: new Set(),
      sources: new Set(),
      headlines: [],
      headlineKeys: new Set(),
      latestPublishedAt: 0,
      recencySum: 0,
      recencySamples: 0,
      recentHits: 0
    };
    stats.set(key, entry);
  }

  entry.count += 1;
  entry.forms.add(normalized);
  if (!entry.display || normalized.length > entry.display.length) {
    entry.display = normalized;
  }

  for (const market of markets || []) {
    const val = String(market || '').trim();
    if (val) entry.markets.add(val);
  }
  if (article?.market) entry.markets.add(article.market);

  const source = String(article?.source || sourceLabel || '').trim();
  if (source) entry.sources.add(source);

  if (article?.title && article?.url) {
    const keyStr = `${article.url}__${article.title}`;
    if (!entry.headlineKeys.has(keyStr) && entry.headlines.length < 3) {
      entry.headlineKeys.add(keyStr);
      entry.headlines.push({ title: article.title, url: article.url, source: article.source || sourceLabel || 'news' });
    }
  }

  const publishedMs = extractArticleTimestamp(article);
  if (publishedMs) {
    if (!entry.latestPublishedAt || publishedMs > entry.latestPublishedAt) {
      entry.latestPublishedAt = publishedMs;
    }
    if (!entry.recencySamples) entry.recencySamples = 0;
    if (!entry.recencySum) entry.recencySum = 0;
    const nowMs = Date.now();
    const hoursAgo = Math.max(0, (nowMs - publishedMs) / 3600000);
    const lookbackHours = TAG_RECENCY_LOOKBACK_HOURS > 0 ? TAG_RECENCY_LOOKBACK_HOURS : 24;
    const recencySample = lookbackHours > 0 ? to01(1 - (hoursAgo / lookbackHours)) : 0;
    entry.recencySum += recencySample;
    entry.recencySamples += 1;
    if (hoursAgo <= 48) {
      entry.recentHits = (entry.recentHits || 0) + 1;
    }
  }

  if (collected && collected.length < targetCount) {
    collected.push(normalized);
  }

  return true;
}

function createKeywordRegex(keyword) {
  const normalized = String(keyword || '').trim();
  if (!normalized) return null;
  const escaped = normalized
    .replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const hasHangul = /[가-힣]/.test(normalized);
  if (hasHangul) {
    return new RegExp(escaped, 'i');
  }
  const chars = [...normalized];
  const startsWord = chars.length ? /\w/.test(chars[0]) : false;
  const endsWord = chars.length ? /\w/.test(chars[chars.length - 1]) : false;
  const pattern = startsWord && endsWord ? `\\b${escaped}\\b` : escaped;
  return new RegExp(pattern, 'i');
}

const BUSINESS_TAG_COMPANY_KEYWORDS = [
  'samsung',
  '삼성',
  'samsung electronics',
  '삼성전자',
  'samsung heavy',
  '삼성중공업',
  'hyundai',
  '현대',
  'hyundai motor',
  '현대차',
  'hyundai heavy',
  '현대중공업',
  'korea shipbuilding',
  '한국조선해양',
  'hanwha ocean',
  '한화오션',
  'hanwha',
  '한화',
  'kia',
  '기아',
  'lg',
  '엘지',
  'lg energy solution',
  'lg에너지솔루션',
  'lg chem',
  'lg화학',
  'lg electronics',
  'lg전자',
  'sk hynix',
  'sk하이닉스',
  'sk innovation',
  'sk이노베이션',
  'sk telecom',
  'sk텔레콤',
  'posco',
  '포스코',
  'lotte',
  '롯데',
  'doosan',
  '두산',
  'naver',
  '네이버',
  'kakao',
  '카카오',
  'celltrion',
  '셀트리온',
  'amorepacific',
  '아모레퍼시픽',
  'korean air',
  '대한항공',
  'asiana',
  '아시아나',
  'hanjin',
  '한진',
  'daewoo',
  '대우',
  'kepco',
  '한전',
  'korea electric power',
  '한국전력',
  'korea gas',
  '한국가스공사',
  's-oil',
  '에쓰오일',
  'korea zinc',
  '고려아연',
  'hybe',
  '하이브',
  'cj cheiljedang',
  'cj제일제당',
  'cj logistics',
  'cj대한통운',
  'ls electric',
  'ls일렉트릭',
  'lotte chemical',
  '롯데케미칼',
  'gs engineering',
  'gs건설',
  'hyundai engineering',
  '현대엔지니어링',
  'hyundai mobis',
  '현대모비스',
  'kia motors',
  'kia corporation',
  'samsung sdi',
  '삼성sdi'
];

const BUSINESS_TAG_INDUSTRY_KEYWORDS = [
  'shipbuilding',
  '조선',
  'semiconductor',
  '반도체',
  'battery',
  '배터리',
  'electric vehicle',
  '전기차',
  'mobility',
  '모빌리티',
  'defense',
  '방산',
  'biotech',
  '바이오',
  'pharma',
  '제약',
  'steel',
  '철강',
  'automotive',
  '자동차',
  'logistics',
  '물류',
  'construction',
  '건설',
  'aerospace',
  '항공',
  'bank',
  '은행',
  'finance',
  '금융',
  'investment',
  '투자',
  'brokerage',
  '증권',
  'lithium',
  '리튬',
  'petrochemical',
  '석유화학',
  'energy',
  '에너지',
  'oil',
  '유가',
  'gas',
  '가스',
  'refining',
  '정유',
  'orders',
  '수주',
  'exports',
  '수출',
  'earnings',
  '실적',
  'merger',
  '인수합병',
  'ipo',
  '상장',
  'dividend',
  '배당'
];

const BUSINESS_TAG_COMPANY_REGEXES = BUSINESS_TAG_COMPANY_KEYWORDS
  .map(createKeywordRegex)
  .filter(Boolean);
const BUSINESS_TAG_INDUSTRY_REGEXES = BUSINESS_TAG_INDUSTRY_KEYWORDS
  .map(createKeywordRegex)
  .filter(Boolean);

function computeBusinessTagWeight(entry, displayText = '') {
  const segments = new Set();
  if (displayText) segments.add(displayText);
  if (entry?.display) segments.add(entry.display);
  if (entry?.forms && typeof entry.forms[Symbol.iterator] === 'function') {
    for (const value of entry.forms) {
      if (value) segments.add(value);
    }
  }
  if (Array.isArray(entry?.headlines)) {
    for (const headline of entry.headlines) {
      if (headline?.title) segments.add(headline.title);
    }
  }

  const haystack = Array.from(segments)
    .map(part => String(part || '').trim())
    .filter(Boolean)
    .join(' ');

  if (!haystack) return 1;

  const companyMatch = BUSINESS_TAG_COMPANY_REGEXES.some(regex => regex.test(haystack));
  const industryMatch = BUSINESS_TAG_INDUSTRY_REGEXES.some(regex => regex.test(haystack));

  if (!companyMatch && !industryMatch) {
    return 1;
  }

  return 1 + (companyMatch ? 0.6 : 0) + (industryMatch ? 0.3 : 0);
}

function buildTagQueryConfigs() {
  const configs = [];
  const seen = new Set();
  const pushConfig = (query, markets, sourceLabel) => {
    const cleaned = normalizeTagCandidate(query);
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    configs.push({ query: cleaned, markets: Array.isArray(markets) ? markets : [], source: sourceLabel });
  };

  for (const cfg of DATALAB_FALLBACK_KEYWORDS) {
    if (cfg?.text?.en) {
      pushConfig(cfg.text.en, cfg.markets || [], 'naver-datalab');
    }
    for (const aq of cfg.articleQueries || []) {
      if (!aq?.query) continue;
      const locales = Array.isArray(aq.locales) ? aq.locales : [];
      if (locales.length && !locales.includes('en')) continue;
      pushConfig(aq.query, cfg.markets || [], 'naver-datalab');
    }
  }

  for (const mk of KEYWORD_MARKET_QUERIES) {
    for (const query of mk.queries || []) {
      if (!/[A-Za-z]/.test(query)) continue;
      pushConfig(query, [mk.market], 'market-query');
    }
  }

  return configs;
}

function isRateLimitError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('http 429') || msg.includes('status 429') || msg.includes('too many requests');
}

function retryAfterMsFromError(err, fallback = 5000) {
  const headers = err?.responseHeaders || err?.headers || {};
  const retryAfter = headers['retry-after'] || headers['Retry-After'];
  const parsed = retryAfter ? Number(retryAfter) : NaN;
  if (!Number.isNaN(parsed) && parsed > 0) {
    return parsed * 1000;
  }
  return fallback;
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rebuildTagStatsFromSnapshot(snapshot) {
  const stats = new Map();
  if (!snapshot) return stats;
  const pushEntry = (sourceText, meta = {}) => {
    const normalized = normalizeTagCandidate(sourceText);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    const entry = {
      key,
      forms: new Set([normalized]),
      display: normalized,
      count: Number(meta?.mentions || meta?.count || 1) || 1,
      markets: new Set(Array.isArray(meta?.markets) ? meta.markets.filter(Boolean) : []),
      sources: new Set(Array.isArray(meta?.sources) ? meta.sources.filter(Boolean) : []),
      headlines: Array.isArray(meta?.sampleHeadlines) ? meta.sampleHeadlines.slice(0, 3) : [],
      headlineKeys: new Set(),
      latestPublishedAt: normalizeTimestampValue(meta?.latestPublishedAt || meta?.lastSeenAt || meta?.last_seen_at || 0),
      recencySum: 0,
      recencySamples: 0,
      recentHits: 0
    };
    stats.set(key, entry);
  };

  if (Array.isArray(snapshot?.discovered_keywords)) {
    for (const item of snapshot.discovered_keywords) {
      const sourceText = item?.term || item?.text?.en || item?.text || '';
      pushEntry(sourceText, { count: item?.count });
    }
  }

  if (!stats.size && Array.isArray(snapshot?.ranked)) {
    for (const item of snapshot.ranked) {
      const sourceText = item?.text?.en || item?.text?.ko || item?.display || item?.text || '';
      pushEntry(sourceText, {
        count: item?.mentions || item?.count,
        markets: item?.markets,
        sources: item?.sources,
        sampleHeadlines: item?.sampleHeadlines
      });
    }
  }
  return stats;
}

// ============= Yahoo Finance News scraper =============
async function fetchYahooFinanceTopics() {
  const topics = new Set();

  try {
    const rssUrl = 'https://finance.yahoo.com/news/rssindex';
    const xml = await fetchTextWithFallback([
      { url: rssUrl, headers: { Accept: 'application/rss+xml' } }
    ], { timeoutMs: 8000, label: 'Yahoo Finance RSS' });

    if (!xml) return [];

    const titleMatches = xml.match(/<title>(?:<!\[CDATA\[)?([^<]+)(?:\]\]>)?<\/title>/gi) || [];
    for (const match of titleMatches.slice(2)) {
      const text = match
        .replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/<[^>]*>/g, '')
        .trim();

      if (text.length > 10 && text.length < 150) {
        const keywords = extractEnglishKeywords(text);
        keywords.forEach(k => {
          if (k.token.length >= 3) topics.add(k.token);
        });
      }
    }
  } catch (err) {
    console.warn('[keywords] Yahoo Finance RSS failed:', err.message);
  }

  return Array.from(topics).slice(0, 30);
}

// ============= Google News RSS scraper =============
async function fetchGoogleNewsTopics() {
  const topics = new Set();
  const rssUrls = [
    'https://news.google.com/rss/search?q=stock+market&hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en', // Business
    'https://news.google.com/rss/search?q=KOSPI+OR+KOSDAQ&hl=ko&gl=KR&ceid=KR:ko',
  ];

  for (const url of rssUrls) {
    try {
      const xml = await fetchTextWithFallback([
        { url, headers: { Accept: 'application/rss+xml,application/xml,text/xml' } }
      ], { timeoutMs: 8000, label: 'Google News RSS' });

      if (!xml) continue;

      // Extract titles from RSS
      const titleMatches = xml.match(/<title>(?:<!\[CDATA\[)?([^<]+)(?:\]\]>)?<\/title>/gi) || [];
      for (const match of titleMatches) {
        const text = match
          .replace(/<!\[CDATA\[|\]\]>/g, '')
          .replace(/<[^>]*>/g, '')
          .trim();

        if (text.length > 10 && text.length < 150) {
          const enKeywords = extractEnglishKeywords(text);
          enKeywords.forEach(k => topics.add(k.token));

          const koKeywords = extractKoreanKeywords(text);
          koKeywords.forEach(k => topics.add(k.token));
        }
      }

    } catch (err) {
      console.warn('[keywords] Google News RSS fetch failed:', err.message);
    }
  }

  return Array.from(topics).slice(0, 30);
}

// ============= Enhanced Naver DataLab keyword collector =============
async function fetchNaverDatalabTrendingKeywords({ limit = 20 } = {}) {
  const NAVER_ID = process.env.NAVER_CLIENT_ID || '';
  const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || '';

  if (!NAVER_ID || !NAVER_SECRET) return [];

  // Use shopping/trend keywords as seeds
  const seedGroups = [
    { keyword: '반도체', category: 'tech' },
    { keyword: 'AI', category: 'tech' },
    { keyword: '2차전지', category: 'tech' },
    { keyword: '바이오', category: 'health' },
    { keyword: '금리', category: 'finance' },
    { keyword: '환율', category: 'finance' },
    { keyword: '증시', category: 'market' },
    { keyword: 'IT', category: 'tech' },
  ];

  const today = new Date();
  const end = today.toISOString().slice(0, 10);
  const start = new Date(today.getTime() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const results = [];

  for (const batch of chunk(seedGroups, 5)) {
    try {
      const res = await fetchNaverDataLabBatch(batch.map(g => ({
        groupName: g.keyword,
        keyword: g.keyword
      })), {
        startDate: start,
        endDate: end,
        timeUnit: 'date',
        NAVER_ID,
        NAVER_SECRET
      });

      for (const group of batch) {
        const data = res[group.keyword];
        if (!data) continue;

        const popularity = Number(data.popularity01 || 0);
        const spike = data.spike ? 1 : 0;
        const asvi = Number(data.lastAsvi || 0);

        // Weight by popularity + spike
        const score = popularity * 100 + spike * 20 + Math.max(0, asvi);

        results.push({
          term_ko: group.keyword,
          score,
          source: 'naver-datalab',
          category: group.category
        });
      }

    } catch (err) {
      console.warn('[keywords] Naver DataLab batch failed:', err.message);
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ============= KOREAN-FIRST COLLECTION FUNCTIONS =============

const KO_DOMAIN_BOOST = new Set([
  '주식'
]);

async function scrapeDaumRealtimeTrends() {
  try {
    const text = await fetchTextWithFallback([
      { url: 'https://www.daum.net/', headers: { Accept: 'text/html' } }
    ], { timeoutMs: 8000, label: 'Daum trends' });

    if (!text) return [];

    const root = parse(text);
    const keywords = [];
    const selectors = ['.link_favorsch', '.link_txt', '.tit_g'];

    for (const selector of selectors) {
      const links = root.querySelectorAll(selector);
      for (const link of links) {
        const txt = link.text.trim().replace(/^\d+\.?\s*/, '');
        if (txt && txt.length > 1 && containsHangul(txt) && !STOPWORDS_KO.has(txt)) {
          keywords.push({
            term_ko: txt,
            source: 'daum',
            score: 20 - keywords.length
          });
        }
        if (keywords.length >= 20) break;
      }
      if (keywords.length >= 20) break;
    }

    console.log(`[Daum] collected ${keywords.length} keywords`);
    return keywords;
  } catch (err) {
    console.warn('[Daum] scrape failed:', err.message);
    return [];
  }
}

async function scrapeNateIssueTrends() {
  try {
    const text = await fetchTextWithFallback([
      { url: 'https://news.nate.com/', headers: { Accept: 'text/html' } }
    ], { timeoutMs: 8000, label: 'Nate trends' });

    if (!text) return [];

    const root = parse(text);
    const keywords = [];
    const selectors = ['.mlt01 a', '.ranking a', '.issue a'];

    for (const selector of selectors) {
      const items = root.querySelectorAll(selector);
      for (const item of items) {
        const txt = item.text.trim().replace(/^\d+\.?\s*/, '');
        if (txt && txt.length > 1 && containsHangul(txt) && !STOPWORDS_KO.has(txt)) {
          keywords.push({
            term_ko: txt,
            source: 'nate',
            score: 15 - keywords.length
          });
        }
        if (keywords.length >= 15) break;
      }
      if (keywords.length >= 15) break;
    }

    console.log(`[Nate] collected ${keywords.length} keywords`);
    return keywords;
  } catch (err) {
    console.warn('[Nate] scrape failed:', err.message);
    return [];
  }
}

async function extractNaverNewsKeywords() {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET || SKIP_NAVER) return [];

  const queries = [
    '주식',
    '주식 시장',
    '증권',
    '코스피',
    '코스닥',
    'S&P 500',
    'S&P500',
    'NASDAQ',
    '나스닥'
  ];
  const keywordMap = new Map();

  for (const query of queries) {
    try {
      const res = await naverSearch({ query, NAVER_ID: NAVER_CLIENT_ID, NAVER_SECRET: NAVER_CLIENT_SECRET });

      for (const item of res?.items || []) {
        const title = stripHtml(item.title);
        const desc = stripHtml(item.description);
        const text = `${title} ${desc}`;

        const matches = text.match(/[가-힣]{2,4}/g) || [];

        for (const match of matches) {
          if (STOPWORDS_KO.has(match) || match.length < 2) continue;

          const key = match.toLowerCase();
          const existing = keywordMap.get(key);
          if (existing) {
            existing.score += 1;
          } else {
            keywordMap.set(key, {
              term_ko: match,
              source: 'naver-news',
              score: 1
            });
          }
        }
      }
    } catch (err) {
      console.warn(`[Naver News] query "${query}" failed:`, err.message);
    }
  }

  const results = Array.from(keywordMap.values())
    .filter(k => k.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);

  console.log(`[Naver News] extracted ${results.length} keywords from ${keywordMap.size} unique terms`);
  return results;
}

async function aggregateKoreanKeywords(allKeywords) {
  const aggregated = new Map();

  for (const kw of allKeywords) {
    const normalizedKo = normalizeKoKeywordTerm(kw.term_ko || kw.term || '');
    if (!normalizedKo) continue;

    const key = normalizedKo.toLowerCase();
    const existing = aggregated.get(key);

    if (existing) {
      existing.count += 1;
      existing.score += Number(kw.score || 1);
      existing.sources.add(kw.source || 'unknown');
    } else {
      aggregated.set(key, {
        term_ko: normalizedKo,
        count: 1,
        score: Number(kw.score || 1),
        sources: new Set([kw.source || 'unknown'])
      });
    }
  }

  let results = Array.from(aggregated.values()).map(item => {
    const domainBoost = KO_DOMAIN_BOOST.has(item.term_ko) ? 1.5 : 1.0;
    const diversityBonus = Math.min(item.sources.size, 3) * 0.2;
    const creditValue = getTagCreditValue(item.term_ko);
    const creditBoost = Math.min(creditValue * TAG_CREDIT_WEIGHT, TAG_CREDIT_MAX_BOOST);
    const multiplier = domainBoost * (1 + diversityBonus) * (1 + creditBoost);

    return {
      ...item,
      sources: Array.from(item.sources),
      originalScore: item.score,
      score: item.score * multiplier,
      credit: creditValue,
      creditBoost
    };
  });

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.count !== a.count) return b.count - a.count;
    return a.term_ko.localeCompare(b.term_ko, 'ko');
  });

  return results.slice(0, 50);
}

async function translateKoreanKeywordToEnglish(koTerm) {
  const dictResult = translateTagToKo(koTerm);
  if (dictResult && dictResult !== koTerm) return dictResult;

  const cached = TRANSLATION_CACHE.get(koTerm.toLowerCase());
  if (cached && cached !== koTerm) return cached;

  if (DEEPL_API_KEY) {
    try {
      const deepl = await translateWithDeepL(koTerm, { sourceLang: 'KO', targetLang: 'EN' });
      if (deepl && deepl !== koTerm) {
        setTranslationCache(deepl, koTerm);
        return deepl;
      }
    } catch (err) {
      console.warn(`[DeepL] translation failed for "${koTerm}":`, err.message);
    }
  }

  const translatorModule = await ensureTranslationModule();
  if (translatorModule) {
    try {
      const result = await translatorModule(koTerm, { from: 'ko', to: 'en' });
      const translated = String(result?.text || '').trim();
      if (translated && translated !== koTerm) {
        setTranslationCache(translated, koTerm);
        return translated;
      }
    } catch (err) {
      console.warn(`[Google] translation failed for "${koTerm}":`, err?.message || err);
    }
  }

  return koTerm;
}

export async function collectKoreanFirstKeywords({ targetCount = 30 } = {}) {
  console.log('[Korean-First] Starting keyword collection...');

  const allKeywords = [];

  const collectors = [
    scrapeDaumRealtimeTrends(),
    scrapeNateIssueTrends(),
    extractNaverNewsKeywords(),
    fetchInvestZumIssueKeywords({ maxEntries: 40 }),
    fetchEIECEconomyKeywords({ maxEntries: 60 }),
  ];

  const results = await Promise.allSettled(collectors);

  for (const result of results) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      allKeywords.push(...result.value);
    } else if (result.status === 'rejected') {
      console.warn('[Korean-First] collector failed:', result.reason?.message);
    }
  }

  console.log(`[Korean-First] collected ${allKeywords.length} raw keywords`);

  const aggregated = await aggregateKoreanKeywords(allKeywords);
  console.log(`[Korean-First] aggregated to ${aggregated.length} unique keywords`);

  const topKeywords = aggregated.slice(0, targetCount);

  console.log('[Korean-First] translating to English...');
  const translatedKeywords = [];

  for (const kw of topKeywords) {
    const enTerm = await translateKoreanKeywordToEnglish(kw.term_ko);
    translatedKeywords.push({
      term: enTerm,
      term_ko: kw.term_ko,
      score: kw.score,
      count: kw.count,
      sources: kw.sources
    });

    await new Promise(r => setTimeout(r, 50));
  }

  console.log(`[Korean-First] completed with ${translatedKeywords.length} keywords`);

  return {
    keywords: translatedKeywords,
    totalRaw: allKeywords.length,
    uniqueTerms: aggregated.length
  };
}

export async function writeKoreanFirstTagsJson({ outputPath = TAG_OUTPUT_FILE, preCollected = null } = {}) {
  const existingSnapshot = readJsonSafe(outputPath) || null;

  primeTranslationCacheFromSnapshot(existingSnapshot);

  const { keywords, totalRaw, uniqueTerms } = preCollected || await collectKoreanFirstKeywords({ targetCount: 30 });

  if (!keywords.length) {
    console.warn('[Korean-First] no keywords collected, using fallback');
    if (existingSnapshot) return existingSnapshot;
    return null;
  }

  const translations = {};
  for (const kw of keywords) {
    if (kw.term && kw.term_ko) {
      translations[kw.term] = {
        en: kw.term,
        ko: kw.term_ko,
        translator: DEEPL_API_KEY ? 'deepl' : 'google'
      };
    }
  }

  const now = new Date();
  const payload = {
    date: now.toISOString().slice(0, 10),
    window: '5_hours',
    total_articles: totalRaw,
    discovered_keywords: keywords.map(kw => ({
      term: kw.term,
      term_ko: kw.term_ko
    })),
    translations,
    metadata: {
      collection_method: 'korean_first',
      unique_terms: uniqueTerms,
      sources_used: Array.from(new Set(keywords.flatMap(k => k.sources))),
      domain_keywords: keywords.filter(k => KO_DOMAIN_BOOST.has(k.term_ko)).length,
      generated_at: now.toISOString()
    }
  };

  ensureDirFor(outputPath);
  await fsp.writeFile(outputPath, JSON.stringify(payload, null, 2));

  console.log(`[Korean-First] wrote ${outputPath} with ${keywords.length} keywords`);
  console.log(`[Korean-First] sources: ${payload.metadata.sources_used.join(', ')}`);

  return payload;
}

export function verifyTagSnapshot(snapshot) {
  const summary = {
    ok: false,
    total: 0,
    errors: [],
    sample: [],
  };

  if (!snapshot || typeof snapshot !== 'object') {
    summary.errors.push('snapshot_missing');
    return summary;
  }

  const keywords = Array.isArray(snapshot.discovered_keywords)
    ? snapshot.discovered_keywords
    : Array.isArray(snapshot.keywords)
      ? snapshot.keywords
      : [];

  summary.total = keywords.length;

  if (!keywords.length) {
    summary.errors.push('no_keywords');
    return summary;
  }

  let validCount = 0;
  for (const entry of keywords) {
    if (!entry || typeof entry !== 'object') {
      summary.errors.push('invalid_entry');
      continue;
    }
    const termKo = normalizeKoKeywordTerm(entry.term_ko || entry.term || '');
    const term = formatTagDisplay(entry.term || termKo || '');
    if (!termKo) {
      summary.errors.push('missing_term_ko');
      continue;
    }
    if (!containsHangul(termKo)) {
      summary.errors.push('term_ko_not_hangul');
      continue;
    }
    if (!term) {
      summary.errors.push('missing_term_en');
      continue;
    }
    if (summary.sample.length < 5) {
      summary.sample.push({ term, term_ko: termKo });
    }
    validCount += 1;
  }

  if (!validCount) {
    if (!summary.errors.length) summary.errors.push('no_valid_keywords');
    return summary;
  }

  summary.ok = summary.errors.length === 0;
  return summary;
}

// REDESIGNED: Extract significant 2-4 word phrases that signal newsworthy events
// Focus: "조선업체 호황" not "환율"

const SIGNIFICANT_CONTEXT_TARGET = '주식';
const SIGNIFICANT_CONTEXT_WINDOW_WORDS = Math.max(Number.parseInt(process.env.SIGNIFICANT_CONTEXT_WINDOW_WORDS, 10) || 3, 1);
const SIGNIFICANT_LOOKUP_WINDOW_HOURS = Math.max(Number.parseInt(process.env.SIGNIFICANT_LOOKUP_WINDOW_HOURS, 10) || 12, 1);

// Signal words that indicate something SIGNIFICANT is happening
const SIGNAL_WORDS = {
  positive: new Set([
    '주식'
  ]),
  negative: new Set([
    '위기', '급락', '적자', '파산', '중단', '폐쇄', '감소', '하락',
    '붕괴', '최악', '침체', '부진', '타격', '손실', '위축'
  ]),
  change: new Set([
    '전환', '변화', '전환점', '시작', '종료', '중단', '재개', '조정',
    '개편', '개혁', '혁신', '전환기'
  ]),
  policy: new Set([
    '규제', '완화', '강화', '발표', '계획', '정책', '승인', '허가',
    '금지', '제재', '개정', '시행'
  ])
};

// Domain-specific contexts that matter
const SIGNIFICANT_CONTEXTS = new Set([
  // Industries
  '반도체', '2차전지', '조선', '해운', '자동차', '바이오', '방산',
  '디스플레이', '철강', '항공', '건설', '부동산', '금융',

  // Economic indicators
  '수출', '수입', '무역수지', '환율', '금리', '물가', 'GDP', 'CPI',

  // Market movers
  'AI', 'HBM', '전기차', '원자력', '수소', '태양광', 'LNG'
]);

const FINANCE_PRIORITY_KEYWORDS = new Map([
  ['금융', 36],
  ['경제', 30],
  ['비즈니스', 26],
  ['마케팅', 18],
  ['증시', 34],
  ['주식', 32],
  ['주가', 30],
  ['시장', 22],
  ['산업', 18],
  ['은행', 32],
  ['투자', 30],
  ['채권', 24],
  ['펀드', 24],
  ['자본', 18],
  ['거래', 16],
  ['환율', 34],
  ['금리', 34],
  ['통화', 20],
  ['재정', 18],
  ['고용', 16],
  ['finance', 28],
  ['financial', 28],
  ['economy', 26],
  ['economic', 26],
  ['business', 22],
  ['marketing', 18],
  ['stock', 22],
  ['stocks', 22],
  ['market', 20],
  ['markets', 20],
  ['bank', 26],
  ['banking', 26],
  ['invest', 22],
  ['investment', 26],
  ['investor', 20],
  ['fiscal', 18],
  ['monetary', 18]
]);

function computeFinanceKeywordBoost(text) {
  if (!text) return 0;
  let boost = 0;
  const raw = String(text);
  const lower = raw.toLowerCase();
  for (const [keyword, weight] of FINANCE_PRIORITY_KEYWORDS.entries()) {
    if (!keyword) continue;
    if (/[\u3131-\u318E\uAC00-\uD7A3]/.test(keyword)) {
      if (raw.includes(keyword)) {
        boost += weight;
      }
    } else if (lower.includes(keyword)) {
      boost += weight;
    }
  }
  return boost;
}

// Extract 2-4 word meaningful phrases from text, with additional context around 주식
function extractSignificantPhrases(text) {
  if (!text) return [];

  const cleaned = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^가-힣A-Za-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return [];

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2) return [];

  const phrases = [];
  const seen = new Map();

  const mergeMeta = (existingMeta, extraMeta) => {
    const base = existingMeta && typeof existingMeta === 'object' ? { ...existingMeta } : {};
    for (const [key, value] of Object.entries(extraMeta || {})) {
      if (value === undefined || value === null) continue;
      if (base[key] === undefined) {
        base[key] = value;
      } else if (Array.isArray(base[key])) {
        const arr = Array.isArray(value) ? value : [value];
        base[key] = Array.from(new Set([...base[key], ...arr]));
      } else if (Array.isArray(value)) {
        base[key] = Array.from(new Set([base[key], ...value]));
      } else if (base[key] !== value) {
        base[key] = Array.from(new Set([base[key], value]));
      }
    }
    return base;
  };

  const pushPhrase = (phraseText, meta = null) => {
    const normalized = String(phraseText || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    const tokens = normalized.split(/\s+/).filter(Boolean);
    if (tokens.length < 2 || tokens.length > 4) return;
    const key = normalized;
    if (seen.has(key)) {
      if (meta) {
        const existing = seen.get(key);
        existing.meta = mergeMeta(existing.meta, meta);
      }
      return;
    }

    const entry = { text: normalized, length: tokens.length };
    if (meta && Object.keys(meta).length) {
      entry.meta = { ...meta };
    }
    phrases.push(entry);
    seen.set(key, entry);
  };

  // Extract 2-word and 3-word combinations using significance heuristics
  for (let i = 0; i < words.length - 1; i++) {
    const phrase2 = `${words[i]} ${words[i + 1]}`;
    if (isPhraseSignificant(phrase2)) {
      pushPhrase(phrase2);
    }

    if (i < words.length - 2) {
      const phrase3 = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      if (isPhraseSignificant(phrase3)) {
        pushPhrase(phrase3);
      }
    }
  }

  // Capture nearby phrases around the 주식 keyword even if the term itself is absent
  const contextEntries = extractContextPhrasesAroundTerm(words, {
    target: SIGNIFICANT_CONTEXT_TARGET,
    windowSize: SIGNIFICANT_CONTEXT_WINDOW_WORDS
  });

  for (const entry of contextEntries) {
    pushPhrase(entry.text, {
      contextTarget: SIGNIFICANT_CONTEXT_TARGET,
      includesTarget: entry.includesTarget,
      contextPosition: entry.position,
      contextWindow: entry.windowSize
    });
  }

  return phrases;
}

function extractContextPhrasesAroundTerm(words, { target = '', windowSize = 2 } = {}) {
  if (!Array.isArray(words) || !words.length) return [];
  const normalizedTarget = String(target || '').trim();
  if (!normalizedTarget) return [];

  const parsedWindow = Number(windowSize);
  const maxWindow = Number.isFinite(parsedWindow) && parsedWindow >= 1
    ? Math.min(6, Math.floor(parsedWindow))
    : 2;

  const hasHangul = (value) => /[가-힣]/.test(String(value || ''));
  const results = [];
  const seen = new Set();

  const addPhrase = (phraseWords, meta) => {
    if (!Array.isArray(phraseWords) || phraseWords.length < 2) return;
    const normalizedWords = phraseWords
      .map(word => String(word || '').trim())
      .filter(Boolean);
    if (normalizedWords.length < 2 || normalizedWords.length > 4) return;
    if (!normalizedWords.some(hasHangul)) return;
    const phraseText = normalizedWords.join(' ');
    if (!phraseText || seen.has(phraseText)) return;
    seen.add(phraseText);
    results.push({
      text: phraseText,
      includesTarget: Boolean(meta?.includesTarget),
      position: meta?.position || 'around',
      windowSize: maxWindow
    });
  };

  for (let idx = 0; idx < words.length; idx++) {
    const token = String(words[idx] || '').trim();
    if (!token || !token.includes(normalizedTarget)) continue;

    const start = Math.max(0, idx - maxWindow);
    const end = Math.min(words.length, idx + maxWindow + 1);
    const contextSlice = words.slice(start, end);

    for (let offset = 0; offset < contextSlice.length; offset++) {
      for (let len = 2; len <= Math.min(4, contextSlice.length); len++) {
        if (offset + len > contextSlice.length) break;
        const segment = contextSlice.slice(offset, offset + len);
        const includesTarget = segment.some(word => String(word || '').includes(normalizedTarget));
        if (!includesTarget) continue;
        addPhrase(segment, { includesTarget: true, position: 'around' });
      }
    }

    const beforeWords = words.slice(Math.max(0, idx - maxWindow), idx);
    const afterWords = words.slice(idx + 1, Math.min(words.length, idx + 1 + maxWindow));

    const addContextList = (list, position) => {
      if (!Array.isArray(list) || list.length === 0) return;
      for (let len = 2; len <= Math.min(3, list.length); len++) {
        for (let offset = 0; offset <= list.length - len; offset++) {
          addPhrase(list.slice(offset, offset + len), { includesTarget: false, position });
        }
      }
    };

    addContextList(beforeWords, 'before');
    addContextList(afterWords, 'after');

    if (beforeWords.length && afterWords.length) {
      const beforeTail = beforeWords.slice(-2);
      const afterHead = afterWords.slice(0, 2);

      const bridgeCombos = [];
      bridgeCombos.push([beforeWords[beforeWords.length - 1], afterWords[0]]);
      if (beforeTail.length === 2) {
        bridgeCombos.push([...beforeTail, afterWords[0]]);
      }
      if (afterHead.length === 2) {
        bridgeCombos.push([beforeWords[beforeWords.length - 1], ...afterHead]);
      }

      for (const combo of bridgeCombos) {
        addPhrase(combo, { includesTarget: false, position: 'bridge' });
      }
    }
  }

  return results;
}

// Normalize phrase for diversity comparison
function normalizeForDiversity(text) {
  return String(text || '')
    .replace(/[\s\-]/g, '')
    .replace(/상승|급등|증가/g, '↑')
    .replace(/하락|급락|감소/g, '↓')
    .toLowerCase();
}

// Remove semantically similar phrases
function semanticDedup(phrases, threshold = 0.6) {
  const kept = [];

  for (const phrase of phrases) {
    const tokens = new Set(String(phrase.text || '').split(/\s+/));
    let isDuplicate = false;

    for (const existing of kept) {
      const existingTokens = new Set(String(existing.text || '').split(/\s+/));
      const intersection = new Set([...tokens].filter(x => existingTokens.has(x)));
      const union = new Set([...tokens, ...existingTokens]);
      const similarity = union.size === 0 ? 0 : intersection.size / union.size;

      if (similarity > threshold) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      kept.push(phrase);
    }
  }

  return kept;
}

// Category patterns for diversity
const DIVERSITY_CATEGORIES = {
  rates: /금리|이자|기준금리|interest|rate/i,
  fx: /환율|달러|원화|currency|exchange/i,
  industry: /반도체|조선|2차전지|AI|배터리|semiconductor|battery/i,
  indicators: /CPI|GDP|실업|물가|inflation|employment/i,
  corporate: /실적|수주|매출|영업이익|earnings|revenue/i,
  policy: /정책|규제|연준|Fed|FOMC|policy/i,
  trade: /수출|수입|무역|export|import|trade/i,
  energy: /유가|LNG|에너지|oil|energy/i
};

const DIVERSITY_SIMILARITY_THRESHOLD = Number(process.env.KEYWORD_SIMILARITY_THRESHOLD || 0.6);
const KEYWORDS_PER_CATEGORY = Number(process.env.KEYWORDS_PER_CATEGORY || 4);

// Check if phrase is significant (contains signal + context)
function isPhraseSignificant(phrase) {
  const words = phrase.split(/\s+/);

  // Must be 2-3 words for base significance detection
  if (words.length < 2 || words.length > 3) return false;

  // Must contain at least one Hangul word
  if (!words.some(w => /[가-힣]/.test(w))) return false;

  // Check for signal words (something is HAPPENING)
  const hasSignal = words.some(w =>
    [...SIGNAL_WORDS.positive, ...SIGNAL_WORDS.negative,
     ...SIGNAL_WORDS.change, ...SIGNAL_WORDS.policy].some(sig => w.includes(sig))
  );

  // Check for significant context (industry/indicator)
  const hasContext = words.some(w =>
    Array.from(SIGNIFICANT_CONTEXTS).some(ctx => w.includes(ctx))
  );

  // Must have BOTH signal AND context
  // Example: "조선업체 호황" = context(조선) + signal(호황) ✓
  // Example: "환율" = context(환율) only ✗
  return hasSignal && hasContext;
}

// Categorize and ensure diverse selection
function categorizeAndDiversify(phrases, perCategory = KEYWORDS_PER_CATEGORY) {
  const categories = {};

  for (const phrase of phrases) {
    let assigned = false;
    for (const [cat, pattern] of Object.entries(DIVERSITY_CATEGORIES)) {
      if (pattern.test(phrase.text)) {
        (categories[cat] = categories[cat] || []).push(phrase);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      (categories.other = categories.other || []).push(phrase);
    }
  }

  const diversified = [];
  for (const items of Object.values(categories)) {
    items.sort((a, b) => b.score - a.score);
    const limit = Number.isFinite(perCategory) && perCategory > 0 ? perCategory : items.length;
    diversified.push(...items.slice(0, limit));
  }

  return diversified.sort((a, b) => b.score - a.score);
}

// Score phrases by significance (not frequency)
function scorePhrasesbySignificance(phrases, { datalabKeywords = [] } = {}) {
  const scored = new Map();
  const datalabIndex = Array.isArray(datalabKeywords)
    ? datalabKeywords
        .map(item => ({
          term: normalizeKoKeywordTerm(item?.term_ko || item?.term || ''),
          score: Number(item?.score) || 0,
          category: item?.category || ''
        }))
        .filter(entry => entry.term)
    : [];

  for (const phrase of phrases || []) {
    if (!phrase) continue;
    const rawText = String(phrase?.text || '').replace(/\s+/g, ' ').trim();
    if (!rawText) continue;

    const length = Number.isFinite(phrase?.length) ? phrase.length : rawText.split(/\s+/).length;
    if (length < 2) continue;

    const words = rawText.split(/\s+/);
    const meta = phrase?.meta && typeof phrase.meta === 'object' ? phrase.meta : {};
    const financeBoost = Number.isFinite(meta.financeBoost) ? meta.financeBoost : computeFinanceKeywordBoost(rawText);
    const scoreHint = Number.isFinite(phrase?.scoreHint) ? phrase.scoreHint : 0;

    const providedMatches = Array.isArray(meta.datalabMatches)
      ? meta.datalabMatches.filter(match => match && match.term_ko)
      : [];
    const datalabMatches = providedMatches.length
      ? providedMatches
      : datalabIndex
          .filter(entry => rawText.includes(entry.term))
          .map(entry => ({ term_ko: entry.term, score: entry.score, category: entry.category }));

    let score = length * 10;

    for (const w of words) {
      if ([...SIGNAL_WORDS.positive].some(s => w.includes(s))) score += 32;
      if ([...SIGNAL_WORDS.negative].some(s => w.includes(s))) score += 32;
      if ([...SIGNAL_WORDS.change].some(s => w.includes(s))) score += 26;
      if ([...SIGNAL_WORDS.policy].some(s => w.includes(s))) score += 22;
    }

    for (const w of words) {
      if (Array.from(SIGNIFICANT_CONTEXTS).some(c => w.includes(c))) score += 15;
    }

    score += financeBoost;
    score += scoreHint;

    let datalabBonus = 0;
    for (const match of datalabMatches) {
      if (!match?.term_ko) continue;
      const baseScore = Number(match?.score) || 0;
      datalabBonus += Math.max(18, baseScore * 120);
    }
    score += datalabBonus;

    if (meta.contextTarget === SIGNIFICANT_CONTEXT_TARGET) {
      score += 18;
      if (!meta.includesTarget) score += 6;
      if (meta.contextPosition === 'bridge') score += 4;
    }

    const existing = scored.get(rawText);
    if (existing) {
      existing.count += 1;
      existing.score = Math.max(existing.score, score);
      existing.financeBoost = Math.max(existing.financeBoost, financeBoost);
      if (phrase?.source) existing.sources.add(phrase.source);
      if (Array.isArray(meta.sources)) {
        for (const src of meta.sources) {
          if (src) existing.sources.add(src);
        }
      }
      if (meta.headlines) {
        for (const headline of meta.headlines) {
          if (!headline) continue;
          const key = `${headline.title || ''}__${headline.url || ''}`;
          if (!existing.headlineKeys.has(key) && existing.headlines.length < 3) {
            existing.headlineKeys.add(key);
            existing.headlines.push(headline);
          }
        }
      }
      if (meta.tickerFile) {
        existing.tickerFiles.add(meta.tickerFile);
      }
      if (meta.contextTarget) {
        existing.contextTargets.add(meta.contextTarget);
        if (meta.contextPosition) existing.contextPositions.add(meta.contextPosition);
        if (Number.isFinite(meta.contextWindow)) {
          existing.contextWindows.add(Number(meta.contextWindow));
        }
        if (meta.includesTarget) {
          existing.contextIncludesTarget = true;
        }
      }
      if (datalabMatches.length) {
        for (const match of datalabMatches) {
          if (!match?.term_ko) continue;
          const record = existing.datalabMatches.get(match.term_ko) || { term_ko: match.term_ko, score: 0, hits: 0, categories: new Set() };
          record.score = Math.max(record.score, Number(match.score) || 0);
          record.hits += 1;
          if (match.category) record.categories.add(match.category);
          existing.datalabMatches.set(match.term_ko, record);
        }
      }
      continue;
    }

    const entry = {
      text: rawText,
      count: 1,
      score,
      length,
      financeBoost,
      sources: new Set(),
      datalabMatches: new Map(),
      headlines: [],
      headlineKeys: new Set(),
      tickerFiles: new Set(),
      contextTargets: new Set(),
      contextPositions: new Set(),
      contextIncludesTarget: Boolean(meta.contextTarget && meta.includesTarget),
      contextWindows: new Set()
    };

    if (phrase?.source) {
      entry.sources.add(phrase.source);
    }
    if (Array.isArray(meta.sources)) {
      for (const src of meta.sources) {
        if (src) entry.sources.add(src);
      }
    }
    if (!entry.sources.size) {
      entry.sources.add('news');
    }

    if (meta.headlines) {
      for (const headline of meta.headlines) {
        if (!headline) continue;
        const key = `${headline.title || ''}__${headline.url || ''}`;
        if (!entry.headlineKeys.has(key) && entry.headlines.length < 3) {
          entry.headlineKeys.add(key);
          entry.headlines.push(headline);
        }
      }
    }

    if (meta.tickerFile) {
      entry.tickerFiles.add(meta.tickerFile);
    }

    if (meta.contextTarget) {
      entry.contextTargets.add(meta.contextTarget);
      if (meta.contextPosition) entry.contextPositions.add(meta.contextPosition);
      if (Number.isFinite(meta.contextWindow)) entry.contextWindows.add(Number(meta.contextWindow));
      if (meta.includesTarget) entry.contextIncludesTarget = true;
    }

    for (const match of datalabMatches) {
      if (!match?.term_ko) continue;
      const record = { term_ko: match.term_ko, score: Number(match.score) || 0, hits: 1, categories: new Set() };
      if (match.category) record.categories.add(match.category);
      entry.datalabMatches.set(match.term_ko, record);
    }

    scored.set(rawText, entry);
  }

  const diversityMap = new Map();
  for (const [rawText, entry] of scored.entries()) {
    const normKey = normalizeForDiversity(rawText) || rawText.toLowerCase().replace(/\s+/g, '');
    if (!normKey) continue;

    if (diversityMap.has(normKey)) {
      const existing = diversityMap.get(normKey);
      if (entry.score > existing.score) {
        diversityMap.set(normKey, { ...entry, text: rawText });
      }
    } else {
      diversityMap.set(normKey, { ...entry, text: rawText });
    }
  }

  const dedupedEntries = Array.from(diversityMap.values());

  return dedupedEntries
    .map(entry => ({
      text: entry.text,
      length: entry.length,
      score: Math.round(entry.score),
      count: entry.count,
      financeBoost: entry.financeBoost,
      sources: Array.from(entry.sources),
      datalabMatches: Array.from(entry.datalabMatches.values()).map(match => ({
        term_ko: match.term_ko,
        score: match.score,
        hits: match.hits,
        categories: match.categories ? Array.from(match.categories) : []
      })),
      headlines: entry.headlines.slice(0, 3),
      tickerFiles: Array.from(entry.tickerFiles),
      context: (entry.contextTargets.size || entry.contextPositions.size || entry.contextWindows.size || entry.contextIncludesTarget)
        ? {
            targets: Array.from(entry.contextTargets),
            positions: Array.from(entry.contextPositions),
            includesTarget: entry.contextIncludesTarget,
            windows: Array.from(entry.contextWindows)
          }
        : undefined
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.count !== a.count) return b.count - a.count;
      return b.length - a.length;
    });
}

// Extract from Naver News with phrase focus
async function extractNaverNewsSignificantPhrases() {
  const NAVER_ID = process.env.NAVER_CLIENT_ID || '';
  const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || '';

  if (!NAVER_ID || !NAVER_SECRET || SKIP_NAVER) return [];

  // Query for newsworthy events
  const queries = [
    '주식',
    '주식 시장',
    '코스피',
    '코스닥',
    'S&P 500',
    'NASDAQ'
  ];

  const allPhrases = [];

  for (const query of queries) {
    try {
      const res = await naverSearch({ query, NAVER_ID, NAVER_SECRET });

      for (const item of res?.items || []) {
        const title = stripHtml(item.title);
        const desc = stripHtml(item.description);
        const text = `${title} ${desc}`;

        const phrases = extractSignificantPhrases(text);
        allPhrases.push(...phrases);
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.warn(`[Naver] query "${query}" failed:`, err.message);
    }
  }

  console.log(`[Naver] extracted ${allPhrases.length} candidate phrases`);
  return allPhrases;
}

// Extract from KDI with phrase focus
async function extractKDISignificantPhrases() {
  try {
    const keywords = await fetchEIECEconomyKeywords({ maxEntries: 100 });
    const allPhrases = [];

    // KDI keywords are already meaningful, but let's validate them
    for (const kw of keywords) {
      const text = kw.term_ko || kw.term || '';
      const words = text.split(/\s+/).filter(Boolean);

      if (words.length >= 2 && words.length <= 3) {
        if (isPhraseSignificant(text)) {
          allPhrases.push({ text, length: words.length });
        }
      }
    }

    console.log(`[KDI] extracted ${allPhrases.length} significant phrases`);
    return allPhrases;
  } catch (err) {
    console.warn('[KDI] extraction failed:', err.message);
    return [];
  }
}

// Extract from ZUM with phrase focus
async function extractZumSignificantPhrases() {
  try {
    const keywords = await fetchInvestZumIssueKeywords({ maxEntries: 50 });
    const allPhrases = [];

    // ZUM gives us company names - enhance with context from page
    const response = await fetchTextWithFallback([
      { url: 'https://invest.zum.com/', headers: { Accept: 'text/html' } }
    ], { timeoutMs: 8000, label: 'ZUM phrases' });

    if (response) {
      const phrases = extractSignificantPhrases(response);
      allPhrases.push(...phrases);
    }

    console.log(`[ZUM] extracted ${allPhrases.length} significant phrases`);
    return allPhrases;
  } catch (err) {
    console.warn('[ZUM] extraction failed:', err.message);
    return [];
  }
}

async function collectCachedArticleSignificantPhrases({ datalabKeywords = [] } = {}) {
  const articleDir = path.join('data', 'articles');
  let files = [];
  try {
    files = await fsp.readdir(articleDir);
  } catch (err) {
    console.warn('[Significance] article cache directory missing:', err?.message || err);
    return { phrases: [], stats: { processedArticles: 0, filesProcessed: 0, extractedPhrases: 0, datalabTerms: [] } };
  }

  const jsonFiles = files.filter(name => name.endsWith('.json'));
  if (!jsonFiles.length) {
    return { phrases: [], stats: { processedArticles: 0, filesProcessed: 0, extractedPhrases: 0, datalabTerms: [] } };
  }

  jsonFiles.sort((a, b) => b.localeCompare(a));

  const datalabIndex = Array.isArray(datalabKeywords)
    ? datalabKeywords
        .map(item => ({
          term: normalizeKoKeywordTerm(item?.term_ko || item?.term || ''),
          score: Number(item?.score) || 0,
          category: item?.category || ''
        }))
        .filter(entry => entry.term)
    : [];

  const lookbackHours = SIGNIFICANT_LOOKUP_WINDOW_HOURS > 0 ? SIGNIFICANT_LOOKUP_WINDOW_HOURS : 0;
  const nowMs = Date.now();
  const cutoffMs = lookbackHours ? nowMs - lookbackHours * 3600000 : 0;
  const maxArticles = Number(process.env.CACHED_ARTICLE_TAG_TOTAL_LIMIT || 4000);
  const perFileLimit = Number(process.env.CACHED_ARTICLE_TAG_ARTICLE_LIMIT || 30);
  const maxFileCount = Number(process.env.CACHED_ARTICLE_TAG_FILE_LIMIT || 200);

  const phrases = [];
  let processedArticles = 0;
  let filesProcessed = 0;
  let skippedForRecency = 0;

  for (const file of jsonFiles) {
    if (Number.isFinite(maxFileCount) && maxFileCount > 0 && filesProcessed >= maxFileCount) {
      break;
    }

    let articles = [];
    try {
      const raw = await fsp.readFile(path.join(articleDir, file), 'utf8');
      articles = JSON.parse(raw);
    } catch (err) {
      console.warn(`[Significance] failed to parse cached article file ${file}:`, err?.message || err);
      continue;
    }

    if (!Array.isArray(articles) || !articles.length) {
      continue;
    }

    filesProcessed += 1;
    const subset = Number.isFinite(perFileLimit) && perFileLimit > 0 ? articles.slice(0, perFileLimit) : articles;

    for (const article of subset) {
      if (Number.isFinite(maxArticles) && maxArticles > 0 && processedArticles >= maxArticles) {
        break;
      }

      const publishedMs = extractArticleTimestamp(article);
      if (cutoffMs && publishedMs && publishedMs < cutoffMs) {
        skippedForRecency += 1;
        continue;
      }

      processedArticles += 1;

      const parts = [];
      if (article?.title) parts.push(stripHtml(article.title));
      if (article?.summary) parts.push(stripHtml(article.summary));
      if (article?.body) parts.push(stripHtml(article.body));
      const combined = parts.join(' ').trim();
      if (!combined) continue;

      const extracted = extractSignificantPhrases(combined);
      if (!Array.isArray(extracted) || !extracted.length) continue;

      const headline = article?.title
        ? { title: stripHtml(article.title), url: article?.url || '', source: article?.source || '' }
        : null;

      for (const phrase of extracted) {
        const cleaned = normalizeKoKeywordTerm(phrase?.text || '');
        if (!cleaned) continue;

        const financeBoost = computeFinanceKeywordBoost(cleaned);
        const matches = datalabIndex
          .filter(entry => cleaned.includes(entry.term))
          .map(entry => ({ term_ko: entry.term, score: entry.score, category: entry.category }));

        const baseMeta = phrase?.meta && typeof phrase.meta === 'object' ? { ...phrase.meta } : {};
        const sourceSet = new Set();
        if (Array.isArray(baseMeta.sources)) {
          for (const src of baseMeta.sources) {
            const value = String(src || '').trim();
            if (value) sourceSet.add(value);
          }
        } else if (baseMeta.sources && typeof baseMeta.sources === 'string') {
          const value = baseMeta.sources.trim();
          if (value) sourceSet.add(value);
        }
        const articleSource = String(article?.source || '').trim() || 'article_cache';
        sourceSet.add(articleSource);

        const headlineList = [];
        const headlineSeen = new Set();
        const addHeadline = (item) => {
          if (!item) return;
          const title = String(item.title || '').trim();
          const url = String(item.url || '').trim();
          const key = `${title}__${url}`;
          if (headlineSeen.has(key)) return;
          headlineSeen.add(key);
          headlineList.push({
            title,
            url,
            source: String(item.source || articleSource).trim()
          });
        };

        if (Array.isArray(baseMeta.headlines)) {
          for (const existingHeadline of baseMeta.headlines) {
            addHeadline(existingHeadline);
          }
        }
        if (headline) {
          addHeadline(headline);
        }

        const mergedMatches = Array.isArray(baseMeta.datalabMatches)
          ? [...baseMeta.datalabMatches]
          : [];
        for (const match of matches) {
          if (!match?.term_ko) continue;
          if (!mergedMatches.some(existing => existing && existing.term_ko === match.term_ko)) {
            mergedMatches.push(match);
          }
        }

        const meta = {
          ...baseMeta,
          financeBoost,
          datalabMatches: mergedMatches,
          sources: Array.from(sourceSet).filter(Boolean),
          tickerFile: file
        };

        if (headlineList.length) {
          meta.headlines = headlineList.slice(0, 3);
        }

        if (publishedMs) {
          meta.publishedAtMs = publishedMs;
        }

        phrases.push({
          text: cleaned,
          length: Number.isFinite(phrase?.length) ? phrase.length : cleaned.split(/\s+/).length,
          source: 'article_cache',
          scoreHint: financeBoost,
          meta
        });
      }
    }

    if (Number.isFinite(maxArticles) && maxArticles > 0 && processedArticles >= maxArticles) {
      break;
    }
  }

  console.log(`[Significance] cached article phrases extracted: ${phrases.length} (files: ${filesProcessed}, articles: ${processedArticles}, skipped_recency: ${skippedForRecency})`);

  return {
    phrases,
    stats: {
      processedArticles,
      filesProcessed,
      extractedPhrases: phrases.length,
      datalabTerms: datalabIndex.map(entry => entry.term),
      skippedForRecency
    }
  };
}

// Main collection function
export async function collectSignificantPhrases({ targetCount = 50, datalabKeywords = [] } = {}) {
  console.log(`[Significance] Collecting newsworthy 2-4 word phrases (lookback: ${SIGNIFICANT_LOOKUP_WINDOW_HOURS}h)...`);

  const collectors = [
    extractNaverNewsSignificantPhrases(),
    extractKDISignificantPhrases(),
    extractZumSignificantPhrases()
  ];

  let articleCacheStats = { processedArticles: 0, filesProcessed: 0, extractedPhrases: 0, datalabTerms: [], skippedForRecency: 0 };
  try {
    const articleResult = await collectCachedArticleSignificantPhrases({ datalabKeywords });
    articleCacheStats = articleResult.stats;
    collectors.push(Promise.resolve(articleResult.phrases));
  } catch (err) {
    console.warn('[Significance] failed to derive cached article phrases:', err?.message || err);
  }

  const results = await Promise.allSettled(collectors);
  const allPhrases = [];

  for (const result of results) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      allPhrases.push(...result.value);
    }
  }

  console.log(`[Significance] collected ${allPhrases.length} total phrases`);

  const scored = scorePhrasesbySignificance(allPhrases, { datalabKeywords });

  const previewCount = Math.min(20, scored.length);
  if (previewCount > 0) {
    console.log(`[Significance] Top ${previewCount} by significance score:`);
    scored.slice(0, previewCount).forEach((p, i) => {
      console.log(`  ${i + 1}. "${p.text}" - score: ${p.score}, count: ${p.count}`);
    });
  } else {
    console.log('[Significance] No phrases available for preview');
  }

  const safeTarget = Number.isFinite(targetCount) && targetCount > 0 ? Number(targetCount) : targetCount;
  const candidateLimit = Number.isFinite(safeTarget) && safeTarget > 0
    ? Math.min(scored.length, safeTarget * 3)
    : scored.length;

  let filtered = scored
    .filter(p => p.length >= 2 && p.length <= 4)
    .slice(0, candidateLimit);

  filtered = semanticDedup(filtered, DIVERSITY_SIMILARITY_THRESHOLD);
  filtered = categorizeAndDiversify(filtered, KEYWORDS_PER_CATEGORY);

  const finalTarget = Number.isFinite(safeTarget) && safeTarget > 0 ? safeTarget : filtered.length;
  const final = filtered
    .slice(0, finalTarget)
    .map(p => ({
      term_ko: p.text,
      score: p.score,
      count: p.count,
      length: p.length,
      source: 'significance_analysis',
      metadata: {
        financeBoost: p.financeBoost,
        datalabMatches: p.datalabMatches,
        sources: p.sources,
        headlines: p.headlines,
        tickerFiles: p.tickerFiles,
        ...(p.context ? { context: p.context } : {})
      }
    }));

  return {
    phrases: final,
    meta: {
      articleCache: articleCacheStats,
      datalabTermsUsed: Array.from(new Set(datalabKeywords
        .map(item => normalizeKoKeywordTerm(item?.term_ko || item?.term || ''))
        .filter(Boolean)))
    }
  };
}

// Write output
export async function writeSignificantPhrasesJson({ outputPath = TAG_OUTPUT_FILE } = {}) {
  const desiredCount = Number(process.env.MARKET_TAG_LIMIT || 30) || 30;
  const phraseCollectionTarget = Math.max(desiredCount, Number(process.env.SIGNIFICANT_PHRASE_TARGET || desiredCount) || desiredCount);
  const existingSnapshot = readJsonSafe(outputPath) || null;

  if (existingSnapshot) {
    try {
      primeTranslationCacheFromSnapshot(existingSnapshot);
    } catch (err) {
      console.warn('[Significance] failed to prime translations from existing snapshot:', err?.message || err);
    }
  }
  let financeTrendBoost = [];
  try {
    financeTrendBoost = await fetchFinanceTrendKeywords({ limit: Math.max(16, desiredCount) });
  } catch (err) {
    console.warn('[Significance] failed to fetch finance trend keywords:', err?.message || err);
  }

  const phraseCollection = await collectSignificantPhrases({ targetCount: phraseCollectionTarget, datalabKeywords: financeTrendBoost });
  const phrases = Array.isArray(phraseCollection?.phrases) ? phraseCollection.phrases : [];
  const collectionMeta = phraseCollection?.meta || {};

  if (!phrases.length && !financeTrendBoost.length) {
    console.error('[Significance] No significant phrases found');
    return null;
  }

  const aggregated = new Map();

  const hasAtLeastTwoWords = (value = '') => String(value).trim().split(/\s+/).filter(Boolean).length >= 2;

  const applyMetadataToEntry = (entry, meta) => {
    if (!meta || typeof meta !== 'object') return;

    if (Array.isArray(meta.sources)) {
      for (const src of meta.sources) {
        const value = String(src || '').trim();
        if (value) entry.sources.add(value);
      }
    }

    if (Array.isArray(meta.headlines)) {
      for (const headline of meta.headlines) {
        if (!headline) continue;
        const title = String(headline.title || '').trim();
        const url = String(headline.url || '').trim();
        const source = String(headline.source || '').trim();
        const key = `${title}__${url}`;
        if (!entry.headlineKeys.has(key) && entry.headlines.length < 3) {
          entry.headlineKeys.add(key);
          entry.headlines.push({ title, url, source });
        }
      }
    }

    if (Number.isFinite(meta.financeBoost)) {
      entry.financeBoost = Math.max(Number(entry.financeBoost || 0), Number(meta.financeBoost));
    }

    if (Array.isArray(meta.tickerFiles)) {
      for (const file of meta.tickerFiles) {
        const value = String(file || '').trim();
        if (value) entry.tickerFiles.add(value);
      }
    }

    if (Array.isArray(meta.datalabMatches)) {
      for (const match of meta.datalabMatches) {
        if (!match) continue;
        const term = normalizeKoKeywordTerm(match.term_ko || match.term || '');
        if (!term) continue;
        const record = entry.datalabMatches.get(term) || { term_ko: term, score: 0, hits: 0, categories: new Set() };
        const numericScore = Number(match.score);
        if (Number.isFinite(numericScore)) {
          record.score = Math.max(record.score, numericScore);
        }
        record.hits += Number.isFinite(match.hits) && match.hits > 0 ? match.hits : 1;
        const categories = Array.isArray(match.categories) ? match.categories : [];
        for (const category of categories) {
          const value = String(category || '').trim();
          if (value) record.categories.add(value);
        }
        entry.datalabMatches.set(term, record);
      }
    }

    if (meta.context && typeof meta.context === 'object') {
      if (!entry.contextTargets) entry.contextTargets = new Set();
      if (!entry.contextPositions) entry.contextPositions = new Set();
      if (!entry.contextWindows) entry.contextWindows = new Set();
      if (typeof entry.contextIncludesTarget !== 'boolean') entry.contextIncludesTarget = false;

      const targets = Array.isArray(meta.context.targets)
        ? meta.context.targets
        : (meta.context.targets ? [meta.context.targets] : []);
      for (const target of targets) {
        const value = String(target || '').trim();
        if (value) entry.contextTargets.add(value);
      }

      const positions = Array.isArray(meta.context.positions)
        ? meta.context.positions
        : (meta.context.positions ? [meta.context.positions] : []);
      for (const position of positions) {
        const value = String(position || '').trim();
        if (value) entry.contextPositions.add(value);
      }

      const windows = Array.isArray(meta.context.windows)
        ? meta.context.windows
        : (meta.context.windows ? [meta.context.windows] : []);
      for (const window of windows) {
        const numericWindow = Number(window);
        if (Number.isFinite(numericWindow)) {
          entry.contextWindows.add(numericWindow);
        }
      }

      if (typeof meta.context.includesTarget === 'boolean') {
        if (meta.context.includesTarget) {
          entry.contextIncludesTarget = true;
        }
      }
    }
  };

  const registerEntry = (koTerm, { score = 0, mentions = 1, source = '', english = '', metadata = null } = {}) => {
    const normalizedKo = normalizeKoKeywordTerm(koTerm);
    if (!normalizedKo) return;
    if (!hasAtLeastTwoWords(normalizedKo)) return;

    const significanceScore = Math.max(1, Math.round(score));
    const mentionCount = Math.max(1, Math.round(mentions));
    const sourceLabel = String(source || '').trim();
    const englishHint = formatTagDisplay(english || '');

    if (aggregated.has(normalizedKo)) {
      const existing = aggregated.get(normalizedKo);
      existing.significance_score = Math.max(existing.significance_score, significanceScore);
      existing.mentions = Math.max(existing.mentions, mentionCount);
      if (sourceLabel) existing.sources.add(sourceLabel);
      if (englishHint) existing.englishHints.add(englishHint);
      applyMetadataToEntry(existing, metadata);
      return;
    }

    const sources = new Set();
    if (sourceLabel) sources.add(sourceLabel);
    const englishHints = new Set();
    if (englishHint) englishHints.add(englishHint);

    aggregated.set(normalizedKo, {
      term_ko: normalizedKo,
      significance_score: significanceScore,
      mentions: mentionCount,
      sources,
      englishHints,
      financeBoost: Number.isFinite(metadata?.financeBoost) ? Number(metadata.financeBoost) : 0,
      datalabMatches: new Map(),
      headlines: [],
      headlineKeys: new Set(),
      tickerFiles: new Set(),
      contextTargets: new Set(),
      contextPositions: new Set(),
      contextWindows: new Set(),
      contextIncludesTarget: false
    });

    applyMetadataToEntry(aggregated.get(normalizedKo), metadata);
  };

  for (const phrase of phrases) {
    if (!phrase) continue;
    registerEntry(phrase.term_ko || phrase.term, {
      score: Number.isFinite(phrase.score) ? phrase.score : 0,
      mentions: Number.isFinite(phrase.count) ? phrase.count : 1,
      source: phrase.source || 'significance',
      english: phrase.term,
      metadata: phrase.metadata || null
    });
  }

  try {
    const financeSearchPhrases = await collectRandomFinanceKeywordSearchPhrases({
      sampleSize: 30,
      perKeywordLimit: 6,
      totalLimit: Math.max(desiredCount, 40)
    });
    if (financeSearchPhrases.length) {
      for (const phrase of financeSearchPhrases) {
        registerEntry(phrase.term_ko, {
          score: Number.isFinite(phrase.score) ? phrase.score : 0,
          mentions: Number.isFinite(phrase.mentions) ? phrase.mentions : 1,
          source: 'naver_search'
        });
      }
      console.log(`[Significance] Added ${financeSearchPhrases.length} phrases from Naver finance keyword search`);
    }
  } catch (err) {
    console.warn('[Significance] failed to include finance keyword search phrases:', err?.message || err);
  }

  let injectedTrends = 0;
  for (const trend of financeTrendBoost) {
    if (!trend) continue;
    const koTerm = trend.term_ko || trend.term;
    if (!koTerm) continue;

    const popularity = Number.isFinite(trend?.metrics?.popularity)
      ? trend.metrics.popularity
      : 0;
    const baseScore = Number.isFinite(trend.score) ? trend.score : 0;
    let scaledScore = Math.round(baseScore * 120);
    if (trend?.metrics?.spike) scaledScore += 20;
    if (trend?.metrics?.persist) scaledScore += 10;
    scaledScore = Math.max(50, scaledScore);
    const estimatedMentions = Math.max(1, Math.round(popularity * 20));

    registerEntry(koTerm, {
      score: scaledScore,
      mentions: estimatedMentions,
      source: 'finance_trend',
      english: trend.term
    });
    injectedTrends += 1;
  }

  if (aggregated.size < desiredCount) {
    try {
      const fallback = await collectKoreanFirstKeywords({ targetCount: desiredCount * 2 });
      for (const kw of fallback?.keywords || []) {
        if (!kw) continue;
        registerEntry(kw.term_ko || kw.term, {
          score: Number.isFinite(kw.score) ? kw.score : Number.isFinite(kw.count) ? kw.count : 1,
          mentions: Number.isFinite(kw.count) ? kw.count : 1,
          source: 'korean_first',
          english: kw.term
        });
      }
    } catch (err) {
      console.warn('[Significance] korean-first fallback failed:', err?.message || err);
    }
  }

  if (!aggregated.size) {
    console.error('[Significance] No valid phrases after normalization');
    return null;
  }

  const aggregatedList = Array.from(aggregated.values());
  const maxSignificance = aggregatedList.reduce((acc, item) => Math.max(acc, Number(item.significance_score) || 0), 0);
  const maxMentions = aggregatedList.reduce((acc, item) => Math.max(acc, Number(item.mentions) || 0), 0);

  const ranked = aggregatedList
    .map(item => {
      const significanceRatio = maxSignificance > 0 ? (item.significance_score / maxSignificance) : 0;
      const mentionRatio = maxMentions > 0 ? (item.mentions / maxMentions) : 0;
      const combinedScore = 0.7 * significanceRatio + 0.3 * mentionRatio;
      return { ...item, combined_score: Number(combinedScore.toFixed(6)) };
    })
    .sort((a, b) => {
      if (b.combined_score !== a.combined_score) {
        return b.combined_score - a.combined_score;
      }
      if (b.significance_score !== a.significance_score) {
        return b.significance_score - a.significance_score;
      }
      if (b.mentions !== a.mentions) {
        return b.mentions - a.mentions;
      }
      return a.term_ko.localeCompare(b.term_ko);
    })
    .slice(0, desiredCount);

  let discoveredKeywords = [];
  const usedSignatures = new Set();
  const datalabMatchedTerms = new Set();
  for (const entry of ranked) {
    const koTerm = entry.term_ko;
    const signature = buildKoKeywordSignature(koTerm);
    if (signature) {
      if (usedSignatures.has(signature)) {
        continue;
      }
      usedSignatures.add(signature);
    }
    let termEn = '';
    const englishHints = entry.englishHints ? Array.from(entry.englishHints).map(h => formatTagDisplay(h || '')).filter(Boolean) : [];
    if (englishHints.length) {
      termEn = englishHints.find(text => hasAtLeastTwoWords(text)) || englishHints[0];
    }
    try {
      if (!termEn) {
        const translation = await translateKoTermToEn(koTerm, { includeMeta: true });
        termEn = formatTagDisplay(translation.text || '');
        if (termEn) {
          setTranslationCache(termEn, koTerm);
          if (translation.translator) {
            englishHints.push(termEn);
          }
        }
      }
    } catch (err) {
      console.warn(`[Significance] translation failed for "${koTerm}":`, err?.message || err);
    }

    const finalTerm = termEn || formatTagDisplay(koTerm);
    const keywordRecord = {
      term: finalTerm,
      term_ko: koTerm,
      significance_score: entry.significance_score,
      mentions: entry.mentions,
      combined_score: entry.combined_score
    };

    if (entry.sources && entry.sources.size) {
      keywordRecord.sources = Array.from(entry.sources).sort();
    }

    if (Number.isFinite(entry.financeBoost) && entry.financeBoost > 0) {
      keywordRecord.finance_boost = Number(entry.financeBoost.toFixed(1));
    }

    if (entry.datalabMatches && entry.datalabMatches.size) {
      const matches = Array.from(entry.datalabMatches.values()).map(match => ({
        term_ko: match.term_ko,
        score: Number.isFinite(match.score) ? Number(match.score.toFixed(3)) : Number(match.score || 0),
        hits: match.hits,
        categories: match.categories ? Array.from(match.categories) : []
      }));
      if (matches.length) {
        keywordRecord.datalab_matches = matches;
        matches.forEach(match => datalabMatchedTerms.add(match.term_ko));
      }
    }

    if (Array.isArray(entry.headlines) && entry.headlines.length) {
      keywordRecord.headlines = entry.headlines;
    }

    if (entry.contextTargets && entry.contextTargets.size) {
      keywordRecord.context = {
        targets: Array.from(entry.contextTargets),
        includesTarget: Boolean(entry.contextIncludesTarget),
        positions: Array.isArray(entry.contextPositions)
          ? entry.contextPositions
          : entry.contextPositions instanceof Set
            ? Array.from(entry.contextPositions)
            : [],
        windows: Array.isArray(entry.contextWindows)
          ? entry.contextWindows
          : entry.contextWindows instanceof Set
            ? Array.from(entry.contextWindows)
            : []
      };
    }

    discoveredKeywords.push(keywordRecord);
  }

  // Final keyword scoring loop
  for (const kw of discoveredKeywords) {
    const freq = kw.mentions || 1;
    const sig = kw.significance_score || 0;
    // ✅ Improved weighting and normalization
    const logFreq = Math.log10(freq + 1);
    const normSig = Math.sqrt(sig);
    kw.combined_score = 0.6 * normSig + 0.4 * logFreq;

    // ✅ Penalize plain or generic "주식"/"주식시장" terms
    const termKo = kw.term_ko || '';
    if (/^주식\s*$/.test(termKo) || /^주식\s?시장/.test(termKo)) {
      kw.combined_score *= 0.5;
    }

    // ✅ Downweight verb-heavy phrases ("한다", "되다", etc.)
    if (/[다]$/.test(termKo)) {
      kw.significance_score *= 0.7;
    }

    // ✅ Trend boost for key finance or sectoral terms
    const TREND_TERMS = [
      'AI',
      '반도체',
      '배터리',
      '전기차',
      '금리',
      '인플레이션',
      '에너지',
      '환율',
      'ETF',
      '원유',
      '수출',
      '산업',
      '기술'
    ];
    const termEn = kw.term || '';
    if (TREND_TERMS.some(t => termEn.includes(t) || termKo.includes(t))) {
      kw.significance_score *= 1.25;
    }
  }

  // ✅ Semantic deduplication (reduce repetitive "주식시장" variants)
  const uniqueKeywords = [];
  const seenKeys = new Set();
  for (const kw of discoveredKeywords) {
    const baseKey = (kw.term_ko || kw.term || '')
      .replace(/\s+/g, '')
      .replace(/주식시장?|시장|투자|한다|반영/g, '');
    if (![...seenKeys].some(k => baseKey.includes(k) || k.includes(baseKey))) {
      seenKeys.add(baseKey);
      uniqueKeywords.push(kw);
    }
  }
  discoveredKeywords = uniqueKeywords;

  // ✅ Style improvement (cleaner Korean phrasing)
  function stylizeKeyword(termKo = '') {
    return termKo
      .replace(/주식\s?시장/g, '증시')
      .replace(/투자한다|투자하다/g, '투자')
      .replace(/이런\s?분위기는|분위기는/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  discoveredKeywords = discoveredKeywords.map(k => ({
    ...k,
    term_ko: stylizeKeyword(k.term_ko)
  }));

  // ✅ Load finance dictionary (assuming ./data/finance_keywords.json)
  let financeSet = new Set();
  try {
    const financeDict = loadFinanceKeywordList();
    financeSet = new Set(financeDict.map(k => k.toLowerCase()));
  } catch (err) {
    console.warn('[Significance] failed to initialize finance keyword set:', err?.message || err);
  }

  const financeKeywordsLower = Array.from(financeSet);

  // ✅ Enhanced scoring using finance dictionary relevance
  for (const kw of discoveredKeywords) {
    const term = String(kw.term || '').toLowerCase();
    const termKo = String(kw.term_ko || '').toLowerCase();

    // 1️⃣ Finance keyword match boost
    const matched = financeKeywordsLower.filter(k => term.includes(k) || termKo.includes(k));
    if (matched.length > 0) {
      const sigScore = Number.isFinite(kw.significance_score) ? kw.significance_score : 0;
      const combinedScore = Number.isFinite(kw.combined_score) ? kw.combined_score : 0;
      const multiplierBase = 1.3 + 0.05 * matched.length;
      const combinedMultiplier = 1.2 + 0.05 * matched.length;
      kw.significance_score = sigScore * multiplierBase;
      kw.combined_score = combinedScore * combinedMultiplier;
    }

    // 2️⃣ Contextual boost for core financial actions
    if (/(매수|매도|투자|상승|하락|강세|약세)/.test(kw.term_ko || '')) {
      const combinedScore = Number.isFinite(kw.combined_score) ? kw.combined_score : 0;
      kw.combined_score = combinedScore * 1.2;
    }

    // 3️⃣ Penalty for overly generic terms
    const trimmedKo = String(kw.term_ko || '').trim();
    if (/^(주식|증시|시장)$/.test(trimmedKo)) {
      const combinedScore = Number.isFinite(kw.combined_score) ? kw.combined_score : 0;
      kw.combined_score = combinedScore * 0.4;
    }

    // 4️⃣ Bonus for key sector or macro terms
    const themes = ["반도체","배터리","AI","금리","환율","인플레이션","에너지","수출","원유"];
    if (themes.some(t => (kw.term_ko || '').includes(t))) {
      const combinedScore = Number.isFinite(kw.combined_score) ? kw.combined_score : 0;
      kw.combined_score = combinedScore * 1.3;
    }
  }

  // ✅ Deduplicate by root form (Korean & English)
  const seen = new Set();
  const unique = [];
  for (const kw of discoveredKeywords) {
    const base = kw.term_ko || kw.term || '';
    const key = base.replace(/\s+/g, '').replace(/[^\p{L}\p{N}]/gu, '');
    if (!key) continue;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(kw);
    }
  }
  discoveredKeywords = unique;

  // ✅ Re-rank & cap output
  discoveredKeywords.sort((a, b) => {
    const aScore = Number.isFinite(a.combined_score) ? a.combined_score : 0;
    const bScore = Number.isFinite(b.combined_score) ? b.combined_score : 0;
    if (bScore !== aScore) return bScore - aScore;
    const aSig = Number.isFinite(a.significance_score) ? a.significance_score : 0;
    const bSig = Number.isFinite(b.significance_score) ? b.significance_score : 0;
    if (bSig !== aSig) return bSig - aSig;
    return String(a.term_ko || '').localeCompare(String(b.term_ko || ''));
  });
  discoveredKeywords = discoveredKeywords.slice(0, 30);

  // ✅ Summary log
  console.log(`🔍 Final keyword set (${discoveredKeywords.length}):`);
  try {
    console.table(
      discoveredKeywords.slice(0, 10).map((k, i) => ({
        rank: i + 1,
        ko: k.term_ko,
        en: k.term,
        score: Number.isFinite(k.combined_score) ? k.combined_score.toFixed(2) : '0.00',
        sig: Number.isFinite(k.significance_score) ? k.significance_score.toFixed(1) : '0.0'
      }))
    );
  } catch (err) {
    console.warn('⚠️ Keyword summary log failed:', err?.message || err);
  }

  const nowIso = new Date().toISOString();
  const payload = {
    date: nowIso.slice(0, 10),
    window: `${SIGNIFICANT_LOOKUP_WINDOW_HOURS}_hours`,
    total_phrases: discoveredKeywords.length,
    discovered_keywords: discoveredKeywords,
    metadata: {
      collection_method: 'significance_over_frequency',
      phrase_length: '2-4 words',
      scoring: 'frequency_weighted_significance',
      generated_at: nowIso,
      finance_trend_keywords: injectedTrends,
      keyword_limit: desiredCount,
      lookback_hours: SIGNIFICANT_LOOKUP_WINDOW_HOURS
    }
  };

  if (collectionMeta?.articleCache) {
    const cacheMeta = collectionMeta.articleCache;
    payload.metadata.article_cache_files = cacheMeta.filesProcessed || 0;
    payload.metadata.article_cache_articles = cacheMeta.processedArticles || 0;
    payload.metadata.article_cache_phrases = cacheMeta.extractedPhrases || 0;
    if (cacheMeta.skippedForRecency) {
      payload.metadata.article_cache_skipped_recency = cacheMeta.skippedForRecency;
    }
  }

  if (Array.isArray(collectionMeta?.datalabTermsUsed) && collectionMeta.datalabTermsUsed.length) {
    payload.metadata.datalab_terms_used = collectionMeta.datalabTermsUsed;
  }

  if (datalabMatchedTerms.size) {
    payload.metadata.matched_datalab_terms = Array.from(datalabMatchedTerms).sort();
  }

  ensureDirFor(outputPath);
  await fsp.writeFile(outputPath, JSON.stringify(payload, null, 2));

  console.log(`[Significance] wrote ${discoveredKeywords.length} significant phrases (finance trends added: ${injectedTrends})`);
  return payload;
}
function buildDiscoveredKeywordsFromStats(tagStats, { limit = 50 } = {}) {
  if (!tagStats || typeof tagStats.size !== 'number' || tagStats.size === 0) return [];
  const entries = [];
  const nowMs = Date.now();
  const lookbackHours = TAG_RECENCY_LOOKBACK_HOURS > 0 ? TAG_RECENCY_LOOKBACK_HOURS : 24;
  for (const entry of tagStats.values()) {
    const term = chooseTagDisplay(entry);
    if (!term) continue;
    const count = Number(entry?.count || 0);
    const weight = computeBusinessTagWeight(entry, term);
    let weightedCount = count * (Number.isFinite(weight) && weight > 0 ? weight : 1);
    const recencySamples = Number(entry?.recencySamples || 0);
    const recencySum = Number(entry?.recencySum || 0);
    const recentHits = Number(entry?.recentHits || 0);
    const latestPublishedAt = Number(entry?.latestPublishedAt || 0);
    if (recencySamples > 0 || recentHits > 0 || latestPublishedAt > 0) {
      const avgRecency = recencySamples > 0 ? recencySum / recencySamples : 0;
      let latestBoost = 0;
      if (latestPublishedAt > 0 && lookbackHours > 0) {
        const ageHours = Math.max(0, (nowMs - latestPublishedAt) / 3600000);
        latestBoost = to01(1 - (ageHours / lookbackHours));
      }
      const recentHitBoost = recentHits > 0 ? Math.min(recentHits, 5) * 0.05 : 0;
      const recencyContribution = Math.max(0, Math.min(0.8, avgRecency * 0.6 + latestBoost * 0.5 + recentHitBoost));
      weightedCount *= 1 + recencyContribution;
    }
    entries.push({ term, count, weightedCount });
  }
  entries.sort((a, b) => {
    if ((b.weightedCount || 0) !== (a.weightedCount || 0)) return (b.weightedCount || 0) - (a.weightedCount || 0);
    if (b.count !== a.count) return b.count - a.count;
    return a.term.localeCompare(b.term);
  });
  const top = entries.slice(0, limit);
  const maxWeighted = top.length ? Math.max(...top.map(item => item.weightedCount || 0)) : 0;
  return top.map(item => ({
    term: formatTagDisplay(item.term),
    count: item.count,
    score: maxWeighted > 0 ? Number(((item.weightedCount || 0) / maxWeighted).toFixed(2)) : 0
  })).filter(entry => entry.term);
}

function normalizeDiscoveredKeywordList(entries = []) {
  const sanitized = [];
  const seen = new Set();
  for (const entry of entries) {
    const rawTerm = entry?.term || entry?.text?.en || entry?.text || '';
    const term = formatTagDisplay(rawTerm);
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const count = Number(entry?.count || 0);
    const rawScore = Number.isFinite(entry?.score) ? Number(entry.score) : null;
    const termKo = String(entry?.term_ko || entry?.text?.ko || '').trim();
    sanitized.push({ term, termKo, count, rawScore });
  }
  if (!sanitized.length) return [];
  let maxCount = 0;
  for (const item of sanitized) {
    if (item.count > maxCount) maxCount = item.count;
  }
  return sanitized.map(item => {
    const baseScore = item.rawScore != null ? to01(item.rawScore) : (maxCount > 0 ? to01(item.count / maxCount) : 0);
    const normalized = {
      term: item.term,
      count: item.count,
      score: Number(baseScore.toFixed(2))
    };
    if (item.termKo) {
      normalized.term_ko = item.termKo;
    }
    return normalized;
  });
}

function primeTranslationCacheFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  if (snapshot?.translations && typeof snapshot.translations === 'object') {
    for (const [key, value] of Object.entries(snapshot.translations)) {
      if (!value) continue;
      const enText = String(value?.en || key || '').trim();
      const koText = String(value?.ko || value || '').trim();
      if (enText && koText) {
        setTranslationCache(enText, koText);
      }
    }
  }
  if (Array.isArray(snapshot?.discovered_keywords)) {
    for (const item of snapshot.discovered_keywords) {
      const enText = String(item?.text?.en || item?.term || item?.text || '').trim();
      const koText = String(item?.term_ko || item?.text?.ko || '').trim();
      if (enText && koText) {
        setTranslationCache(enText, koText);
      }
    }
  }
}

function addKoMapping(map, enText, koText) {
  const en = formatTagDisplay(enText);
  const ko = String(koText || '').trim();
  if (!en || !ko) return;
  const key = en.toLowerCase();
  if (!map.has(key)) {
    map.set(key, ko);
  }
  setTranslationCache(en, ko);
}

function buildTermKoLookup(snapshot) {
  const map = new Map();
  if (!snapshot || typeof snapshot !== 'object') return map;

  if (Array.isArray(snapshot.discovered_keywords)) {
    for (const item of snapshot.discovered_keywords) {
      const en = item?.term || item?.text?.en || '';
      const ko = item?.term_ko || item?.text?.ko || '';
      addKoMapping(map, en, ko);
    }
  }

  if (Array.isArray(snapshot.keywords)) {
    for (const item of snapshot.keywords) {
      const en = item?.term || item?.text?.en || '';
      const ko = item?.term_ko || item?.text?.ko || '';
      addKoMapping(map, en, ko);
    }
  }

  if (snapshot.translations && typeof snapshot.translations === 'object') {
    for (const [en, value] of Object.entries(snapshot.translations)) {
      if (!value) continue;
      if (typeof value === 'string') {
        addKoMapping(map, en, value);
      } else {
        addKoMapping(map, en, value.ko || value.en || '');
      }
    }
  }

  return map;
}

function lookupKoFromMap(map, term) {
  if (!map) return '';
  const formatted = formatTagDisplay(term);
  if (!formatted) return '';
  return map.get(formatted.toLowerCase()) || '';
}

function extractTagTermsFromSnapshot(snapshot) {
  if (!snapshot) return [];
  if (Array.isArray(snapshot?.tags)) {
    return snapshot.tags.map(formatTagDisplay).filter(Boolean);
  }
  if (Array.isArray(snapshot?.discovered_keywords)) {
    return snapshot.discovered_keywords
      .map(item => formatTagDisplay(item?.term || item?.text?.en || item?.text || ''))
      .filter(Boolean);
  }
  return [];
}

async function writeTagsJsonFile(tags, stats = new Map(), {
  fallbackSnapshot = null,
  fallbackUsed = false,
  articleTexts = [],
  articleCount = 0,
  asOfDate = daysAgo(0)
} = {}) {
  primeTranslationCacheFromSnapshot(fallbackSnapshot);

  const normalizedTags = Array.isArray(tags) ? tags.map(formatTagDisplay).filter(Boolean) : [];
  let discovered = buildDiscoveredKeywordsFromStats(stats, { limit: Math.max(normalizedTags.length, 50) });
  let derivedArticleCount = Number(articleCount) || 0;

  if (!derivedArticleCount && Array.isArray(articleTexts)) {
    derivedArticleCount = articleTexts.length;
  }

  if (!discovered.length && Array.isArray(fallbackSnapshot?.discovered_keywords)) {
    discovered = normalizeDiscoveredKeywordList(fallbackSnapshot.discovered_keywords);
  }

  if (!discovered.length && Array.isArray(fallbackSnapshot?.ranked)) {
    const fallbackStats = rebuildTagStatsFromSnapshot(fallbackSnapshot);
    discovered = buildDiscoveredKeywordsFromStats(fallbackStats, { limit: Math.max(normalizedTags.length, 50) });
  }

  if (!discovered.length) {
    console.warn('[keywords] skipping tags.json update because no keywords are available');
    return null;
  }

  const translations = {};
  const aggregated = new Map();

  const toKeywordKey = (enText, koText) => {
    const koKey = String(koText || '').trim().toLowerCase();
    if (koKey) return koKey;
    return String(enText || '').trim().toLowerCase();
  };

  const addAggregatedKeyword = (enRaw, koRaw, { translator } = {}) => {
    const koText = normalizeKoKeywordTerm(koRaw);
    if (!koText) return;
    const enText = formatTagDisplay(enRaw || '');
    const key = toKeywordKey(enText, koText);
    if (!key) return;
    const translatorLabel = String(translator || '').trim();
    if (aggregated.has(key)) {
      const existing = aggregated.get(key);
      if (!existing.term && enText) existing.term = enText;
      if (!existing.term_en && enText) existing.term_en = enText;
      if (!existing.term_ko && koText) existing.term_ko = koText;
      if (translatorLabel) existing.translators.add(translatorLabel);
    } else {
      const translators = new Set();
      if (translatorLabel) translators.add(translatorLabel);
      aggregated.set(key, {
        term: enText || '',
        term_en: enText || '',
        term_ko: koText,
        translators
      });
    }

    if (enText && koText) {
      translations[enText] = { en: enText, ko: koText };
      if (translatorLabel) {
        translations[enText].translator = translatorLabel;
      }
      setTranslationCache(enText, koText);
    }
  };

  const addKoreanCandidate = async (koSource, enHint, { translator } = {}) => {
    const koTerm = normalizeKoKeywordTerm(koSource);
    if (!koTerm) return;
    let enTerm = formatTagDisplay(enHint || '');
    let translatorLabel = String(translator || '').trim();
    if (!enTerm || enTerm.toLowerCase() === koTerm.toLowerCase()) {
      const translation = await translateKoTermToEn(koTerm, { includeMeta: true });
      if (translation.text) {
        enTerm = formatTagDisplay(translation.text);
        if (translation.translator) {
          translatorLabel = translation.translator;
        }
      }
    }
    addAggregatedKeyword(enTerm, koTerm, { translator: translatorLabel });
  };

  const addEnglishCandidate = async (enSource, koHint) => {
    const baseTerm = formatTagDisplay(enSource || '');
    if (!baseTerm) return;
    const storedKo = normalizeKoKeywordTerm(koHint);
    if (storedKo) {
      setTranslationCache(baseTerm, storedKo);
      addAggregatedKeyword(baseTerm, storedKo, { translator: 'cache' });
      return;
    }

    const localized = await getLocalizedKeywordTexts(baseTerm);
    const koText = localized.ko && hasHangulText(localized.ko) ? localized.ko : '';
    if (!koText) {
      return;
    }

    const translator = localized.meta?.translator;
    const enText = localized.en || baseTerm;
    addAggregatedKeyword(enText, koText, { translator });
  };

  const datalabEntries = await buildDatalabKeywordEntries();
  for (const entry of datalabEntries) {
    const koTerm = entry?.text?.ko || entry?.text?.en || '';
    const enTerm = entry?.text?.en || '';
    await addKoreanCandidate(koTerm, enTerm, { translator: 'naver-datalab' });
  }

  const financeTrendBoost = await fetchFinanceTrendKeywords({ limit: Math.max(16, normalizedTags.length) });
  for (const trend of financeTrendBoost) {
    await addKoreanCandidate(trend?.term_ko || '', '', { translator: 'naver-datalab' });
  }

  const koKeywordBoost = await collectEconomyKoKeywords({ limit: Math.max(30, normalizedTags.length) });
  for (const entry of koKeywordBoost) {
    const koTerm = entry?.term_ko || entry?.term || '';
    const enTerm = entry?.term && entry.term !== koTerm ? entry.term : '';
    const translatorLabel = String(entry?.source || '').trim() || 'krwordrank';
    await addKoreanCandidate(koTerm, enTerm, { translator: translatorLabel });
  }

  for (const item of discovered) {
    const baseTerm = formatTagDisplay(item?.term || '');
    if (!baseTerm) continue;
    const storedKo = String(item?.term_ko || item?.text?.ko || '').trim();
    if (storedKo) {
      await addEnglishCandidate(baseTerm, storedKo);
    } else {
      await addEnglishCandidate(baseTerm, '');
    }
  }

  if (!aggregated.size) {
    console.warn('[keywords] skipping tags.json update because no Korean keywords were produced');
    return null;
  }

  const localizedDiscovered = [];
  for (const entry of aggregated.values()) {
    const koTerm = entry.term_ko || '';
    let english = formatTagDisplay(entry.term_en || entry.term || '');
    let translatorLabel = '';
    if (entry.translators && entry.translators.size) {
      const translatorCandidates = [...entry.translators];
      if (translatorCandidates.length) {
        translatorLabel = String(translatorCandidates[0] || '').trim();
      }
    }

    if ((!english || english.toLowerCase() === koTerm.toLowerCase()) && koTerm) {
      const translation = await translateKoTermToEn(koTerm, { includeMeta: true });
      if (translation.text) {
        english = formatTagDisplay(translation.text);
        if (translation.translator) {
          translatorLabel = translation.translator;
        }
      }
    }

    const finalEn = english || formatTagDisplay(entry.term || '');
    const keywordRecord = {
      term: finalEn || '',
      term_ko: koTerm,
      term_en: finalEn || ''
    };

    localizedDiscovered.push(keywordRecord);

    if (finalEn && koTerm) {
      const translatorValue = translatorLabel || (DEEPL_API_KEY ? 'deepl' : '');
      const translationEntry = { en: finalEn, ko: koTerm };
      if (translatorValue) {
        translationEntry.translator = translatorValue;
      }
      translations[finalEn] = translationEntry;
      setTranslationCache(finalEn, koTerm);
    }
  }

  const generatedAt = new Date();
  const generatedAtIso = generatedAt.toISOString();
  const normalizedDate = typeof asOfDate === 'string' && asOfDate
    ? asOfDate.slice(0, 10)
    : daysAgo(0);

  let generatedAtLocal = '';
  try {
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: TAG_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(generatedAt);
    const lookup = (type) => parts.find(p => p.type === type)?.value || '';
    const localDate = `${lookup('year')}-${lookup('month')}-${lookup('day')}`;
    const localTime = `${lookup('hour')}:${lookup('minute')}:${lookup('second')}`;
    if (localDate.trim() && localTime.trim()) {
      generatedAtLocal = `${localDate}T${localTime}`;
    }
  } catch {
    generatedAtLocal = '';
  }

  const metadata = {
    ...(existingSnapshot?.metadata && typeof existingSnapshot.metadata === 'object' ? existingSnapshot.metadata : {}),
    date: normalizedDate,
    window: `${TAG_COLLECTION_WINDOW_DAYS}_days`,
    generated_at: generatedAtIso,
    timezone: TAG_TIMEZONE,
    article_count: derivedArticleCount,
    fallback_used: Boolean(fallbackUsed)
  };
  if (generatedAtLocal) {
    metadata.generated_at_local = generatedAtLocal;
  }

  const payload = {
    ...(existingSnapshot || {}),
    date: normalizedDate,
    window: metadata.window,
    total_phrases: discoveredKeywords.length,
    total_articles: derivedArticleCount,
    discovered_keywords: localizedDiscovered,
    translations,
    generated_at: generatedAtIso,
    timezone: TAG_TIMEZONE,
    metadata
  };

  ensureDirFor(outputPath);
  await fsp.writeFile(outputPath, JSON.stringify(payload, null, 2));

  const suffix = fallbackUsed ? ' (fallback)' : '';
  console.log(`[keywords] wrote ${outputPath} with ${localizedDiscovered.length} keywords${suffix}`);
  return payload;
}

function buildSearchUrlPair(enText, koText) {
  const urls = {};
  const koUrl = buildGoogleSearchUrl(koText, 'ko');
  const enUrl = buildGoogleSearchUrl(enText, 'en');
  if (koUrl) urls.ko = koUrl;
  if (enUrl) urls.en = enUrl;
  return urls;
}

async function buildKeywordsFromTagStats(tagStats, { limit = 10, koLookup = null } = {}) {
  if (!tagStats || !tagStats.size) return [];
  const entries = [];
  for (const entry of tagStats.values()) {
    entries.push({
      display: chooseTagDisplay(entry),
      count: entry.count || 0
    });
  }
  entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.display.localeCompare(b.display);
  });

  const results = [];
  const localKoLookup = koLookup || null;
  for (const item of entries) {
    if (results.length >= limit) break;
    const enText = formatTagDisplay(item.display);
    if (!enText) continue;
    const storedKo = lookupKoFromMap(localKoLookup, enText);
    if (storedKo && hasHangulText(storedKo)) {
      setTranslationCache(enText, storedKo);
      results.push({ term: enText, term_ko: storedKo });
      continue;
    }

    const localized = await getLocalizedKeywordTexts(enText);
    const koText = localized.ko && hasHangulText(localized.ko) ? localized.ko : '';
    if (!koText) {
      continue;
    }
    results.push({ term: localized.en || enText, term_ko: koText });
  }

  return results;
}

function mergeKeywordLists(primary = [], secondary = [], limit = 10) {
  const out = [];
  const seen = new Set();
  const add = (item) => {
    if (!item || typeof item !== 'object') return;
    const key = String(item?.term_ko || item?.term || '').trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ term: item.term || '', term_ko: item.term_ko || '' });
  };
  primary.forEach(add);
  secondary.forEach(add);
  return out.slice(0, limit);
}

async function buildNewsKeywordsFromTagSnapshot(snapshot, tagStats, { limit = 10, koLookup = null } = {}) {
  if (!snapshot) return [];
  const discovered = Array.isArray(snapshot?.discovered_keywords) ? snapshot.discovered_keywords : [];
  if (!discovered.length) return [];

  const fallbackStats = rebuildTagStatsFromSnapshot(snapshot);
  const statsMap = (tagStats && typeof tagStats.size === 'number' && tagStats.size > 0)
    ? tagStats
    : fallbackStats;

  const out = [];
  const seen = new Set();
  const localKoLookup = koLookup || buildTermKoLookup(snapshot);
  for (const item of discovered) {
    if (out.length >= limit) break;
    const koTerm = String(item?.term_ko || item?.text?.ko || '').trim();
    const enSource = item?.term || item?.text?.en || item?.text || '';
    let enText = formatTagDisplay(enSource);
    const keySource = koTerm || enText;
    if (!keySource) continue;
    const key = keySource.toLowerCase();
    if (seen.has(key)) continue;

    let finalKo = koTerm;
    if (!finalKo && enText) {
      const lookupKo = lookupKoFromMap(localKoLookup, enText);
      if (lookupKo) {
        finalKo = lookupKo;
      }
    }

    if (!finalKo || !hasHangulText(finalKo)) {
      if (enText) {
        const localized = await getLocalizedKeywordTexts(enText);
        if (localized.ko && hasHangulText(localized.ko)) {
          finalKo = localized.ko;
          enText = localized.en || enText;
        }
      }
    }

    if (!finalKo || !hasHangulText(finalKo)) {
      if (koTerm && hasHangulText(koTerm)) {
        finalKo = koTerm;
      } else {
        continue;
      }
    }

    if (!enText && finalKo) {
      const translated = await translateKoTermToEn(finalKo);
      enText = formatTagDisplay(translated || '');
    }

    seen.add(key);

    if (enText && finalKo) {
      setTranslationCache(enText, finalKo);
    }

    out.push({ term: enText || '', term_ko: finalKo });
  }

  return out;
}

export async function buildMarketKeywordSnapshot({ outputPath = KEYWORD_OUTPUT_FILE, preCollected = null } = {}){
  const existingSnapshot = readJsonSafe(outputPath) || {};
  const existingTagSnapshot = readJsonSafe(outputPath) || null;

  const normalizeCollection = (input) => {
    if (!input || typeof input !== 'object') {
      return { keywords: [], totalRaw: 0, uniqueTerms: 0 };
    }

    const keywords = Array.isArray(input.keywords)
      ? input.keywords.map((kw) => {
          if (!kw || typeof kw !== 'object') return {};
          const sources = Array.isArray(kw.sources)
            ? kw.sources.filter(Boolean)
            : (kw.sources ? [kw.sources].filter(Boolean) : []);
          return { ...kw, sources };
        })
      : [];

    const totalRawValue = Number(input.totalRaw);
    const uniqueTermsValue = Number(input.uniqueTerms);

    return {
      keywords,
      totalRaw: Number.isFinite(totalRawValue) ? totalRawValue : keywords.length,
      uniqueTerms: Number.isFinite(uniqueTermsValue) ? uniqueTermsValue : keywords.length
    };
  };

  const providedCollection = preCollected && typeof preCollected === 'object'
    ? normalizeCollection(preCollected)
    : null;

  let collectionResult = providedCollection || { keywords: [], totalRaw: 0, uniqueTerms: 0 };

  if (!providedCollection) {
    try {
      collectionResult = normalizeCollection(await collectKoreanFirstKeywords({ targetCount: 30 }));
    } catch (err) {
      console.warn('[Korean-First] collection failed:', err.message);
    }
  }

  let tagSnapshot = existingTagSnapshot;
  try {
    const snapshot = await writeKoreanFirstTagsJson({ outputPath, preCollected: collectionResult });
    if (snapshot) {
      tagSnapshot = snapshot;
    }
  } catch (err) {
    console.warn('[Korean-First] failed to write tags snapshot:', err.message);
  }

  const dedupeKeywords = (list = []) => {
    const out = [];
    const seen = new Set();
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const termKo = normalizeKoKeywordTerm(entry.term_ko || entry.term || '');
      if (!termKo) continue;
      const term = formatTagDisplay(entry.term || '');
      const key = termKo.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ term, term_ko: termKo });
      if (out.length >= 10) break;
    }
    return out;
  };

  let keywords = dedupeKeywords(collectionResult.keywords);

  if (!keywords.length && Array.isArray(tagSnapshot?.discovered_keywords)) {
    keywords = dedupeKeywords(tagSnapshot.discovered_keywords);
  }

  if (!keywords.length && Array.isArray(existingSnapshot?.keywords)) {
    console.warn('[keywords] falling back to previous keyword snapshot');
    keywords = dedupeKeywords(existingSnapshot.keywords);
  }

  for (const entry of keywords) {
    if (entry.term && entry.term_ko) {
      setTranslationCache(entry.term, entry.term_ko);
    }
  }

  const now = new Date();
  const tz = process.env.KEYWORD_TIMEZONE || 'Asia/Seoul';
  const updatedKo = now.toLocaleString('ko-KR', { timeZone: tz, hour12: false });
  const updatedEn = now.toLocaleString('en-US', { timeZone: tz });

  let markets = Array.isArray(existingSnapshot?.markets) ? existingSnapshot.markets : [];
  if (!markets.length) {
    markets = KEYWORD_MARKET_QUERIES.map(m => m.market);
  }

  const mergedSnapshot = {
    ...(tagSnapshot || existingSnapshot || {}),
    generatedAt: now.toISOString(),
    timezone: tz,
    updatedAt: {
      ko: updatedKo,
      en: updatedEn
    },
    keywords,
    markets
  };

  if (existingSnapshot?.tickerKeywords && !mergedSnapshot.tickerKeywords) {
    mergedSnapshot.tickerKeywords = existingSnapshot.tickerKeywords;
  }
  if (existingSnapshot?.tickerKeywordsMeta && !mergedSnapshot.tickerKeywordsMeta) {
    mergedSnapshot.tickerKeywordsMeta = existingSnapshot.tickerKeywordsMeta;
  }

  ensureDirFor(outputPath);
  await fsp.writeFile(outputPath, JSON.stringify(mergedSnapshot, null, 2));
  console.log(`[keywords] wrote ${outputPath} with ${keywords.length} entries`);
  return mergedSnapshot;
}

export {
  KEYWORD_MARKET_QUERIES,
  TAG_OUTPUT_FILE,
  KEYWORD_OUTPUT_FILE,
  TAG_TIMEZONE,
  formatTagDisplay,
  translateTagToKo,
  setTranslationCache,
  hasHangulText,
  normalizeKoKeywordTerm,
  buildTermKoLookup,
  lookupKoFromMap,
  primeTranslationCacheFromSnapshot,
  readJsonSafe,
  ensureDirFor,
  daysAgo,
  iso,
  naverSearch,
  loadTagCreditState,
  getTagCreditValue,
  applyTagCreditFromSnapshot,
};

const isMainModule = (process.argv[1] && path.resolve(process.argv[1])) === __filename;

if (isMainModule) {
  (async () => {
    const args = new Set(process.argv.slice(2));
    const outputPath = process.env.MARKET_TAG_FILE || TAG_OUTPUT_FILE;

    const logSummary = (summary) => {
      if (!summary) return;
      if (summary.ok) {
        console.log(`[verify] tags.json verification succeeded (${summary.total} keywords)`);
      } else {
        console.warn(`[verify] tags.json verification issues: ${summary.errors.join(', ')}`);
      }
      if (summary.sample?.length) {
        console.log('[verify] sample keywords:', summary.sample.map(k => `${k.term_ko} (${k.term})`).join(', '));
      }
    };

    if (args.has('--build-tags')) {
      let snapshot = await writeSignificantPhrasesJson({ outputPath });
      if (!snapshot) {
        console.warn('[tags] significance builder returned empty result; falling back to korean-first');
        snapshot = await writeKoreanFirstTagsJson({ outputPath });
      }
      if (!snapshot) {
        console.error('[tags] failed to build snapshot');
        process.exit(1);
      }

      const summary = verifyTagSnapshot(snapshot);
      logSummary(summary);
      if (!summary.ok) {
        console.error('[tags] verification failed');
        process.exit(2);
      }

      try {
        await runExtractKeywords({ tagsPath: outputPath });
      } catch (err) {
        console.warn('[tags] refined keyword extraction failed:', err?.message || err);
      }

      if (!args.has('--no-credit')) {
        await applyTagCreditFromSnapshot(snapshot);
      } else {
        console.log('[learning] credit update skipped (--no-credit)');
      }

      console.log('[tags] build complete');
      return;
    }

    if (args.has('--verify-tags')) {
      const snapshot = readJsonSafe(outputPath);
      const summary = verifyTagSnapshot(snapshot);
      logSummary(summary);
      if (!summary.ok) process.exit(3);
      return;
    }

    console.log('Usage:');
    console.log('  node stocks/stockKeywords.js --build-tags [--no-credit]');
    console.log('  node stocks/stockKeywords.js --verify-tags');
  })().catch(err => {
    console.error('[tags] unexpected failure:', err);
    process.exit(1);
  });
}

