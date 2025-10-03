import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { restClient } from '@polygon.io/client-js';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { parse } from 'node-html-parser';
import { fetchKotraRecent } from "./kotraOverseas.js";
import { getCompanyNameByYahooSymbol } from "../data/krxDirectory.js";
import { tokenBucket, circuitBreaker } from "./helpers/rate.js";
import { computeReputation } from './reputation.js';
// for CLI-only cache builders
import { fetchNaverTrends, buildBasketsFromUniverse } from '../trends/naverDatalab.js';
import { buildKeywordDict } from '../trends/keywordBuilder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_DIR = 'cache';
const NEWS_TTL_MS = Number(process.env.NEWS_TTL_MS || 30 * 60 * 1000); // 30m
const NEWS_CONCURRENCY = Number(process.env.NEWS_CONCURRENCY || 2);
const ALLOW_STALE_NEWS = process.env.ALLOW_STALE_NEWS !== '0';
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || 8000);
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 3000);
const defaultHeaders = {
  'User-Agent': 'stock-recs/1.1 (+ci)',
  'Accept': 'application/json,text/*;q=0.9,*/*;q=0.8',
  'Accept-Encoding': 'gzip,deflate',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
};
const defaultUA = { 'User-Agent': 'stock-recs/1.0 (+github-actions)' };
const SKIP_NAVER = process.env.SKIP_NAVER === '1';
// Persist targets
const NEWS_FEATURES_FILE = path.join('data', 'news-features.json');
const NAVER_TRENDS_FILE  = path.join('data', 'naver-trends.json');
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || '';
const polygonRest = POLYGON_API_KEY ? restClient(POLYGON_API_KEY) : null;
const DEEPS_API_KEY = process.env.DEEPS_API_KEY || '';
const DEEPS_US_EXCHANGE = process.env.DEEPS_US_EXCHANGE || 'NASDAQ';
const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY || '';
const DEEPL_API_KEY = (process.env.DEEPL_API_KEY || '').trim();
const NAVER_CLIENT_ID = (process.env.NAVER_CLIENT_ID || '').trim();
const NAVER_CLIENT_SECRET = (process.env.NAVER_CLIENT_SECRET || '').trim();
const PYTHON_BIN = (process.env.PYTHON_BIN || process.env.PYTHON || 'python3').trim();
const KRWORDRANK_TIMEOUT_MS = Number(process.env.KRWORDRANK_TIMEOUT_MS || 20000);
const KRWORDRANK_SCRIPT = path.join(__dirname, '..', '..', 'tools', 'krwordrank_fetcher.py');

const NAVER_WEIGHT = Number(process.env.NAVER_WEIGHT || 1.6);
const OTHER_NEWS_WEIGHT = Number(process.env.OTHER_NEWS_WEIGHT || 1.0);
const NAVER_BLOG_WEIGHT = Number(process.env.NAVER_BLOG_WEIGHT || 0.5);
const NAVER_REP_BONUS = Number(process.env.NAVER_REP_BONUS || 1.1);
const NAVER_KO_WEIGHT = Number(process.env.NAVER_KO_WEIGHT || 1.3);
const NAVER_EN_WEIGHT = Number(process.env.NAVER_EN_WEIGHT || 1.0);

const HANGUL_REGEX = /[\u3131-\u318E\uAC00-\uD7A3]/;

const POS_KR = /(호조|개선|확대|수주|계약|제휴|승인|허가|인증|증설|증대|흑자전환|사상 최대|서프라이즈|상향)/i;
const NEG_KR = /(부진|감소|하락|급락|적자|적자전환|소송|제재|벌금|과징금|리콜|해킹|유출|파업|중단|연기|취소|하향|정지)/i;

const SOURCE_WEIGHT = {
  'www.hankyung.com': 1.0, 'www.edaily.co.kr': 1.0, 'biz.chosun.com': 1.0,
  'www.mk.co.kr': 1.0, 'www.sedaily.com': 1.0, 'www.fnnews.com': 1.0,
  // fallbacks default to 0.6; PR/blogs → 0.4
};

function hostWeight(u){
  try {
    const h = new URL(u).host;
    if (/press|prnews|newswire|bo.do|공지|보도자료/i.test(u)) return 0.4;
    return SOURCE_WEIGHT[h] ?? 0.6;
  } catch { return 0.6; }
}
function normalizeTitle(t){
  return String(t||'')
    .replace(/[\[\(【〔].*?[\]\)】〕]/g,'')   // drop [단독][속보]… 괄호 태그
    .replace(/[\s\u00A0]+/g,' ')
    .trim()
    .toLowerCase();
}

function classifyPolarity(str){
  const s = String(str||'');
  const pos = POS_KR.test(s), neg = NEG_KR.test(s);
  if (pos && !neg) return +1;
  if (neg && !pos) return -1;
  return 0;
}

function ema(prev, cur, alpha = 0.2){
  return (1 - alpha) * prev + alpha * cur;
}

const NAVER_BASELINE_FILE = path.join(CACHE_DIR, 'naver-baseline.json');
let NAVER_BASELINES = null;
async function loadBaseline(sym){
  if (!NAVER_BASELINES){
    try { NAVER_BASELINES = JSON.parse(fs.readFileSync(NAVER_BASELINE_FILE,'utf8')); }
    catch { NAVER_BASELINES = {}; }
  }
  return Number(NAVER_BASELINES[sym] || 0);
}
async function saveBaseline(sym, val){
  if (!NAVER_BASELINES){
    try { NAVER_BASELINES = JSON.parse(fs.readFileSync(NAVER_BASELINE_FILE,'utf8')); }
    catch { NAVER_BASELINES = {}; }
  }
  NAVER_BASELINES[sym] = val;
  try { fs.mkdirSync(path.dirname(NAVER_BASELINE_FILE), { recursive: true });
        fs.writeFileSync(NAVER_BASELINE_FILE, JSON.stringify(NAVER_BASELINES)); } catch {}
}

function to01(x){ return Math.max(0, Math.min(1, x)); }

function ensureDirFor(file){ try { fs.mkdirSync(path.dirname(file), { recursive:true }); } catch {} }
function readJsonSafe(p){ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return null; } }

const KEYWORD_OUTPUT_FILE = process.env.MARKET_KEYWORD_FILE || 'newsKeywords.json';
const KEYWORD_MARKET_QUERIES = [
  { market: 'KOSPI', queries: ['코스피', 'KOSPI index', 'KOSPI market trend'], locales: ['ko', 'en'] },
  { market: 'KOSDAQ', queries: ['코스닥', 'KOSDAQ', 'KOSDAQ market outlook'], locales: ['ko', 'en'] },
  { market: 'NASDAQ 100', queries: ['NASDAQ 100', 'Nasdaq 100 technology stocks'], locales: ['en'] },
  { market: 'S&P 500', queries: ['S&P 500', 'S&P500 economy', '미국 증시 S&P500'], locales: ['en', 'ko'] }
];

const TAG_OUTPUT_FILE = process.env.MARKET_TAG_FILE || 'tags.json';
const TAG_COLLECTION_WINDOW_DAYS = Number(process.env.TAG_COLLECTION_LOOKBACK_DAYS || 14);
const TAG_COLLECTION_PAGE_LIMIT = Number(process.env.TAG_COLLECTION_PAGE_LIMIT || 5);
const TAG_COLLECTION_PAGE_SIZE = Number(process.env.TAG_COLLECTION_PAGE_SIZE || 40);
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

const DATALAB_KEYWORD_COUNT = Number(process.env.DATALAB_KEYWORD_COUNT || 10);

const FINANCE_TREND_KEYWORD_GROUPS = [
  { category: 'Stock Market', keywords: ['주식', '코스피', '코스닥', '주가'] },
  { category: 'Economy', keywords: ['환율', '금리', '경제 전망', 'GDP'] },
  { category: 'Business', keywords: ['삼성전자', '현대자동차', '네이버', '카카오'] },
  { category: 'Finance', keywords: ['비트코인', 'ETF', '채권', '펀드'] }
];

const DATALAB_TREND_KEYWORDS = [
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
].slice(0, DATALAB_KEYWORD_COUNT);

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
  const metricsMap = await fetchDatalabKeywordMetrics(DATALAB_TREND_KEYWORDS);
  if (!metricsMap.size) return [];

  const rawEntries = [];
  for (const config of DATALAB_TREND_KEYWORDS) {
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

    const rawScore = computeDatalabRawScore(metrics, mentions);

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

function buildKeywordSummary(articles){
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

async function translateWithDeepL(text, { targetLang = 'KO', sourceLang = 'EN' } = {}) {
  if (!DEEPL_API_KEY) return null;
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    const res = await fetch('https://api.deepl.com/v2/translate', {
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
      console.warn(`[keywords] DeepL translation failed (${res.status}):`, errText);
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
      .then(mod => mod?.default ?? mod)
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
      '경제',
      '증시',
      '산업 동향',
      '비즈니스 뉴스',
      '금융 시장'
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
      headlineKeys: new Set()
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

  if (collected && collected.length < targetCount) {
    collected.push(normalized);
  }

  return true;
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

  for (const cfg of DATALAB_TREND_KEYWORDS) {
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
      headlineKeys: new Set()
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
  '반도체', 'AI', '인공지능', '2차전지', '배터리', '전기차', '조선', '해운',
  '바이오', '제약', '방산', '원자력', 'SMR', '수소', '클라우드', '로봇',
  '디스플레이', '철강', '자동차', '금리', '환율', '원달러', '연준', 'CPI',
  '인플레이션', '경기침체', '수출', '무역', 'LNG', '에너지', '친환경',
  '헬스케어', '메타버스', '블록체인', 'HBM', '파운드리', '메모리'
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

  const queries = ['증시 동향', '경제 뉴스', '반도체 산업', '2차전지', '금리 전망'];
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

    return {
      ...item,
      sources: Array.from(item.sources),
      originalScore: item.score,
      score: item.score * domainBoost * (1 + diversityBonus)
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

// REDESIGNED: Extract significant 2-3 word phrases that signal newsworthy events
// Focus: "조선업체 호황" not "환율"

// Signal words that indicate something SIGNIFICANT is happening
const SIGNAL_WORDS = {
  positive: new Set([
    '호황', '급등', '사상최대', '최고치', '수주', '흑자전환', '확대', '성장',
    '돌파', '신기록', '증가', '상승', '수출증가', '개선', '회복', '반등'
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

// Extract 2-3 word meaningful phrases from text
function extractSignificantPhrases(text) {
  const cleaned = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^가-힣A-Za-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(/\s+/);
  const phrases = [];

  // Extract 2-word and 3-word combinations
  for (let i = 0; i < words.length - 1; i++) {
    // 2-word phrases
    const phrase2 = `${words[i]} ${words[i + 1]}`;
    if (isPhraseSignificant(phrase2)) {
      phrases.push({ text: phrase2, length: 2 });
    }

    // 3-word phrases
    if (i < words.length - 2) {
      const phrase3 = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      if (isPhraseSignificant(phrase3)) {
        phrases.push({ text: phrase3, length: 3 });
      }
    }
  }

  return phrases;
}

// Check if phrase is significant (contains signal + context)
function isPhraseSignificant(phrase) {
  const words = phrase.split(/\s+/);

  // Must be 2-3 words
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

// Score phrases by significance (not frequency)
function scorePhrasesbySignificance(phrases) {
  const scored = new Map();

  for (const { text, length } of phrases) {
    const existing = scored.get(text);

    if (existing) {
      existing.count += 1;
    } else {
      // Calculate significance score
      let score = 0;

      // Length bonus (3-word phrases are more specific)
      score += length * 10;

      // Signal strength
      const words = text.split(/\s+/);
      for (const w of words) {
        if ([...SIGNAL_WORDS.positive].some(s => w.includes(s))) score += 30;
        if ([...SIGNAL_WORDS.negative].some(s => w.includes(s))) score += 30;
        if ([...SIGNAL_WORDS.change].some(s => w.includes(s))) score += 25;
        if ([...SIGNAL_WORDS.policy].some(s => w.includes(s))) score += 20;
      }

      // Context relevance
      for (const w of words) {
        if (Array.from(SIGNIFICANT_CONTEXTS).some(c => w.includes(c))) score += 15;
      }

      scored.set(text, {
        text,
        count: 1,
        score,
        length
      });
    }
  }

  // Sort by significance score, NOT frequency
  // This ensures "조선업체 호황" (high significance, low freq)
  // ranks above "환율 변동" (low significance, high freq)
  return Array.from(scored.values())
    .sort((a, b) => {
      // Primary: significance score
      if (b.score !== a.score) return b.score - a.score;

      // Secondary: count (tie-breaker)
      if (b.count !== a.count) return b.count - a.count;

      // Tertiary: prefer longer phrases
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
    '반도체 수주', '조선 호황', '2차전지 급등',
    '금리 인하', '수출 증가', '실적 개선',
    '공급망 위기', '규제 완화', '정책 발표'
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

// Main collection function
export async function collectSignificantPhrases({ targetCount = 30 } = {}) {
  console.log('[Significance] Collecting newsworthy 2-3 word phrases...');

  const collectors = [
    extractNaverNewsSignificantPhrases(),
    extractKDISignificantPhrases(),
    extractZumSignificantPhrases()
  ];

  const results = await Promise.allSettled(collectors);
  const allPhrases = [];

  for (const result of results) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      allPhrases.push(...result.value);
    }
  }

  console.log(`[Significance] collected ${allPhrases.length} total phrases`);

  // Score by significance
  const scored = scorePhrasesbySignificance(allPhrases);

  console.log('[Significance] Top 20 by significance score:');
  scored.slice(0, 20).forEach((p, i) => {
    console.log(`  ${i + 1}. "${p.text}" - score: ${p.score}, count: ${p.count}`);
  });

  // Return top N (filtering to phrases of reasonable length)
  return scored
    .filter(p => p.length >= 2 && p.length <= 3)
    .slice(0, targetCount)
    .map(p => ({
      term_ko: p.text,
      score: p.score,
      count: p.count,
      length: p.length,
      source: 'significance_analysis'
    }));
}

// Write output
export async function writeSignificantPhrasesJson({ outputPath = TAG_OUTPUT_FILE } = {}) {
  const targetCount = 30;
  const phrases = await collectSignificantPhrases({ targetCount });

  let financeTrendBoost = [];
  try {
    financeTrendBoost = await fetchFinanceTrendKeywords({ limit: 12 });
  } catch (err) {
    console.warn('[Significance] failed to fetch finance trend keywords:', err?.message || err);
  }

  if (!phrases.length && !financeTrendBoost.length) {
    console.error('[Significance] No significant phrases found');
    return null;
  }

  const aggregated = new Map();

  const registerEntry = (koTerm, { score = 0, mentions = 1 } = {}) => {
    const normalizedKo = normalizeKoKeywordTerm(koTerm);
    if (!normalizedKo) return;

    const significanceScore = Math.max(1, Math.round(score));
    const mentionCount = Math.max(1, Math.round(mentions));

    if (aggregated.has(normalizedKo)) {
      const existing = aggregated.get(normalizedKo);
      existing.significance_score = Math.max(existing.significance_score, significanceScore);
      existing.mentions = Math.max(existing.mentions, mentionCount);
      return;
    }

    aggregated.set(normalizedKo, {
      term_ko: normalizedKo,
      significance_score: significanceScore,
      mentions: mentionCount
    });
  };

  for (const phrase of phrases) {
    if (!phrase) continue;
    registerEntry(phrase.term_ko || phrase.term, {
      score: Number.isFinite(phrase.score) ? phrase.score : 0,
      mentions: Number.isFinite(phrase.count) ? phrase.count : 1
    });
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

    registerEntry(koTerm, { score: scaledScore, mentions: estimatedMentions });
    injectedTrends += 1;
  }

  if (!aggregated.size) {
    console.error('[Significance] No valid phrases after normalization');
    return null;
  }

  const ranked = Array.from(aggregated.values())
    .sort((a, b) => {
      if (b.significance_score !== a.significance_score) {
        return b.significance_score - a.significance_score;
      }
      if (b.mentions !== a.mentions) {
        return b.mentions - a.mentions;
      }
      return a.term_ko.localeCompare(b.term_ko);
    })
    .slice(0, Math.min(aggregated.size, targetCount + Math.min(injectedTrends, 5)));

  const discoveredKeywords = [];
  for (const entry of ranked) {
    const koTerm = entry.term_ko;
    let termEn = '';
    try {
      const translation = await translateKoTermToEn(koTerm, { includeMeta: true });
      termEn = formatTagDisplay(translation.text || '');
      if (termEn) {
        setTranslationCache(termEn, koTerm);
      }
    } catch (err) {
      console.warn(`[Significance] translation failed for "${koTerm}":`, err?.message || err);
    }

    const finalTerm = termEn || formatTagDisplay(koTerm);
    discoveredKeywords.push({
      term: finalTerm,
      term_ko: koTerm,
      significance_score: entry.significance_score,
      mentions: entry.mentions
    });
  }

  const nowIso = new Date().toISOString();
  const payload = {
    date: nowIso.slice(0, 10),
    window: '5_hours',
    total_phrases: discoveredKeywords.length,
    discovered_keywords: discoveredKeywords,
    metadata: {
      collection_method: 'significance_over_frequency',
      phrase_length: '2-3 words',
      scoring: 'signal_words + context_relevance',
      generated_at: nowIso,
      finance_trend_keywords: injectedTrends
    }
  };

  ensureDirFor(outputPath);
  await fsp.writeFile(outputPath, JSON.stringify(payload, null, 2));

  console.log(`[Significance] wrote ${discoveredKeywords.length} significant phrases (finance trends added: ${injectedTrends})`);
  return payload;
}
function buildDiscoveredKeywordsFromStats(tagStats, { limit = 50 } = {}) {
  if (!tagStats || typeof tagStats.size !== 'number' || tagStats.size === 0) return [];
  const entries = [];
  for (const entry of tagStats.values()) {
    const term = chooseTagDisplay(entry);
    if (!term) continue;
    const count = Number(entry?.count || 0);
    entries.push({ term, count });
  }
  entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.term.localeCompare(b.term);
  });
  const top = entries.slice(0, limit);
  const maxCount = top.length ? Math.max(...top.map(item => item.count || 0)) : 0;
  return top.map(item => ({
    term: formatTagDisplay(item.term),
    count: item.count,
    score: maxCount > 0 ? Number((item.count / maxCount).toFixed(2)) : 0
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

  const payload = {
    date: asOfDate,
    window: `${TAG_COLLECTION_WINDOW_DAYS}_days`,
    total_articles: derivedArticleCount,
    discovered_keywords: localizedDiscovered,
    translations
  };

  ensureDirFor(TAG_OUTPUT_FILE);
  await fsp.writeFile(TAG_OUTPUT_FILE, JSON.stringify(payload, null, 2));

  const suffix = fallbackUsed ? ' (fallback)' : '';
  console.log(`[keywords] wrote ${TAG_OUTPUT_FILE} with ${localizedDiscovered.length} keywords${suffix}`);
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
  const existingTagSnapshot = readJsonSafe(TAG_OUTPUT_FILE) || null;

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
    const snapshot = await writeKoreanFirstTagsJson({ outputPath: TAG_OUTPUT_FILE, preCollected: collectionResult });
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

  const markets = Array.isArray(existingSnapshot?.markets) ? existingSnapshot.markets : [];

  const payload = {
    generatedAt: now.toISOString(),
    timezone: tz,
    updatedAt: {
      ko: updatedKo,
      en: updatedEn
    },
    keywords,
    markets
  };

  if (existingSnapshot?.tickerKeywords) {
    payload.tickerKeywords = existingSnapshot.tickerKeywords;
  }
  if (existingSnapshot?.tickerKeywordsMeta) {
    payload.tickerKeywordsMeta = existingSnapshot.tickerKeywordsMeta;
  }

  ensureDirFor(outputPath);
  await fsp.writeFile(outputPath, JSON.stringify(payload, null, 2));
  console.log(`[keywords] wrote ${outputPath} with ${payload.keywords.length} entries`);
  return payload;
}

// --- Ticker-level keyword builder (domain-aware tokenizer) ---
const require = createRequire(import.meta.url);

let okt = null;
try {
  const mod = require('open-korean-text-node');
  okt = (mod && mod.default) ? mod.default : mod;
} catch (e) {
  okt = null;
}

let nlp = null;
try {
  const mod = require('compromise');
  nlp = (mod && mod.default) ? mod.default : mod;
} catch (e) {
  nlp = null;
}

const DOMAIN_LEXICON = new Set([
  '2차전지','전고체 배터리','배터리','조선해양','조선','해운','반도체','HBM','AI','클라우드','로봇',
  '방산','원자력','SMR','바이오','제약','철강','자동차','전장','디스플레이','석유화학','정유',
  '부동산','리츠','건설','물류','원자재','구리','금','환율','달러','유가','수출','수입','무역수지',
  '금리','기준금리','연준','연방준비제도','소비','고용','실업','임금','경기','경기침체','연착륙',
  '소프트랜딩','테슬라','엔비디아','삼성전자','하이닉스','현대차','LG에너지솔루션','LNG',
  'semiconductor','semiconductors','battery','batteries','chip','chips','ai','cloud','robotics','defense',
  'nuclear','smr','lng','biotech','pharma','pharmaceuticals','steel','automotive','mobility','display','petrochemical',
  'oil','energy','gas','refining','logistics','export','exports','import','imports','currency','forex','fx',
  'inflation','recession','growth','earnings','guidance','orders','backlog','naver','kakao'
]);

const CANONICAL_MAP = new Map([
  ['이차전지','2차전지'],
  ['2차 전지','2차전지'],
  ['전지','2차전지'],
  ['전고체배터리','전고체 배터리'],
  ['배터리','2차전지'],
  ['조선','조선해양'],
  ['조선 해양','조선해양'],
  ['해양','조선해양'],
  ['조선업','조선해양'],
  ['해운','조선해양'],
  ['HBM3','HBM'], ['HBM3e','HBM'], ['HBM3E','HBM'], ['HBM2e','HBM'],
  ['메모리','반도체'], ['파운드리','반도체'], ['칩','반도체'],
  ['연방준비제도','연준'],
  ['soft landing','연착륙'], ['소프트랜딩','연착륙'],
  ['전기차','자동차'],
  ['전장화','전장'],
  ['semiconductors','semiconductor'],
  ['batteries','battery'],
  ['chips','chip'],
  ['markets','market'],
  ['exports','export'],
  ['imports','import'],
  ['interest rates','rates'],
  ['electric vehicles','electric vehicle'],
  ['electric vehicle','자동차'],
]);

const BLACKLIST = new Set(['최소','최대','속보','종합','오늘','어제','내일','최근','전문','사진','영상']);
const ECON_SUFFIXES = ['산업','업','시장','수출','수입','무역수지','금리','환율','물가','지수','채권','유가','원자재',
  '실적','가이던스','수주','발주','배터리','전지','조선','해양','반도체','자동차','전장','디스플레이','철강','정유','석유화학','방산','바이오','제약','로봇','원자력','SMR','LNG',
  'market','markets','exports','imports','earnings','revenue','revenues','guidance','sales','demand','supply','inflation','rates','rate','yields','yield','forex','currency','currencies','sector','sectors','industry','industries','index','indices','production','manufacturing','chip','chips','battery','batteries','semiconductor','semiconductors','automotive'];

const MACRO_WHITELIST = new Set([
  'CPI','PPI','PCE','FOMC','GDP','NFP','PMI','ISM','QT','QE',
  '연준','기준금리','인플레이션','디플레이션','연착륙','경기침체','고용','임금','소비',
  '2차전지','조선해양','반도체','HBM','AI','LNG'
]);

const KEYWORD_WHITELIST = new Set([...DOMAIN_LEXICON, ...MACRO_WHITELIST]);

const isHangulTerm = (str) => /[\u3131-\u318E\uAC00-\uD7A3]/.test(str || '');

function isWhitelisted(term, lexicon = KEYWORD_WHITELIST) {
  const t = String(term || '').trim();
  if (!t) return false;
  const collapsed = t.replace(/\s+/g, '');
  const lower = t.toLowerCase();
  const lowerCollapsed = collapsed.toLowerCase();
  return (
    lexicon.has(t) ||
    lexicon.has(collapsed) ||
    lexicon.has(lower) ||
    lexicon.has(lowerCollapsed)
  );
}

function canon(term) {
  const t = term.trim();
  if (CANONICAL_MAP.has(t)) return CANONICAL_MAP.get(t);
  const collapsed = t.replace(/\s+/g, '');
  if (CANONICAL_MAP.has(collapsed)) return CANONICAL_MAP.get(collapsed);
  return t;
}

function looksContenty(token) {
  const raw = String(token || '').trim();
  if (!raw) return false;
  if (BLACKLIST.has(raw)) return false;
  const collapsed = raw.replace(/\s+/g, '');
  if (!/^[\u3131-\u318E\uAC00-\uD7A3A-Za-z0-9-]+$/.test(collapsed)) return false;
  if (/^\d+([.,]\d+)?%?$/.test(collapsed)) return false;
  if (/^\d+(분기|월|일|년)$/.test(collapsed)) return false;
  if (/^\d+$/.test(collapsed)) return false;

  if (isWhitelisted(raw)) {
    return true;
  }

  if (/^[A-Z]{3,6}$/.test(collapsed)) return true;

  if (isHangulTerm(raw)) {
    if (collapsed.length < 2) return false;
    return ECON_SUFFIXES.some(suf => raw.endsWith(suf));
  }

  if (collapsed.length < 3) return false;

  const lower = collapsed.toLowerCase();
  if (ECON_SUFFIXES.some(suf => lower.endsWith(suf.toLowerCase()))) return true;

  return false;
}

function koNouns(text) {
  if (!text) return [];
  const str = String(text);
  if (okt && typeof okt.normalizeSync === 'function' && typeof okt.posSync === 'function') {
    try {
      const norm = okt.normalizeSync(str);
      const pos = okt.posSync(norm);
      return pos
        .filter(([w, tag]) => tag === 'Noun')
        .map(([w]) => w.trim())
        .filter(w => looksContenty(w) || isWhitelisted(w));
    } catch {}
  }
  return (str.match(/[\uAC00-\uD7A3]{2,}/g) || [])
    .map(w => w.trim())
    .filter(w => looksContenty(w) || isWhitelisted(w));
}

function enNouns(text) {
  if (!text) return [];
  const str = String(text);
  if (nlp) {
    try {
      const doc = nlp(str);
      return [
        ...doc.nouns().out('array'),
        ...doc.match('#Acronym').out('array'),
      ]
        .map(t => t.trim())
        .filter(t => looksContenty(t) || isWhitelisted(t));
    } catch {}
  }
  return (str.match(/[A-Za-z][A-Za-z0-9\-]{2,}/g) || [])
    .map(t => t.trim())
    .filter(t => looksContenty(t) || isWhitelisted(t));
}

function ngrams(tokens, n = 2) {
  const out = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    out.push(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

function addCollocations(docs, addTerm) {
  docs.forEach(({ text, url }) => {
    const ko = koNouns(text);
    const en = enNouns(text);
    const grams = [...ngrams(ko, 2), ...ngrams(en, 2)];
    grams.forEach(g => {
      const collapsed = g.replace(/\s+/g, '');
      if (looksContenty(collapsed) || isWhitelisted(g) || isWhitelisted(collapsed)) {
        addTerm(g, url);
      }
    });
  });
}

function scoreTerms(docs, domainLexicon = new Set()) {
  const tf = [];
  const df = new Map();

  docs.forEach((doc, idx) => {
    const tokens = [...koNouns(doc.text), ...enNouns(doc.text)];
    const titleTokens = new Set([...koNouns(doc.title || ''), ...enNouns(doc.title || '')]);
    const tfMap = new Map();

    tokens.forEach(t => {
      const key = t.trim();
      if (!key) return;
      tfMap.set(key, (tfMap.get(key) || 0) + 1);
    });

    tf.push({ tfMap, titleTokens, url: doc.url || `doc_${idx}`, text: doc.text });
    const unique = new Set(tfMap.keys());
    unique.forEach(term => df.set(term, (df.get(term) || 0) + 1));
  });

  const N = docs.length || 1;
  const scores = new Map();

  tf.forEach(({ tfMap, titleTokens, url }) => {
    for (const [term, freq] of tfMap.entries()) {
      const idf = Math.log((N + 1) / ((df.get(term) || 0) + 1)) + 1;
      let s = freq * idf;
      if (titleTokens.has(term)) s *= 1.4;
      if (isWhitelisted(term, domainLexicon)) s *= 1.6;

      const cur = scores.get(term) || { score: 0, sources: new Set() };
      cur.score += s;
      cur.sources.add(url);
      scores.set(term, cur);
    }
  });

  addCollocations(tf.map(({ text, url }, i) => ({ text, url: url || `doc_${i}` })), (term, url) => {
    const clean = term.trim();
    if (!clean) return;
    const cur = scores.get(clean) || { score: 0, sources: new Set() };
    cur.score += 0.5;
    if (url) cur.sources.add(url);
    scores.set(clean, cur);
  });

  for (const [, info] of scores.entries()) {
    const src = Math.min(info.sources.size, 5);
    info.score *= 1 + (src - 1) * 0.2;
  }

  return scores;
}

function pickKeywords(scores, domainLexicon) {
  const MIN_SCORE = 1.6;
  const MIN_SOURCES = 2;
  const arr = [];

  for (const [term, { score, sources }] of scores.entries()) {
    const canonicalTerm = canon(term);
    const collapsed = canonicalTerm.replace(/\s+/g, '');
    if (!looksContenty(collapsed) && !domainLexicon.has(canonicalTerm) && !domainLexicon.has(collapsed)) continue;

    const srcCount = sources.size;
    const whitelisted = isWhitelisted(canonicalTerm, domainLexicon) || isWhitelisted(collapsed, domainLexicon);

    if ((srcCount >= MIN_SOURCES && score >= MIN_SCORE) || whitelisted) {
      arr.push({ term: canonicalTerm, score: Number(score.toFixed(3)), sources: [...sources].slice(0, 5) });
    }
  }

  const deduped = new Map();
  for (const item of arr) {
    const key = item.term;
    const prev = deduped.get(key);
    if (!prev || item.score > prev.score) {
      deduped.set(key, item);
    }
  }

  const ranked = [...deduped.values()].sort((a, b) => b.score - a.score);
  if (ranked.length) {
    return ranked.slice(0, 20);
  }

  return pickRandomImportantTerms(scores, domainLexicon, 10);
}

function shuffleArrayInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickRandomImportantTerms(scores, domainLexicon, count = 10) {
  const important = [];
  const fallback = [];

  for (const [term, value] of scores.entries()) {
    const canonicalTerm = canon(term);
    const collapsed = canonicalTerm.replace(/\s+/g, '');
    const info = {
      term: formatTagDisplay(canonicalTerm),
      score: Number((value?.score || 0).toFixed(3)),
      sources: Array.from(value?.sources || []).slice(0, 5)
    };

    const isImportant = isWhitelisted(canonicalTerm, domainLexicon) || isWhitelisted(collapsed, domainLexicon);
    if (isImportant) {
      important.push(info);
    } else if (looksContenty(collapsed)) {
      fallback.push(info);
    }
  }

  const dedupe = (list) => {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const key = String(item.term || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  };

  const chosen = [];
  const importantPool = dedupe(important);
  shuffleArrayInPlace(importantPool);
  chosen.push(...importantPool.slice(0, count));

  if (chosen.length < count) {
    const remaining = count - chosen.length;
    const fallbackPool = dedupe(fallback).filter(item => item.term);
    shuffleArrayInPlace(fallbackPool);
    chosen.push(...fallbackPool.slice(0, remaining));
  }

  return chosen.slice(0, count);
}

function extractKeywords(articles, domainLexicon) {
  const docs = articles.map(a => ({
    title: a.title || '',
    url: a.url || '',
    text: [a.title, a.summary, a.body].filter(Boolean).join(' ')
  }));

  const scores = scoreTerms(docs, domainLexicon);

  for (const [term, value] of [...scores.entries()]) {
    const c = canon(term);
    if (c !== term) {
      const cur = scores.get(c) || { score: 0, sources: new Set() };
      cur.score += value.score;
      value.sources.forEach(src => cur.sources.add(src));
      scores.set(c, cur);
      scores.delete(term);
    }
  }

  return pickKeywords(scores, domainLexicon);
}

function normalizeMetadataToken(token) {
  return String(token || '').replace(/\s+/g, ' ').trim();
}

function shouldIncludeMetadataToken(token) {
  if (!token) return false;
  const hasHangul = containsHangul(token);
  if (hasHangul && STOPWORDS_KO.has(token)) return false;
  const lower = token.toLowerCase();
  if (!hasHangul && STOPWORDS_EN.has(lower)) return false;
  const collapsed = token.replace(/\s+/g, '');
  if (collapsed.length < 2) return false;
  if (looksContenty(token) || isWhitelisted(token)) return true;
  const parts = token.split(/\s+/).filter(Boolean);
  return parts.some(part => looksContenty(part) || isWhitelisted(part));
}

function collectMetadataKeywords(articles) {
  const meta = new Map();
  const push = (raw, weight, sourceLabel) => {
    const normalized = normalizeMetadataToken(raw);
    if (!normalized || !shouldIncludeMetadataToken(normalized)) return;
    const key = canon(normalized);
    const entry = meta.get(key) || { term: key, score: 0, sources: new Set() };
    entry.score += weight;
    entry.sources.add(sourceLabel);
    meta.set(key, entry);
  };

  for (const article of articles) {
    if (!article || typeof article !== 'object') continue;
    if (Array.isArray(article.tags)) {
      for (const tag of article.tags) push(tag, 2.5, 'tag');
    }
    if (Array.isArray(article.keywords)) {
      for (const kw of article.keywords) push(kw, 2.0, 'keyword');
    }
    if (Array.isArray(article.tickers)) {
      for (const ticker of article.tickers) push(ticker, 1.5, 'ticker');
    }
  }

  return meta;
}

export function buildNewsKeywords(articlesByTicker, { tagSnapshot = null } = {}) {
  const output = {
    generated_at: new Date().toISOString(),
    version: '1.0',
    tickers: {}
  };

  const koLookup = buildTermKoLookup(tagSnapshot);

  for (const [ticker, articles] of Object.entries(articlesByTicker || {})) {
    if (!Array.isArray(articles) || !articles.length) continue;
    const metaMap = collectMetadataKeywords(articles);
    const metaKeywords = [...metaMap.values()]
      .map(entry => ({
        term: entry.term,
        score: Number(entry.score.toFixed(3)),
        sources: Array.from(entry.sources)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    const textKeywords = extractKeywords(articles, KEYWORD_WHITELIST).slice(0, 10);

    const combined = [];
    const seen = new Set();
    const pushUnique = (item) => {
      if (!item || !item.term) return;
      const key = item.term;
      if (seen.has(key)) return;
      seen.add(key);
      combined.push(item);
    };

    metaKeywords.forEach(pushUnique);
    textKeywords.forEach(pushUnique);

    if (combined.length) {
      const enriched = combined.slice(0, 12).map(item => {
        const rawTerm = String(item.term || '').trim();
        if (!rawTerm) return item;
        const hasHangul = containsHangul(rawTerm);
        const formattedTerm = hasHangul ? rawTerm : formatTagDisplay(rawTerm);
        const storedKo = lookupKoFromMap(koLookup, formattedTerm);
        if (storedKo) {
          setTranslationCache(formattedTerm, storedKo);
        }
        const koTerm = storedKo || (hasHangul ? rawTerm : translateTagToKo(formattedTerm));
        if (koTerm && containsHangul(koTerm)) {
          setTranslationCache(formattedTerm, koTerm);
        }
        return {
          ...item,
          term: formattedTerm,
          term_ko: koTerm
        };
      });
      output.tickers[ticker] = { keywords: enriched };
    }
  }
  return output;
}

export function newsScoreFromFeatures(f) {
  if (typeof f?.newsScore === 'number') return f.newsScore;
  const naverKO = Number(f?.naverCountKO || 0);
  const naverEN = Number(f?.naverCountEN || 0);
  const other = Number(f?.otherCount || ((f?._source === 'naver') ? 0 : (f?.count || 0)));
  const blogs = Number(f?.blogMentions || 0);
  const weightedNaver = NAVER_KO_WEIGHT * naverKO + NAVER_EN_WEIGHT * naverEN;
  const weighted = weightedNaver + OTHER_NEWS_WEIGHT * other + NAVER_BLOG_WEIGHT * blogs;
  return to01(Math.tanh(weighted / 10));
}

const buckets = {
  deepsearch: tokenBucket({capacity:3, refillPerSec:2}),
  newsapi: tokenBucket({capacity:3, refillPerSec:2}),
  newsdata: tokenBucket({capacity:3, refillPerSec:2}),
  serpapi: tokenBucket({capacity:2, refillPerSec:1.5}),
  finnhub: tokenBucket({capacity:2, refillPerSec:1}),
  gdelt: tokenBucket({capacity:2, refillPerSec:1}),
  naver: tokenBucket({capacity:5, refillPerSec:3}),
  polygon: tokenBucket({capacity:2, refillPerSec:1}),
};

// Persist tiny provider health to prefer healthy ones next run
const PROV_SCORE_FILE = path.join(CACHE_DIR,'news-provider-score.json');
function loadProvScore(){ try { return JSON.parse(fs.readFileSync(PROV_SCORE_FILE,'utf8')); } catch { return {}; } }
function saveProvScore(s){ try { fs.writeFileSync(PROV_SCORE_FILE, JSON.stringify(s)); } catch {} }
const provScore = loadProvScore();
function markProvider(p, ok){ const s = (provScore[p] ||= {ok:0,fail:0,lastFail:0}); ok ? s.ok++ : (s.fail++, s.lastFail=Date.now()); saveProvScore(provScore); }

let FINNHUB_OK;
const cb = circuitBreaker({cooldownMs:20*60_000});
const ALIAS_PATH = path.join(process.cwd(), 'src/news/symbol-aliases.json');
const SYMBOL_ALIASES = (()=>{ try { return JSON.parse(fs.readFileSync(ALIAS_PATH, 'utf8')); } catch { return {}; }})();

async function guardedCall(name, fn){
  if (cb.isOpen(name)) return null;
  await buckets[name]?.();
  try {
    return await fn();
  } catch (e){
    const msg = String(e?.message||e);
    if (/HTTP (401|403)/.test(msg)) cb.open(name);
    throw e;
  }
}

function looksLikeXmlOrHtml(s){ const t=String(s||'').trim(); return !!t && t.startsWith('<'); }
function cacheKey(url){ return path.join(CACHE_DIR, `news-${Buffer.from(url).toString('base64url')}.json`); }

async function cachedJson(url, fetcher, ttlMs=NEWS_TTL_MS, allowStale=ALLOW_STALE_NEWS){
  const key = cacheKey(url);
  let cached; let age=Infinity;
  try {
    const st=fs.statSync(key); age=Date.now()-st.mtimeMs;
    cached = JSON.parse(fs.readFileSync(key,'utf8'));
    if (age < ttlMs) return cached;
  } catch {}
  try {
    const data = await fetcher(url);
    try { fs.mkdirSync(CACHE_DIR,{recursive:true}); fs.writeFileSync(key, JSON.stringify(data)); } catch {}
    return data;
  } catch (e){
    if (allowStale && cached) return cached;
    throw e;
  }
}
async function safeGetJson(url, headers={}, timeoutMs=REQ_TIMEOUT_MS){
  const ctrl = new AbortController();
  const connectTimer = setTimeout(()=>ctrl.abort(new Error('timeout')), CONNECT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers: { ...defaultHeaders, ...headers }, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(connectTimer);
  } catch (e){
    const host = (()=>{ try { return new URL(url).host; } catch { return 'unknown-host'; }})();
    const code = e?.cause?.code || e.name || 'ERR_FETCH';
    throw new Error(`fetch failed (${host}): ${e.message} [${code}]`);
  }
  const readTimer = setTimeout(()=>ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    if (!res.ok) {
      const hdrs = {};
      res.headers?.forEach((v,k)=>hdrs[k]=v);
      const err = new Error(`HTTP ${res.status}`);
      err.responseHeaders = hdrs;
      throw err;
    }
    const ct = res.headers?.get?.('content-type') || '';
    if (/json/i.test(ct)) return await res.json();
    const txt = await res.text();
    if (looksLikeXmlOrHtml(txt)) throw new Error(`non-JSON payload (${ct||'unknown'})`);
    return JSON.parse(txt);
  } catch(e){
    if (e instanceof SyntaxError) throw new Error(`JSON parse failed (${e.message})`);
    throw e;
  } finally {
    clearTimeout(readTimer);
  }
}

function isKR(sym){ return /\.K[QS]$/.test(sym); }
function isUS(sym){ return /^[A-Z]+$/.test(sym) && !/\.K[QS]$/i.test(sym); }

function baseSymbol(sym){ return String(sym||'').replace(/[\.\-]/g,'').toUpperCase(); }

function dsSymbolFor(yahooSym){
  // 005930.KS -> KRX:005930, 123456.KQ -> KRX:123456
  if (/\.K[QS]$/i.test(yahooSym)) {
    const m = yahooSym.match(/^(\d{5,6})\.K[QS]$/i);
    return m ? `KRX:${m[1]}` : null;
  }
  // Pure alpha like NVDA, MSFT… assume NASDAQ unless overridden
  if (/^[A-Z]+$/.test(yahooSym)) return `${DEEPS_US_EXCHANGE}:${yahooSym}`;
  return null;
}

function iso(d){ return d.toISOString().slice(0,10); }
function daysAgo(n){ const t=new Date(); t.setDate(t.getDate()-n); return iso(t); }

// Small linear regression slope on equally spaced points
function slope01(arr){ // returns slope normalized-ish (−1..+1)
  if (!arr.length) return 0;
  const n = arr.length, xs = [...Array(n)].map((_,i)=>i);
  const mx = (n-1)/2, my = arr.reduce((a,b)=>a+b,0)/n;
  let num=0, den=0;
  for (let i=0;i<n;i++){ num += (xs[i]-mx)*(arr[i]-my); den += (xs[i]-mx)*(xs[i]-mx); }
  if (den === 0) return 0;
  // scale by average to keep comparable across tickers
  const s = num/den;
  return my > 0 ? Math.max(-1, Math.min(1, s / Math.max(1,my))) : 0;
}

async function fetchPolygonTrend(ticker) {
  if (!polygonRest || !isUS(ticker)) return null;
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 2 * 24 * 60 * 60 * 1000);
    const res = await polygonRest.stocks.aggregates(
      ticker,
      1,
      'day',
      start.toISOString().slice(0, 10),
      end.toISOString().slice(0, 10)
    );
    const arr = Array.isArray(res?.results) ? res.results : [];
    if (arr.length >= 2) {
      const prev = arr[arr.length - 2];
      const last = arr[arr.length - 1];
      const pc = prev?.c;
      const lc = last?.c;
      if (typeof pc === 'number' && typeof lc === 'number' && pc !== 0) {
        return (lc - pc) / pc;
      }
    }
  } catch (e) {
    console.warn(`polygon trend failed for ${ticker}:`, e.message || e);
  }
  return null;
}

async function fetchPrevClose(ticker) {
  if (!polygonRest || !isUS(ticker)) return null;
  try {
    const res = await polygonRest.stocks.previousClose(ticker, { adjusted: true });
    const close = res?.results?.[0]?.c;
    return typeof close === 'number' ? close : null;
  } catch (e) {
    console.warn(`polygon close failed for ${ticker}:`, e.message || e);
    return null;
  }
}

// Prefer the human/company name everywhere (ticker only as a fallback).
function buildQueries(symbols, { symbolToName={} }={}) {
  const q = {};
  for (const s of symbols){
    const name = String(symbolToName[s] || '').trim();
    q[s] = name || s;
  }
  return q;
}

async function mapLimit(items, limit, worker){
  const out = new Array(items.length);
  let i=0, active=0; 
  await new Promise((resolve, reject)=>{
    const next=()=>{
      while (active<limit && i<items.length){
        const idx=i++; active++;
        Promise.resolve(worker(items[idx], idx))
          .then(v=>{ out[idx]=v; active--; next(); })
          .catch(reject);
      }
      if (i>=items.length && active===0) resolve();
    };
    next();
  });
  return out;
}

async function withRetry(fn,{max=2,baseMs=600,onError}={}){
  let last;
  for(let i=0;i<=max;i++){
    try { return await fn(); }
    catch(e){
      last=e;
      const msg=String(e);
      const ra=Number((e?.responseHeaders?.['retry-after'])||0);
      const is429=/HTTP 429/.test(msg);
      const wait=typeof onError==='function' ? (onError(e)||0) : 0;
      const backoff=Math.floor((is429 ? (ra*1000||baseMs*Math.pow(2,i)) : baseMs*Math.pow(2,i))*(0.6+Math.random()*0.6));
      if(i<max) await new Promise(r=>setTimeout(r, Math.max(wait, backoff)));
      else break;
    }
  }
  throw last;
}

async function with429Retry(fn, max=2, baseMs=600){
  return withRetry(fn,{max, baseMs});
}

async function naverSearch({ query, NAVER_ID, NAVER_SECRET }) {
  if (SKIP_NAVER) return { items: [] };
  if (!NAVER_ID || !NAVER_SECRET) return { items: [] };
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=20&sort=date`;
  const headers = { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET };
  return await withRetry(
    () => cachedJson(url, (u)=>safeGetJson(u, headers), 20*60*1000, true),
    { max: 1, baseMs: 600 }
  );
}

/**
 * Provider calls (each returns a {count, sentiment?, blogMentions?} shape or null)
 */
async function newsFromDeepSearch(sym, name){
  if (!DEEPS_API_KEY) return null;

  const dsSym = dsSymbolFor(sym);
  // Pick endpoint by market
  const isKr = /\.K[QS]$/i.test(sym);
  const base = isKr ? 'https://api-v2.deepsearch.com/v1/articles'
                    : 'https://api-v2.deepsearch.com/v1/global-articles';

  // 7d window for counts; also pull daily aggregation for slope/burst
  const date_to   = daysAgo(0);
  const date_from = daysAgo(7);

  const params = new URLSearchParams();
  params.set('page_size','1'); // we just need counts
  params.set('date_from', date_from);
  params.set('date_to', date_to);
  if (dsSym) params.set('symbols', dsSym);
  else params.set('company_name', name); // fallback

  const headers = { ...defaultUA, Authorization: `Bearer ${DEEPS_API_KEY}` };

  // total count in window
  const j = await withRetry(
    () => cachedJson(`${base}?${params.toString()}`, (u)=>safeGetJson(u, headers), 10*60*1000, true),
    {max:2, baseMs:700}
  );
  const total = Number(j?.total_items || 0);

  // daily aggregation
  const aggParams = new URLSearchParams();
  aggParams.set('date_from', date_from);
  aggParams.set('date_to', date_to);
  aggParams.set('groupby', 'published_at');
  aggParams.set('size', '1000');
  if (dsSym) aggParams.set('symbols', dsSym);
  else aggParams.set('company_name', name);

  const aggBase = isKr ? 'https://api-v2.deepsearch.com/v1/articles/aggregation'
                       : 'https://api-v2.deepsearch.com/v1/global-articles/aggregation';

  const a = await withRetry(
    () => cachedJson(`${aggBase}?${aggParams.toString()}`, (u)=>safeGetJson(u, headers), 10*60*1000, true),
    {max:2, baseMs:700}
  );

  // Build 8-day histogram (pad zeros)
  const byDay = Object.fromEntries(
    (Array.isArray(a?.data) ? a.data : []).map(it => {
      const k = (it?.key || it?.published_at || '').slice(0,10);
      const c = Number(it?.doc_count ?? it?.count ?? it?.value ?? 0);
      return [k, isFinite(c) ? c : 0];
    })
  );
  const days = [...Array(8)].map((_,i)=>daysAgo(7-i));
  const daily = days.map(d => byDay[d] || 0);

  // Trend & burst
  const slope = slope01(daily);                          // −1..+1
  const recent = daily.slice(-2).reduce((a,b)=>a+b,0);
  const prev   = daily.slice(-4,-2).reduce((a,b)=>a+b,0);
  const burst  = prev > 0 ? Math.min(3, (recent - prev) / prev) : (recent>0 ? 1 : 0); // cap +300%

  return {
    count: Math.min(total, 10000),
    sentiment: 0,
    blogMentions: 0,
    ds_news7: total,              // total hits (7d)
    ds_slope7: slope,             // normalized trend slope
    ds_burst: burst,              // 2d vs prior 2d
    ds_trend: Math.max(0, slope), // for your hotness (non-negative)
  };
}

async function newsFromFinnhub(sym, FINNHUB){
  if (!FINNHUB || !isUS(sym)) return null; // avoid KR .KS/.KQ => HTTP 403
  if (typeof FINNHUB_OK !== 'undefined' && !FINNHUB_OK) return null;
  const to = new Date().toISOString().slice(0,10);
  const from = new Date(Date.now()-7*864e5).toISOString().slice(0,10);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}&token=${FINNHUB}`;
  const j = await withRetry(
    () => cachedJson(url, (u)=>safeGetJson(u, defaultUA), 20*60*1000, true),
    {max:2, baseMs:600}
  );
  const arr = Array.isArray(j) ? j : [];
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
}

// Use company *name* (not ticker) for title filtering
async function newsFromNewsAPI(sym, name, NEWSAPI){
  if (!NEWSAPI) return null;
  const url = `https://newsapi.org/v2/everything?qInTitle=${encodeURIComponent(name)}&language=en&pageSize=10&sortBy=publishedAt&apiKey=${NEWSAPI}`;
  const j = await withRetry(() => cachedJson(url, (u)=>safeGetJson(u, defaultUA), 20*60*1000, true), {max:1, baseMs:600});
  const arr = Array.isArray(j?.articles) ? j.articles : [];
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
}

/**
 * SerpApi (Google News)
 * Docs: https://serpapi.com/google-news-api
 * We localize KR vs US via gl/hl and add a recency hint (when:7d).
 */
async function newsFromSerpApi(sym, name, SERPAPI){
  if (!SERPAPI) return null;
  const isKr = isKR(sym);
  const gl = isKr ? 'kr' : 'us';
  const hl = isKr ? 'ko' : 'en';
  const baseQ = `"${name}" OR ${sym} site:news.google.com`;
  const finalQ = /\bwhen:\d+[hdwmy]?\b/i.test(baseQ) ? baseQ : `${baseQ} when:7d`;
  const url = `https://serpapi.com/search.json?engine=google_news&q=${encodeURIComponent(finalQ)}&gl=${gl}&hl=${hl}&no_cache=false&api_key=${SERPAPI}`;
  const j = await withRetry(() => cachedJson(url, (u)=>safeGetJson(u, defaultUA), 20*60*1000, true), {max:1, baseMs:600});
  const arr = Array.isArray(j?.news_results) ? j.news_results : [];
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
}

async function newsFromGNews(sym, q, GNEWS_API){
  if (!GNEWS_API) return null;

  // Choose language by market (you can tweak country= as well if you like):
  const isKr = isKR(sym);
  const lang = isKr ? 'ko' : 'en';

  // Keep it simple and quota-friendly. You can add date filters later if needed.
  // Docs: https://gnews.io/api/v4/search?q=...&lang=...&max=...&apikey=KEY
  const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=${lang}&max=10&apikey=${GNEWS_API}`;

  // Cache ~20 min; allow stale like others
  const j = await cachedJson(url, (u)=>safeGetJson(u, defaultUA), 20*60*1000, true);

  const arr = Array.isArray(j?.articles) ? j.articles : [];
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
}

async function newsdataArchiveFetch({
  q, qInTitle, languages = ['en', 'ko'],
  fromDate, toDate,
  size = Number(process.env.NEWSDATA_SIZE || 25),
  pageLimit = Number(process.env.NEWSDATA_PAGE_LIMIT || 3),
}) {
  if (!NEWSDATA_API_KEY) return [];

  // Newsdata allows multiple languages comma-separated and uses `page` token from `nextPage`
  const base = new URL('https://newsdata.io/api/1/archive');
  base.searchParams.set('apikey', NEWSDATA_API_KEY);
  base.searchParams.set('size', String(size));
  base.searchParams.set('language', languages.join(','));
  if (fromDate) base.searchParams.set('from_date', fromDate);
  if (toDate)   base.searchParams.set('to_date', toDate);
  if (qInTitle) base.searchParams.set('qInTitle', qInTitle);
  else if (q)   base.searchParams.set('q', q); // q and qInTitle are mutually exclusive

  let url = base.toString();
  const items = [];
  let pages = 0;

  while (url && pages < pageLimit) {
    await buckets.newsdata?.();
    const j = await withRetry(
      () => cachedJson(url, (u) => safeGetJson(u, defaultUA), 20 * 60 * 1000, true),
      {
        max: 2,
        baseMs: 1000,
        onError: (err) => isRateLimitError(err) ? retryAfterMsFromError(err, 5000) : 0
      }
    );
    const arr = Array.isArray(j?.results) ? j.results : [];
    items.push(...arr.map(normalizeNewsDataArticle).filter(Boolean));

    const next = j?.nextPage; // use `page=<token>` to go to next page
    pages++;
    if (next) {
      const nxt = new URL(base);
      nxt.searchParams.set('page', next);
      url = nxt.toString();
    } else {
      url = null;
    }
  }

  return dedupeArticles(items);
}

// Prefer searching by company *name* in title with a 7d archive window
async function newsFromNewsData(sym, name, opts) {
  if (!NEWSDATA_API_KEY) return null;

  const windowDays = Number(process.env.NEWSDATA_DATE_WINDOW_DAYS || 7);
  const from = daysAgo(windowDays);
  const to   = daysAgo(0);

  const items = await newsdataArchiveFetch({
    qInTitle: String(name || sym).slice(0, 300),
    languages: ['en', 'ko'],
    fromDate: from,
    toDate: to,
  });

  const keyz = (opts?.keywords && Array.isArray(opts.keywords[sym])) ? opts.keywords[sym] : null;
  if (keyz && keyz.length) {
    const kwQ = keyz.map(k => `"${String(k).trim()}"`).join(' OR ');
    const more = await newsdataArchiveFetch({
      q: kwQ,
      languages: ['en', 'ko'],
      fromDate: from,
      toDate: to,
    }).catch(() => []);
    items.push(...more);
  }

  const unique = dedupeArticles(items);

  return {
    count: Math.min(unique.length, 30),
    sentiment: 0,
    blogMentions: 0,
  };
}

async function newsFromNaver(symOrName, NAVER_ID, NAVER_SECRET, opts = {}) {
  if (SKIP_NAVER) return null;
  if (!NAVER_ID || !NAVER_SECRET) return null;

  const sym = String(opts.sym || '').trim();
  const name = String(symOrName || '').trim();
  const keywords = Array.isArray(opts.keywords) ? opts.keywords : [];
  const isKr = isKR(sym) || /[가-힣]/.test(name);

  const queries = keywords.length
    ? keywords.slice(0, 8)
    : (() => {
        const terms = [];
        if (name) terms.push(`"${name}"`);
        if (sym) terms.push(sym.replace(/\.[A-Z]+$/, ''));
        const q = isKr ? `${terms.join(' OR ')} 증권 OR 투자` : terms.join(' OR ');
        return [q];
      })();

  const seen = new Set();
  let posHits = 0, negHits = 0, totalW = 0, rawCount = 0;
  for (const q of queries) {
    const res = await naverSearch({ query: q, NAVER_ID, NAVER_SECRET });
    for (const it of res?.items || []) {
      const key = normalizeTitle(it.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const w = hostWeight(it.link);
      const pol = classifyPolarity(it.title + ' ' + (it.description || ''));
      if (pol > 0) posHits += w;
      else if (pol < 0) negHits += w;
      totalW += w;
      rawCount++;
    }
  }

  const sentiment = totalW > 0 ? (posHits - negHits) / totalW : 0;

  const today = totalW;
  const key = sym || name;
  const baseline = await loadBaseline(key);
  const alpha = Number(process.env.NAVER_ASVI_ALPHA || 0.2);
  const asvi = baseline > 0 ? (today / baseline) - 1 : (today > 0 ? 1 : 0);
  await saveBaseline(key, ema(baseline, today, alpha));

  const newsScore = Math.max(0, Math.tanh(today / 8));

  return {
    count: rawCount,
    weightedCount: totalW,
    posHits: +posHits.toFixed(2),
    negHits: +negHits.toFixed(2),
    sentiment,
    naverAsvi: asvi,
    naverSpike: Math.max(0, asvi),
    newsScore,
    naverCount: rawCount,
    naverCountKO: 0,
    naverCountEN: 0,
    blogMentions: 0,
  };
}

async function blogFromNaver(name, NAVER_ID, NAVER_SECRET){
  if (SKIP_NAVER) return 0;
  if (!NAVER_ID || !NAVER_SECRET) return 0;
  const q = `${name} + 증권 OR 투자`;
  const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(q)}&display=10&sort=date`;
  const headers = { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET };
  const j = await withRetry(() => cachedJson(url, (u)=>safeGetJson(u, headers), 20*60*1000, true), {max:1, baseMs:600});
  const arr = Array.isArray(j?.items) ? j.items : [];
  return Math.min(arr.length, 30);
}

// Official KOTRA endpoint (Data.go.kr)
// Docs params: serviceKey, type=json, numOfRows, pageNo,
//   search1=국가명, search2=뉴스제목, search4=시작(YYYYMMDD), search7=종료(YYYYMMDD),
//   search5=산업분류, search6=핫클립, search8=본문포함 여부(Y/N)
const KOTRA_BASE =
  'https://apis.data.go.kr/B410001/kotra_overseasMarketNews/ovseaMrktNews';

function natnForSym(sym) {
  if (/\.K[QS]$/.test(sym)) return '대한민국';
  return '미국';
}

function buildKotraUrl({
  serviceKey,
  natn,
  title,
  rows = 10,
  page = 1,
  includeText = true,
  fromYmd,
  toYmd,
}) {
  const params = new URLSearchParams();
  params.set('serviceKey', serviceKey);
  params.set('type', 'json');
  params.set('numOfRows', String(rows));
  params.set('pageNo', String(page));
  if (includeText) params.set('search8', 'Y');
  if (natn) params.set('search1', natn);
  if (title) params.set('search2', title);
  if (fromYmd) params.set('search4', fromYmd); // 시작일자 YYYYMMDD
  if (toYmd)   params.set('search7', toYmd);   // 종료일자 YYYYMMDD
  return `${KOTRA_BASE}?${params.toString()}`;
}

async function newsFromKotra(sym, rawQuery) {
  // Prefer decoded service key so URLSearchParams encodes it exactly once.
  const serviceKey = chooseServiceKeyForDataGoKr();
  if (!serviceKey) return null;

  const natn = natnForSym(sym);
  const d = (n)=>{ const t=new Date(); t.setDate(t.getDate()+n); return t.toISOString().slice(0,10).replace(/-/g,''); };
  const from = d(-7), to = d(0);
  const url = buildKotraUrl({
    serviceKey,
    natn,
    title: rawQuery,
    rows: 10,
    page: 1,
    includeText: true,
    fromYmd: from,
    toYmd: to
  });

  const headers = { Accept: 'application/json' };
  // KOTRA will often return XML on auth/param error; soft-fail to keep other providers running.
  const j = await withRetry(() => cachedJson(url, async (u) => {
    try { return await safeGetJson(u, headers); }
    catch (e) {
      if (String(e.message).includes('non-JSON payload')) {
        return { response: { header: { resultCode: 'XX' }, body: {} } };
      }
      throw e;
    }
  }, 20 * 60 * 1000, true), {max:1, baseMs:600});

  const header = j?.response?.header;
  if (!header || header.resultCode !== '00') return { count: 0, sentiment: 0, blogMentions: 0 };

  // item can be an object or array; dedupe by title to be safe
  const itemsNode = j?.response?.body?.itemList?.item;
  const items = Array.isArray(itemsNode) ? itemsNode : (itemsNode ? [itemsNode] : []);
  const seen = new Set();
  let unique = 0, kwHits = 0;
  for (const it of items) {
    const title = String(it?.title || it?.newsSj || '').trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    unique++;
    if (typeof it?.kwrd === 'string' && it.kwrd.trim()) kwHits++;
  }
  const count = Math.min(unique, 30);
  return { count, sentiment: 0, blogMentions: Math.min(kwHits, 10) };
}

async function newsFromGdelt(sym, q){
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&format=json&maxrecords=5&timespan=7d&sort=DateDesc`;
  const j = await withRetry(() => cachedJson(url, async (u)=>{
    try { return await safeGetJson(u, defaultUA, 4000); }
    catch(e){
      if (String(e.message).includes('non-JSON payload')) return { items: [] };
      throw e;
    }
  }, 10*60*1000, true), {max:1, baseMs:800});
  const arr = Array.isArray(j?.articles) ? j.articles : (Array.isArray(j?.items) ? j.items : []);
  return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
}

async function newsFromPolygon(sym){
  if (!polygonRest) return null;
  try {
    const res = await withRetry(() => polygonRest.reference.tickerNews({
      ticker: sym,
      limit: Number(process.env.POLYGON_NEWS_LIMIT || 50),
      order: 'desc'
    }), { max: 1, baseMs: 600 });
    const arr = Array.isArray(res?.results) ? res.results : [];
    return { count: Math.min(arr.length, 30), sentiment: 0, blogMentions: 0 };
  } catch (err) {
    console.warn(`polygon news failed for ${sym}:`, err?.message || err);
    return null;
  }
}

/**
 * Build Naver "trends" style popularity from Naver Search API results.
 * - Strictly uses COMPANY NAME for the query (no ticker).
 * - Output shape mirrors your existing example: { perSymbol: { [sym]: { naverPopularity, spike, persist, lastAsvi, debug: [...] } } }
 */
export async function buildNaverTrends(symbols, opts = {}) {
  const NAVER_ID = process.env.NAVER_CLIENT_ID || "";
  const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || "";
  if (SKIP_NAVER || !NAVER_ID || !NAVER_SECRET) {
    return { perSymbol: {} };
  }
  // Load best-guess names (filled earlier by buildNewsFeatures)
  const knownNames = readJsonSafe(path.join(process.cwd(), 'src/news/symbolNames.json')) || {};
  const symbolToName = { ...(opts.symbolToName || {}), ...knownNames };

  // Collect raw weighted counts via name-only queries
  const rows = [];
  for (const sym of symbols) {
    const nm = symbolToName[sym] || sym;
    // newsFromNaver(name-only)
    const nv = await newsFromNaver(nm, NAVER_ID, NAVER_SECRET, { sym });
    rows.push({ sym, name: nm, nv: nv || {} });
  }
  const sumW = rows.reduce((s, r) => s + Number(r.nv?.weightedCount || 0), 0) || 1;

  const perSymbol = {};
  for (const { sym, name, nv } of rows) {
    const w = Number(nv?.weightedCount || 0);
    const pop = w / sumW; // fraction-style popularity (matches tiny decimals in your sample)
    const spikeVal = Number(nv?.naverSpike || 0);
    const asvi = Number(nv?.naverAsvi || 0);
    const spikeBool = spikeVal > Number(process.env.NAVER_SPIKE_BOOL_THRESH || 0.25);
    const persistBool = (asvi > 0) && spikeBool;
    perSymbol[sym] = {
      naverPopularity: +pop.toFixed(8),
      spike: spikeBool,
      persist: persistBool,
      lastAsvi: asvi,
      debug: [{
        groupName: name,
        pop,
        spike: spikeVal,
        persist: persistBool ? 1 : 0,
        lastAsvi: asvi
      }]
    };
  }
  return { perSymbol };
}

/**
 * Main: buildNewsFeatures(symbols, { symbolToName })
 * Returns shape: { [symbol]: { count, sentiment, blogMentions, polygonTrend, nasdaqClose } }
 * `nasdaqClose` now reflects Polygon's previous close price when available.
 */
export async function buildNewsFeatures(symbols, opts={}){
  const HARD = Number(process.env.HARD_DEADLINE_MS || 0);
  const DEADLINE = HARD ? Date.now() + HARD : 0;
  const FINNHUB = process.env.FINNHUB_API_KEY || '';
  const NEWSAPI = process.env.NEWSAPI_KEY || '';
  const SERPAPI = process.env.SERP_API_KEY || '';
  const NAVER_ID = process.env.NAVER_CLIENT_ID || '';
  const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || '';
  const GNEWS = process.env.GNEWS_API || '';
  const preferNaver = process.env.PREFER_NAVER === '1' || (!!NAVER_ID && !!NAVER_SECRET);

  // Optional: one-time light probe to decide whether to try Finnhub at all
  async function softProbeFinnhub(key){
    if (!key) return false;
    try {
      // very small response; confirms token works
      const url = `https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${key}`;
      const j = await safeGetJson(url, defaultUA);
      return Array.isArray(j);
    } catch { return false; }
  }
  FINNHUB_OK = await softProbeFinnhub(FINNHUB);

  const nameFile = 'symbolNames.json';
  const cachedNames = (()=>{ try{return JSON.parse(fs.readFileSync(nameFile,'utf8'));}catch{return{}} })();
  const symbolToName = { ...(cachedNames), ...(opts.symbolToName||{}) };
  const keywordsMap = opts.keywords || {};
  const articleCollector = (opts.collectArticles && typeof opts.collectArticles === 'object') ? opts.collectArticles : null;

  const baseMap = {};
  const uniq = [];
  for (const s of symbols){
    const b = baseSymbol(s);
    if (!baseMap[b]){ baseMap[b]=s; uniq.push(s); }
  }

  await Promise.all(uniq.map(async (s)=>{
    if (isKR(s) && !symbolToName[s]) {
      try {
        const nm = await getCompanyNameByYahooSymbol(s);
        if (nm){ symbolToName[s]=nm; cachedNames[s]=nm; }
      } catch {}
    }
  }));
  try { fs.writeFileSync(nameFile, JSON.stringify(cachedNames)); } catch {}

  const queries = buildQueries(uniq, { symbolToName });
  const baseOut = {};

  if (DEEPS_API_KEY) console.log('[deepsearch] enabled (7d window)');

  await mapLimit(uniq, NEWS_CONCURRENCY, async (sym)=>{
    if (DEADLINE && Date.now() > DEADLINE) return; // stop cleanly
    const q = queries[sym];
    const name = symbolToName[sym] || sym;
    let feat = { count: 0, sentiment: 0, blogMentions: 0 };
    const addDS = (arr) => (DEEPS_API_KEY ? ['deepsearch', ...arr] : arr);
    const baseProviders = preferNaver
      ? (isKR(sym)
          ? addDS(['naver','gnews','serpapi','kotra','newsapi','newsdata','gdelt','polygon'])      // no finnhub for KR
          : addDS(['naver','gnews','serpapi','newsapi','newsdata','gdelt','finnhub','polygon']))
      : (isKR(sym)
          ? addDS(['gnews','naver','serpapi','kotra','newsapi','newsdata','gdelt','polygon'])      // no finnhub for KR
          : addDS(['gnews','polygon','serpapi','newsapi','newsdata','gdelt','finnhub','kotra','naver']));
    const providers = process.env.SKIP_GDELT === '1'
      ? baseProviders.filter(p => p !== 'gdelt')
      : baseProviders;

    let lastErr = null;
    const ordered = providers.slice().sort((a,b)=>{
      const sa=provScore[a]||{}, sb=provScore[b]||{};
      const ra=(sa.ok||0)-(sa.fail||0), rb=(sb.ok||0)-(sb.fail||0);
      return rb - ra;
    });
    for (const p of ordered) {
      if (DEADLINE && Date.now() > DEADLINE) break;
      try {
        let v = null;
        if (p === 'deepsearch') v = await guardedCall('deepsearch', () => newsFromDeepSearch(sym, name));
        else if (p === 'gnews') v = await guardedCall('gnews', () => with429Retry(() => newsFromGNews(sym, q, GNEWS), 2, 600));
        else if (p === 'polygon') v = await guardedCall('polygon', () => with429Retry(() => newsFromPolygon(sym), 2, 600));
        else if (p === 'finnhub') v = await guardedCall('finnhub', () => newsFromFinnhub(sym, FINNHUB));
        else if (p === 'newsdata') v = await guardedCall('newsdata', () => newsFromNewsData(sym, name));
        else if (p === 'serpapi') v = await guardedCall('serpapi', () => newsFromSerpApi(sym, name, SERPAPI));
        else if (p === 'newsapi') v = await guardedCall('newsapi', () => newsFromNewsAPI(sym, name, NEWSAPI));
        else if (p === 'kotra') v = await guardedCall('kotra', () => newsFromKotra(sym, q));
        else if (p === 'gdelt') v = await guardedCall('gdelt', () => newsFromGdelt(sym, q));
        else if (p === 'naver') v = await guardedCall('naver', () => newsFromNaver(name, NAVER_ID, NAVER_SECRET, { sym, keywords: keywordsMap[sym] }));
        if (v) v._source = p;
        if (v) {
          markProvider(p, true);
          if (!SKIP_NAVER && v.count > 0 && (v.blogMentions||0) === 0) {
            try {
              const blogs = await guardedCall('naver', () => blogFromNaver(name, NAVER_ID, NAVER_SECRET));
              v.blogMentions = Math.max(v.blogMentions || 0, blogs || 0);
            } catch {}
          }
          const trend = await fetchPolygonTrend(sym);
          if (trend != null) v.polygonTrend = trend;
          const close = await fetchPrevClose(sym);
          if (close != null) v.nasdaqClose = close;

          // If we got any useful DS metrics, keep them even when count==0
          const useful = (v.count > 0) || (v.ds_news7>0) || (v.ds_burst>0) || (v.ds_slope7 && v.ds_slope7 !== 0);
          if (useful) { feat = v; break; }
        }
      } catch (e) {
        lastErr = e;
        console.warn(`[news] ${sym} provider ${p} failed: ${e.message}`);
        markProvider(p, false);
      }
    }
    if (feat.count === 0) {
      if (lastErr) console.warn(`[news] providers exhausted for ${sym}. Last: ${lastErr.message}`);
      const trend = await fetchPolygonTrend(sym); if (trend != null) feat.polygonTrend = trend;
      const close = await fetchPrevClose(sym);    if (close != null) feat.nasdaqClose = close;
      // keep DS fields non-null
      feat.ds_news7 = feat.ds_news7 ?? 0;
      feat.ds_slope7 = feat.ds_slope7 ?? 0;
      feat.ds_burst = feat.ds_burst ?? 0;
      feat.ds_trend = feat.ds_trend ?? 0;
      if (feat.count === 0 && (feat.polygonTrend != null || feat.nasdaqClose != null)) feat.count = 1;
    }

    feat.naverCount = Number(feat.naverCount || ((feat._source === 'naver') ? feat.count : 0));
    feat.naverCountKO = Number(feat.naverCountKO || 0);
    feat.naverCountEN = Number(feat.naverCountEN || 0);
    feat.otherCount = Number(feat.otherCount || ((feat._source && feat._source !== 'naver') ? feat.count : 0));
    feat.weightedCount = Number(feat.weightedCount || 0);
    feat.posHits = Number(feat.posHits || 0);
    feat.negHits = Number(feat.negHits || 0);

    if (preferNaver && (!feat.naverCount || feat.naverCount === 0)) {
      try {
        const nv = await newsFromNaver(name, NAVER_ID, NAVER_SECRET, { sym, keywords: keywordsMap[sym] });
        if (nv) {
          feat.naverCount = nv.naverCount;
          feat.naverCountKO = nv.naverCountKO;
          feat.naverCountEN = nv.naverCountEN;
          feat.weightedCount = nv.weightedCount ?? feat.weightedCount;
          feat.posHits = nv.posHits ?? feat.posHits;
          feat.negHits = nv.negHits ?? feat.negHits;
          feat.sentiment = nv.sentiment ?? feat.sentiment;
          feat.newsScore = nv.newsScore ?? feat.newsScore;
          feat.naverAsvi = nv.naverAsvi;
          feat.naverSpike = nv.naverSpike;
        }
      } catch {}
    }

    if (typeof feat.newsScore !== 'number') {
      const blogs = Number(feat.blogMentions || 0);
      const weightedNaver = NAVER_KO_WEIGHT * feat.naverCountKO + NAVER_EN_WEIGHT * feat.naverCountEN;
      const weightedCount =
        weightedNaver +
        OTHER_NEWS_WEIGHT * feat.otherCount +
        NAVER_BLOG_WEIGHT * blogs;
      feat.weightedCount = weightedCount;
      feat.newsScore = to01(Math.tanh(weightedCount / 10));
    }

    let items = [];
    try {
      items = await getTickerArticles(sym);
    } catch {}
    if (items.length) {
      if (articleCollector) {
        const mapped = items.map(it => ({
          title: it?.title || '',
          summary: it?.summary || it?.description || '',
          body: it?.body || it?.summary || it?.description || '',
          url: it?.url || it?.link || '',
          tickers: Array.isArray(it?.tickers) ? it.tickers : [],
          keywords: Array.isArray(it?.keywords) ? it.keywords : [],
          tags: Array.isArray(it?.tags) ? it.tags : []
        })).filter(entry => entry.title || entry.summary || entry.body);
        if (mapped.length) {
          articleCollector[sym] = mapped;
        }
      }
      const now = Date.now();
      const decayed = items.reduce((sum,it)=>{
        const ts = new Date(it.publishedAt || it.pubDate || it.date || 0).getTime();
        if (!ts) return sum;
        const ageH = (now - ts) / 3600000;
        const decay = Math.pow(0.5, ageH / 24);
        return sum + decay * hostWeight(it.url || '');
      },0);
      feat.weightedCount = Math.max(decayed, feat.weightedCount || 0);
    }
    if (Number.isFinite(feat.marketCap) && feat.weightedCount) {
      const scale = Math.sqrt(1e11 / Math.max(feat.marketCap, 1e6));
      feat.weightedCount *= scale;
    }
    try {
      const aliases = SYMBOL_ALIASES[sym] || [];
      const rep = computeReputation({ items, company: { ticker: sym, names: [symbolToName[sym], ...aliases].filter(Boolean) } });
      let repScore = Number.isFinite(rep?.reputationScore) ? rep.reputationScore : 0.5; // default to neutral
      const nTotal = items.length || 1;
      const nNaver = items.reduce((n, it) => n + (it?.source === 'Naver' ? 1 : 0), 0);
      const naverShare = nNaver / nTotal;
      repScore = repScore * (1 + (NAVER_REP_BONUS - 1) * naverShare);
      feat.reputationScore = repScore;
      feat.topKeywords = Array.isArray(rep?.topKeywords) ? rep.topKeywords : [];
      feat.reputationHitIds = Array.isArray(rep?.hitIds) ? rep.hitIds : [];
    } catch {}

    baseOut[baseSymbol(sym)] = feat;
  });

  const out = {};
  for (const s of symbols){
    const f = baseOut[baseSymbol(s)] || {};
    out[s] = {
      count:             Number(f.count || 0),
      weightedCount:     Number(f.weightedCount || 0),
      posHits:           Number(f.posHits || 0),
      negHits:           Number(f.negHits || 0),
      sentiment:         Number(f.sentiment || 0),
      blogMentions:      Number(f.blogMentions || 0),
      naverCount:        Number(f.naverCount || 0),
      naverCountKO:      Number(f.naverCountKO || 0),
      naverCountEN:      Number(f.naverCountEN || 0),
      otherCount:        Number(f.otherCount || 0),
      newsScore:         Number(f.newsScore || 0),
      naverAsvi:         Number(f.naverAsvi || 0),
      naverSpike:        Number(f.naverSpike || 0),
      polygonTrend:      Number.isFinite(f.polygonTrend) ? f.polygonTrend : 0,
      nasdaqClose:       Number.isFinite(f.nasdaqClose) ? f.nasdaqClose : 0,
      reputationScore:   Number.isFinite(f.reputationScore) ? f.reputationScore : 0,
      topKeywords:       Array.isArray(f.topKeywords) ? f.topKeywords : [],
      reputationHitIds:  Array.isArray(f.reputationHitIds) ? f.reputationHitIds : [],
      // NEW DS fields, always numeric
      ds_news7:          Number(f.ds_news7 || 0),
      ds_slope7:         Number(f.ds_slope7 || 0),
      ds_burst:         Number(f.ds_burst || 0),
      ds_trend:         Number(f.ds_trend || 0),
    };
  }
  return out;
}

// ------------------------- Naver DataLab helpers (company NAME, not ticker) -------------------------
function chunk(arr, n){ const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; }

async function fetchNaverDataLabBatch(groups, { startDate, endDate, timeUnit='date', NAVER_ID, NAVER_SECRET }){
  const url = 'https://openapi.naver.com/v1/datalab/search';
  const body = {
    startDate, endDate, timeUnit,
    keywordGroups: groups.map(g => ({ groupName: g.groupName, keywords: [g.keyword] })),
    device: '', ages: [], gender: ''
  };
  const res = await withRetry(
    () => fetch(url, {
      method:'POST',
      headers: {
        'Content-Type':'application/json',
        'X-Naver-Client-Id': NAVER_ID,
        'X-Naver-Client-Secret': NAVER_SECRET
      },
      body: JSON.stringify(body)
    }).then(async r=>{
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }),
    { max: 1, baseMs: 600 }
  );
  const out = {};
  for (const r of res?.results || []) {
    const name = r?.title || r?.keyword || r?.groupName;
    const series = Array.isArray(r?.data) ? r.data.map(d => ({ date: d.period, ratio: Number(d.ratio)||0 })) : [];
    const vals = series.map(d=>d.ratio);
    if (!vals.length) { out[name] = null; continue; }
    const last7 = vals.slice(-7);
    const prev28 = vals.slice(Math.max(0, vals.length-35), Math.max(0, vals.length-7));
    const meanPrev = prev28.length ? prev28.reduce((a,b)=>a+b,0)/prev28.length : vals.reduce((a,b)=>a+b,0)/vals.length;
    const meanLast = last7.reduce((a,b)=>a+b,0)/Math.max(1,last7.length);
    const asvi = meanPrev > 0 ? (meanLast/meanPrev) - 1 : (meanLast>0 ? 1 : 0);
    const spike = prev28.length ? (meanLast > (meanPrev*1.5)) : (meanLast > 70);
    const persist = prev28.length ? (last7.filter(v=>v>=meanPrev).length >= 5) : (meanLast > 60);
    out[name] = {
      popularity01: meanLast/100,
      lastAsvi: asvi*100,
      spike, persist
    };
  }
  return out;
}

async function fetchNaverTrendsByNames(symbols, symbolToName){
  const NAVER_ID = process.env.NAVER_CLIENT_ID || '';
  const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || '';
  if (!NAVER_ID || !NAVER_SECRET || SKIP_NAVER) return {};
  const today = new Date();
  const end = today.toISOString().slice(0,10);
  const start = new Date(today.getTime() - 365*24*3600*1000).toISOString().slice(0,10);
  const groups = symbols.map(sym => {
    const nm = symbolToName[sym] || sym;
    return { sym, name: nm, groupName: nm, keyword: nm };
  });
  const perSymbol = {};
  for (const batch of chunk(groups, 5)) {
    const m = await fetchNaverDataLabBatch(batch, { startDate:start, endDate:end, timeUnit:'date', NAVER_ID, NAVER_SECRET })
      .catch(()=> ({}));
    for (const g of batch){
      const r = m[g.name];
      if (!r) continue;
      perSymbol[g.sym] = {
        naverPopularity: Number.isFinite(r.popularity01) ? r.popularity01 : 0,
        spike: !!r.spike,
        persist: !!r.persist,
        lastAsvi: Number.isFinite(r.lastAsvi) ? r.lastAsvi : 0,
        debug: [{ groupName: g.name, pop: r.popularity01 || 0, spike: r.spike?1:0, persist: r.persist?1:0, lastAsvi: r.lastAsvi || 0 }]
      };
    }
  }
  return perSymbol;
}

/**
 * Convenience: build features and write both artifacts:
 *  - data/news-features.json  (from buildNewsFeatures)
 *  - data/naver-trends.json   (DataLab, using COMPANY NAMES)
 */
export async function writeNewsArtifacts(symbols, opts={}){
  const feats = await buildNewsFeatures(symbols, opts);
  try { await fsp.mkdir('data', { recursive: true }); } catch {}
  // Persist news-features.json
  try {
    await fsp.writeFile(NEWS_FEATURES_FILE, JSON.stringify(feats, null, 2));
  } catch(e){ console.warn('[news] failed to write news-features.json:', e.message); }

  // Naver DataLab trends by company name
  try {
    const symbolToName = (opts.symbolToName || {});
    // Best effort: if not provided, try cached symbolNames.json
    if (!Object.keys(symbolToName).length) {
      try {
        Object.assign(symbolToName, JSON.parse(fs.readFileSync('symbolNames.json','utf8')));
      } catch {}
    }
    const trends = await fetchNaverTrendsByNames(symbols, symbolToName);
    if (Object.keys(trends).length) {
      const payload = { perSymbol: trends, lastUpdated: new Date().toISOString() };
      await fsp.writeFile(NAVER_TRENDS_FILE, JSON.stringify(payload, null, 2));
      // Merge headline naver fields into features (so one file has everything if you want)
      for (const [sym, t] of Object.entries(trends)) {
        const f = feats[sym] ||= {};
        if (!Number.isFinite(f.naverPopularity)) f.naverPopularity = Number(t.naverPopularity || 0);
        if (!Number.isFinite(f.naverAsvi))       f.naverAsvi       = Number(t.lastAsvi || 0);
        if (!Number.isFinite(f.naverSpike))      f.naverSpike      = Number(t.spike ? 1 : 0);
      }
      // Re-write combined features with trends merged in
      await fsp.writeFile(NEWS_FEATURES_FILE, JSON.stringify(feats, null, 2));
    }
  } catch(e){
    console.warn('[naver-trends] failed to write naver-trends.json:', e.message);
  }
  return feats;
}

// --- helpers for KOTRA key handling (replace old chooseEncodedServiceKey) ---
function chooseApiKey(name){
  const dec = (process.env[`${name}_DECODED`] || '').trim();
  const enc = (process.env[name] || '').trim();
  if (dec) return dec;
  try { return decodeURIComponent(enc); } catch { return enc; }
}
function chooseServiceKeyForDataGoKr(){
  // Precedence: plain first, then encoded
  const candidates = [
    (process.env.DATA_API_KEY || '').trim(),        // preferred (decoded)
    (process.env.DATA_API_KEY_DECODED || '').trim(),// legacy plain
    (process.env.DATA_API_KEY_ENCODED || '').trim(),// legacy encoded
    (process.env.DATA_ENCODE_KEY || '').trim(),     // your encoded key
  ].filter(Boolean);
  if (!candidates.length) return '';
  const first = candidates[0];
  if (/%[0-9A-Fa-f]{2}/.test(first)) { // looks encoded
    try { return decodeURIComponent(first); } catch { /* fallthrough */ }
  }
  return first;
}
export function chooseKrxApiKey(){ return chooseApiKey('KRX_API_KEY'); }

function normalizeNewsApiArticle(it) {
  const title = it?.title || "";
  const url = it?.url || "";
  if (!title || !url) return null;
  const date = it?.publishedAt ? new Date(it.publishedAt).toISOString() : new Date().toISOString();
  const source = it?.source?.name || "NewsAPI";
  const summary = stripHtml(it?.description || it?.content || "");
  return {
    title,
    url,
    source,
    publishedAt: date,
    summary,
    body: summary,
    tickers: toUniqueStrings(it?.tickers || it?.symbols),
    keywords: toUniqueStrings(it?.keywords),
    tags: toUniqueStrings(it?.tags)
  };
}

function normalizeNaverArticle(it) {
  const title = (it?.title || "").replace(/<[^>]*>/g, "").trim();
  const url = (it?.originallink || it?.link || "").trim();
  if (!title || !url) return null;
  const date = it?.pubDate ? new Date(it.pubDate).toISOString() : new Date().toISOString();
  const summary = stripHtml(it?.description || "");
  return {
    title,
    url,
    source: "Naver",
    publishedAt: date,
    summary,
    body: summary,
    tickers: toUniqueStrings(it?.tickers),
    keywords: toUniqueStrings(it?.keywords),
    tags: toUniqueStrings(it?.tags)
  };
}

function normalizeGNewsArticle(it) {
  const title = it?.title || "";
  const url = it?.url || "";
  if (!title || !url) return null;
  const date = it?.publishedAt ? new Date(it.publishedAt).toISOString() : new Date().toISOString();
  const source = it?.source?.name || "GNews";
  const summary = stripHtml(it?.description || it?.content || "");
  return {
    title,
    url,
    source,
    publishedAt: date,
    summary,
    body: summary,
    tickers: toUniqueStrings(it?.tickers || it?.symbols),
    keywords: toUniqueStrings(it?.keywords),
    tags: toUniqueStrings(it?.tags)
  };
}

function normalizeDeepSearchArticle(it){
  const title = (it?.title_ko || it?.title || '').trim();
  const url = (it?.url || it?.link || '').trim();
  if (!title || !url) return null;
  const date = it?.published_at ? new Date(it.published_at).toISOString() : new Date().toISOString();
  const source = it?.publisher || it?.source || 'DeepSearch';
  const summary = stripHtml(it?.summary || it?.description || it?.body || "");
  const body = stripHtml(it?.body || it?.summary || "");
  return {
    title,
    url,
    source,
    publishedAt: date,
    summary,
    body,
    tickers: toUniqueStrings(it?.tickers || it?.symbols),
    keywords: toUniqueStrings(it?.keywords),
    tags: toUniqueStrings(it?.tags)
  };
}

function normalizeNewsDataArticle(it) {
  const title = it?.title || "";
  const url = it?.link || "";
  if (!title || !url) return null;

  const tz = (it?.pubDateTZ || '').toUpperCase();
  const iso = it?.pubDate
    ? (tz === 'UTC' ? it.pubDate.replace(' ', 'T') + 'Z' : new Date(it.pubDate).toISOString())
    : new Date().toISOString();

  const source = it?.source_name || it?.source_id || "NewsData";
  const summary = stripHtml(it?.description || it?.content || it?.full_description || "");
  const body = stripHtml(it?.content || it?.full_content || it?.full_description || "");
  return {
    title,
    url,
    source,
    publishedAt: iso,
    summary,
    body,
    tickers: toUniqueStrings(it?.tickers || it?.symbols),
    keywords: toUniqueStrings(it?.keywords),
    tags: toUniqueStrings(it?.categories || it?.tags)
  };
}

function normalizePolygonArticle(it) {
  const title = it?.title || '';
  const url = it?.article_url || it?.url || '';
  if (!title || !url) return null;

  const publishedAt = it?.published_utc
    ? new Date(it.published_utc).toISOString()
    : new Date().toISOString();
  const source = it?.publisher?.name || it?.publisher || 'Polygon';
  const summary = stripHtml(it?.description || it?.excerpt || '');
  const body = stripHtml(it?.article || it?.description || '');

  return {
    title,
    url,
    source,
    publishedAt,
    summary,
    body,
    tickers: toUniqueStrings(it?.tickers),
    keywords: toUniqueStrings(it?.keywords),
    tags: toUniqueStrings(it?.tags)
  };
}

async function getTickerArticlesFromDS(sym, name){
  if (!DEEPS_API_KEY) return [];
  const dsSym = dsSymbolFor(sym);
  const isKr = /\.K[QS]$/i.test(sym);
  const base = isKr ? 'https://api-v2.deepsearch.com/v1/articles'
                    : 'https://api-v2.deepsearch.com/v1/global-articles';
  const qp = new URLSearchParams();
  qp.set('page_size','20'); qp.set('order','published_at');
  qp.set('date_from', daysAgo(7)); qp.set('date_to', daysAgo(0));
  if (dsSym) qp.set('symbols', dsSym); else qp.set('company_name', name);
  const headers = { ...defaultUA, Authorization: `Bearer ${DEEPS_API_KEY}` };
  try {
    const j = await safeGetJson(`${base}?${qp.toString()}`, headers);
    const arr = Array.isArray(j?.data) ? j.data : [];
    return dedupeArticles(arr.map(normalizeDeepSearchArticle).filter(Boolean));
  } catch { return []; }
}

function dedupeArticles(items) {
  const seenUrl = new Set();
  const seenTitle = new Set();
  return items.filter(it => {
    const u = (it?.url || "").trim();
    const t = normalizeTitle(it?.title || "");
    if ((!u && !t) || seenUrl.has(u) || (t && seenTitle.has(t))) return false;
    if (u) seenUrl.add(u);
    if (t) seenTitle.add(t);
    return true;
  });
}

async function getTickerArticlesPrimary(ticker) {
  const out = [];
  const NAVER_ID = process.env.NAVER_CLIENT_ID || "";
  const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || "";
  if (!SKIP_NAVER && NAVER_ID && NAVER_SECRET) {
    try {
      // Prefer COMPANY NAME for all search requests
      let display = '';
      try {
        const nm = (require('./symbolNames.json') || {})[ticker];
        if (nm) display = `"${nm}"`;
      } catch {}
      if (!display) {
        const nm = await getCompanyNameByYahooSymbol(ticker).catch(()=>null);
        display = nm ? `"${nm}"` : `"${ticker.replace(/\.[A-Z]+$/,'')}"`;
      }
      const q = /\.K[QS]$/.test(ticker) ? `${display} 증권 OR 투자` : display;

      const headers = { 'X-Naver-Client-Id': NAVER_ID, 'X-Naver-Client-Secret': NAVER_SECRET };
      const page1 = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(q)}&display=20&start=1&sort=date`;
      const page2 = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(q)}&display=20&start=21&sort=date`;

      const [r1, r2] = await Promise.all([
        fetch(page1, { headers }).then(r=>r.json()).catch(()=>({items:[]})),
        fetch(page2, { headers }).then(r=>r.json()).catch(()=>({items:[]})),
      ]);

      const arr = []
        .concat(Array.isArray(r1?.items) ? r1.items : [])
        .concat(Array.isArray(r2?.items) ? r2.items : []);
      out.push(...arr.map(normalizeNaverArticle).filter(Boolean));
    } catch {}
  }
  const dsItems = await getTickerArticlesFromDS(ticker, ticker.replace(/\.[A-Z]+$/,''));
  out.push(...dsItems);
  const NEWSAPI = process.env.NEWSAPI_KEY || "";
  if (NEWSAPI) {
    try {
      // Prefer company NAME if we have it
      let qname = ticker;
      try {
        const nm = (require('./symbolNames.json') || {})[ticker];
        if (nm) qname = nm;
      } catch {}
      const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(qname)}&language=en&pageSize=20&sortBy=publishedAt&apiKey=${NEWSAPI}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'stock-recs/1.0 (+github-actions)' } });
      const j = await res.json();
      const arr = Array.isArray(j?.articles) ? j.articles : [];
      out.push(...arr.map(normalizeNewsApiArticle).filter(Boolean));
    } catch {}
  }
  const GNEWS = process.env.GNEWS_API || "";
  if (GNEWS) {
    try {
      const lang = /\.K[QS]$/.test(ticker) ? 'ko' : 'en';
      let q = ticker.replace(/\.[A-Z]+$/,'');
      // Prefer display name to improve recall
      try {
        const nm = (require('./symbolNames.json') || {})[ticker];
        if (nm) q = nm;
      } catch {}
      // Note: we use generic q (not qInTitle) since GNews supports fuzzy queries better with names
      const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=${lang}&max=20&apikey=${GNEWS}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'stock-recs/1.0 (+github-actions)' } });
      const j = await res.json();
      const arr = Array.isArray(j?.articles) ? j.articles : [];
      out.push(...arr.map(normalizeGNewsArticle).filter(Boolean));
    } catch {}
  }
  const NEWSDATA = process.env.NEWSDATA_API_KEY || "";
  if (NEWSDATA) {
    try {
      const langList = isKR(ticker) ? ['ko','en'] : ['en','ko'];
      const from = daysAgo(Number(process.env.NEWSDATA_DATE_WINDOW_DAYS || 7));
      const to   = daysAgo(0);
      let qTitle = ticker.replace(/\.[A-Z]+$/,'');
      try {
        const nm = (require('./symbolNames.json') || {})[ticker];
        if (nm) qTitle = nm;
      } catch {}

      const ndItems = await newsdataArchiveFetch({
        qInTitle: qTitle,
        languages: langList,
        fromDate: from,
        toDate: to,
        size: Number(process.env.NEWSDATA_SIZE || 25),
        pageLimit: Number(process.env.NEWSDATA_PAGE_LIMIT || 2)
      });

      out.push(...ndItems);
    } catch {}
  }
  if (polygonRest && isUS(ticker)) {
    try {
      const res = await polygonRest.reference.tickerNews({
        ticker,
        order: 'desc',
        limit: Number(process.env.POLYGON_NEWS_LIMIT || 20)
      });
      const arr = Array.isArray(res?.results) ? res.results : [];
      out.push(...arr.map(normalizePolygonArticle).filter(Boolean));
    } catch (err) {
      console.warn(`[polygon-news] ${ticker} fetch failed:`, err?.message || err);
    }
  }
  return dedupeArticles(out);
}

export async function getTickerArticles(ticker) {
  const primary = await getTickerArticlesPrimary(ticker).catch(e => {
    console.error(`[news] primary failed for ${ticker}:`, e.message);
    return [];
  });
  if (primary?.length) return primary;

  if (process.env.USE_KOTRA_BACKUP === "1") {
    try {
      const name = await getCompanyNameByYahooSymbol(ticker);
      if (name) {
        // Pull ~100–150 recent items then keyword-match by company name
        const kotra = await fetchKotraRecent({ pages: 3, pageSize: 50, keyword: name });
        if (kotra.length) {
          console.log(`[kotra-backup] ${ticker}: ${kotra.length} items`);
          return kotra.slice(0, 20);
        }
      }
    } catch (e) {
      console.error(`[kotra-backup] ${ticker} backup failed:`, e.message);
    }
  }

  return primary ?? [];
}

// ---------- CLI helper: build a broad symbol set & name maps from index files / pools ----------
async function _cliCollectUniverse() {
  // Prefer index constituents (stable) and enrich with pools.json names if present.
  let idx = {};
  try { idx = JSON.parse(await fsp.readFile('src/maps.indexes.json', 'utf8')); } catch {}
  const rows = ['sp500','nasdaq100','kospi200','kosdaq100']
    .flatMap(k => Array.isArray(idx?.[k]) ? idx[k] : []);
  const SYM_TO_NAME = {};
  const NAME_TO_SYM = {};
  for (const r of rows) {
    const sym = String(r.symbol || r.ticker || '').toUpperCase().replace('/', '.').replace('-', '.');
    const nm  = String(r.name || '').trim() || sym;
    if (sym) { SYM_TO_NAME[sym] = nm; NAME_TO_SYM[nm.toUpperCase()] = sym; }
  }
  // Try to map pools.json names back to symbols using index names (best-effort).
  let pools = null;
  try { pools = JSON.parse(await fsp.readFile('pools.json','utf8')); } catch {}
  const poolNames = pools
    ? Object.values(pools).flatMap(b => [...(b.safe||[]), ...(b.aggressive||[])])
    : [];
  const poolSyms = poolNames
    .map(n => NAME_TO_SYM[String(n).toUpperCase()])
    .filter(Boolean);
  const indexSyms = Object.keys(SYM_TO_NAME);
  const symbols = Array.from(new Set([...poolSyms, ...indexSyms]));
  // Build a light "universe" of names by market for Naver baskets (index-based)
  const uni = {
    'S&P 500':     (idx?.sp500||[]).map(r => r.name || r.symbol),
    'NASDAQ 100':  (idx?.nasdaq100||[]).map(r => r.name || r.symbol),
    KOSPI:         (idx?.kospi200||[]).map(r => r.name || r.symbol),
    KOSDAQ:        (idx?.kosdaq100||[]).map(r => r.name || r.symbol),
  };
  // Reverse mapper for baskets
  const nameToSymbol = (name) => NAME_TO_SYM[String(name||'').toUpperCase()] || null;
  return { symbols, symbolToName: SYM_TO_NAME, universe: uni, nameToSymbol };
}

// ---------- CLI: build & write news-features.json + naver-trends.json ----------
export async function buildNewsCachesCli() {
  const NEWS_FEATURES_FILE = process.env.NEWS_FEATURES_FILE || 'data/news-features.json';
  const NAVER_TRENDS_FILE  = process.env.NAVER_TRENDS_FILE  || 'data/naver-trends.json';
  const NEWS_KEYWORDS_FILE = process.env.NEWS_KEYWORDS_FILE || 'newsKeywords.json';
  await fsp.mkdir(path.dirname(NEWS_FEATURES_FILE), { recursive: true });
  await fsp.mkdir(path.dirname(NAVER_TRENDS_FILE),  { recursive: true });

  const { symbols, symbolToName, universe, nameToSymbol } = await _cliCollectUniverse();

  // 1) News features (counts/sentiment/reputation etc.)
  const collectedArticles = {};
  const features = await buildNewsFeatures(symbols, { symbolToName, collectArticles: collectedArticles });
  await fsp.writeFile(NEWS_FEATURES_FILE, JSON.stringify(features, null, 2));

  // 2) Naver trends (use company names in keyword builder & baskets)
  const KEYWORDS = await buildKeywordDict({
    symbols,
    seeds: {}, // your builder adds good defaults
    symbolToName,
    newsFeatures: features,
    addKoreanForUSTickers: process.env.ADD_KO_FOR_US !== '0',
  });
  const baskets = buildBasketsFromUniverse({ universe, nameToSymbol, keywordDict: KEYWORDS });
  const now = new Date(), end = now.toISOString().slice(0,10);
  const start = new Date(now.getTime() - 365*24*3600*1000).toISOString().slice(0,10);
  const { perSymbol, raw } = await fetchNaverTrends({
    baskets, startDate: start, endDate: end, timeUnit: 'date',
    cacheTtlMs: Number(process.env.NAVER_TRENDS_CACHE_TTL_MS || 6*60*60*1000),
    budgetLeftMs: Number(process.env.GLOBAL_BUDGET_MS || 90000)
  });
  await fsp.writeFile(NAVER_TRENDS_FILE, JSON.stringify({ perSymbol, rawMeta: Object.keys(raw) }, null, 2));
  console.log(`[news-caches] wrote ${NEWS_FEATURES_FILE} and ${NAVER_TRENDS_FILE}`);

  // 3) Ticker keyword snapshot merged into newsKeywords.json
  const tagSnapshotForKeywords = readJsonSafe(TAG_OUTPUT_FILE) || null;
  const keywordPayload = buildNewsKeywords(collectedArticles, { tagSnapshot: tagSnapshotForKeywords });
  const tickerCount = Object.keys(keywordPayload.tickers).length;
  if (tickerCount) {
    await fsp.mkdir(path.dirname(NEWS_KEYWORDS_FILE), { recursive: true }).catch(()=>{});
    const existing = readJsonSafe(NEWS_KEYWORDS_FILE) || {};
    const fresh = {
      generatedAt: existing?.generatedAt || keywordPayload.generated_at,
      timezone: existing?.timezone || 'Asia/Seoul',
      updatedAt: existing?.updatedAt || {},
      keywords: Array.isArray(existing?.keywords) ? existing.keywords : [],
      markets: Array.isArray(existing?.markets) ? existing.markets : KEYWORD_MARKET_QUERIES.map(m => m.market),
      tickerKeywords: keywordPayload.tickers,
      tickerKeywordsMeta: {
        generatedAt: keywordPayload.generated_at,
        version: keywordPayload.version,
      }
    };
    await fsp.writeFile(NEWS_KEYWORDS_FILE, JSON.stringify(fresh, null, 2));
    console.log(`[news-caches] updated ${NEWS_KEYWORDS_FILE} with ${tickerCount} ticker keyword sets`);
  } else {
    console.log('[news-caches] no ticker keywords derived from collected articles');
  }
}

// Node entrypoint: `node src/news/fetchByTicker.js --build-caches`
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--build-caches')) {
    buildNewsCachesCli().catch(e => { console.error(e); process.exit(1); });
  } else if (process.argv.includes('--build-keywords')) {
    writeSignificantPhrasesJson().catch(e => { console.error(e); process.exit(1); });
  } else if (process.argv.includes('--significant-phrases')) {
    writeSignificantPhrasesJson().catch(e => { console.error(e); process.exit(1); });
  }
}

