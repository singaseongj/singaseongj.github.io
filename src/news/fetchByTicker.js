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
import { KO_ALIASES } from '../trends/koAliases.js';

// --- Detect external keyword builder ---
const STOCK_KEYWORDS_PATH = path.resolve("stocks/stockKeywords.js");
const HAS_STOCK_KEYWORDS = fs.existsSync(STOCK_KEYWORDS_PATH);
if (HAS_STOCK_KEYWORDS) {
  console.log("🧠 Detected stockKeywords.js — disabling internal tag generation");
  process.env.SKIP_TAGS = "1";
}
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
const DEEPL_API_URL = (process.env.DEEPL_API_URL || '').trim();
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

const hasHangul = (str) => HANGUL_REGEX.test(String(str || ''));

function uniqueStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const raw of arr || []) {
    const value = String(raw || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function symbolVariants(sym) {
  const base = String(sym || '').trim().toUpperCase();
  if (!base) return [];
  const vars = new Set([base]);
  if (base.includes('.')) vars.add(base.replace(/\./g, '-'));
  if (base.includes('-')) vars.add(base.replace(/-/g, '.'));
  return [...vars];
}

const KO_ALIAS_LOOKUP = (() => {
  const map = new Map();
  if (KO_ALIASES && typeof KO_ALIASES === 'object') {
    for (const [key, value] of Object.entries(KO_ALIASES)) {
      if (!key) continue;
      const terms = Array.isArray(value) ? value.filter(Boolean) : [];
      if (!terms.length) continue;
      map.set(String(key).toUpperCase(), terms.map(String));
    }
  }
  return map;
})();

function koAliasesForSymbol(sym) {
  const variants = symbolVariants(sym);
  const terms = new Set();
  for (const key of variants) {
    const arr = KO_ALIAS_LOOKUP.get(key);
    if (!Array.isArray(arr)) continue;
    for (const term of arr) {
      const t = String(term || '').trim();
      if (!t) continue;
      terms.add(t);
    }
  }
  return [...terms];
}

function keywordsForSymbol(keywordsMap, sym) {
  if (!keywordsMap) return [];
  if (Array.isArray(keywordsMap?.[sym])) return keywordsMap[sym];
  if (keywordsMap instanceof Map) {
    const arr = keywordsMap.get(sym);
    return Array.isArray(arr) ? arr : [];
  }
  return [];
}

function gatherKoTerms(sym, name, keywordsMap) {
  const terms = [];
  const display = String(name || '').trim();
  if (display && hasHangul(display)) terms.push(display);
  terms.push(...koAliasesForSymbol(sym));
  const keywords = keywordsForSymbol(keywordsMap, sym);
  for (const kw of keywords) {
    if (hasHangul(kw)) terms.push(kw);
  }
  return uniqueStrings(terms);
}

function gatherEnTerms(sym, name, keywordsMap) {
  const terms = [];
  const display = String(name || '').trim();
  if (display && !hasHangul(display)) terms.push(display);
  const baseTicker = String(sym || '').replace(/\.[A-Z]+$/i, '').trim();
  if (baseTicker) terms.push(baseTicker);
  const aliases = koAliasesForSymbol(sym);
  for (const alias of aliases) {
    if (!hasHangul(alias)) terms.push(alias);
  }
  const keywords = keywordsForSymbol(keywordsMap, sym);
  for (const kw of keywords) {
    if (!hasHangul(kw)) terms.push(kw);
  }
  return uniqueStrings(terms);
}

function buildNaverSearchQueries(sym, name, keywordsMap) {
  const koTerms = gatherKoTerms(sym, name, keywordsMap);
  const enTerms = gatherEnTerms(sym, name, keywordsMap);
  const queries = [];

  const buildClause = (terms) => terms.map(t => `"${t}"`).join(' OR ');

  if (koTerms.length) {
    const chunks = chunk(koTerms.slice(0, Number(process.env.NAVER_MAX_KO_TERMS || 9)), 3);
    for (const terms of chunks) {
      const clause = buildClause(terms);
      if (!clause) continue;
      queries.push({ query: `${clause} 증권 OR 투자`, kind: 'ko' });
    }
  }

  if (!queries.length) {
    const chunks = chunk(enTerms.slice(0, Number(process.env.NAVER_MAX_EN_TERMS || 6)), 3);
    for (const terms of chunks) {
      const clause = buildClause(terms);
      if (!clause) continue;
      queries.push({ query: `${clause} 주가 OR 투자`, kind: 'en' });
      break; // avoid spamming too many english queries
    }
  }

  if (!queries.length) {
    const fallback = String(name || sym || '').trim();
    if (fallback) {
      const kind = hasHangul(fallback) ? 'ko' : 'en';
      queries.push({ query: `"${fallback}" 주가`, kind });
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const entry of queries) {
    if (!entry?.query) continue;
    const key = `${entry.query}::${entry.kind || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped.slice(0, Number(process.env.NAVER_MAX_QUERY_GROUPS || 4));
}

function buildNaverBlogQuery(sym, name, keywordsMap) {
  const koTerms = gatherKoTerms(sym, name, keywordsMap);
  if (koTerms.length) {
    const clause = koTerms.slice(0, 3).map(t => `"${t}"`).join(' OR ');
    if (clause) return `${clause} 블로그`;
  }
  const enTerms = gatherEnTerms(sym, name, keywordsMap);
  if (enTerms.length) {
    const clause = enTerms.slice(0, 3).map(t => `"${t}"`).join(' OR ');
    if (clause) return `${clause} blog`;
  }
  const fallback = String(name || sym || '').trim();
  if (!fallback) return '';
  return `"${fallback}" 블로그`;
}

function loadIndexSymbols(...relPaths) {
  const out = new Set();
  for (const rel of relPaths) {
    if (!rel) continue;
    try {
      const full = path.join(process.cwd(), rel);
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (!item) continue;
          if (typeof item === 'string') {
            out.add(String(item).trim().toUpperCase());
          } else if (typeof item.symbol === 'string') {
            out.add(String(item.symbol).trim().toUpperCase());
          }
        }
      }
    } catch {}
  }
  return out;
}

const SP500_MEMBERS = loadIndexSymbols(
  'data/indexes/sp500.json',
  'data/indexes/sp500.offline.json',
  'data/index-constituents/sp500.json'
);

const NASDAQ100_MEMBERS = loadIndexSymbols(
  'data/indexes/nasdaq100.json',
  'data/indexes/nasdaq100.offline.json',
  'data/index-constituents/nasdaq100.json'
);

function isUSIndexHeavyweight(sym) {
  const variants = symbolVariants(sym);
  for (const key of variants) {
    if (SP500_MEMBERS.has(key) || NASDAQ100_MEMBERS.has(key)) return true;
  }
  return false;
}

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

// --- Ticker-level keyword builder (domain-aware tokenizer) ---
const require = createRequire(import.meta.url);

const {
  KEYWORD_MARKET_QUERIES,
  TAG_OUTPUT_FILE,
  KEYWORD_OUTPUT_FILE,
  collectKoreanFirstKeywords,
  writeKoreanFirstTagsJson,
  collectSignificantPhrases,
  writeSignificantPhrasesJson,
  buildMarketKeywordSnapshot,
  formatTagDisplay,
  translateTagToKo,
  setTranslationCache,
  hasHangulText,
  normalizeKoKeywordTerm,
  buildTermKoLookup,
  lookupKoFromMap,
  primeTranslationCacheFromSnapshot,
  naverSearch,
} = require('./marketKeywords.cjs');

export {
  collectKoreanFirstKeywords,
  writeKoreanFirstTagsJson,
  collectSignificantPhrases,
  writeSignificantPhrasesJson,
  buildMarketKeywordSnapshot,
};

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
  '주식',
  'stocks'
]);

const CANONICAL_MAP = new Map([
  ['주식'],
  ['stocks'],
]);

const BLACKLIST = new Set(['최소','최대','속보','종합','오늘','어제','내일','최근','전문','사진','영상']);
const ECON_SUFFIXES = ['산업','업','시장','수출','수입','무역수지','금리','환율','물가','지수','채권','유가','원자재',
  '실적','가이던스','수주','발주','배터리','전지','조선','해양','반도체','자동차','전장','디스플레이','철강','정유','석유화학','방산','바이오','제약','로봇','원자력','SMR','LNG',
  'market','markets','exports','imports','earnings','revenue','revenues','guidance','sales','demand','supply','inflation','rates','rate','yields','yield','forex','currency','currencies','sector','sectors','industry','industries','index','indices','production','manufacturing','chip','chips','battery','batteries','semiconductor','semiconductors','automotive'];

const MACRO_WHITELIST = new Set([
  '주식'
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

export async function buildNewsKeywords(articlesByTicker, { tagSnapshot = null } = {}) {
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
      const enriched = await Promise.all(combined.slice(0, 12).map(async item => {
        const rawTerm = String(item.term || '').trim();
        if (!rawTerm) return item;
        const hasHangul = containsHangul(rawTerm);
        const formattedTerm = hasHangul ? rawTerm : formatTagDisplay(rawTerm);
        const storedKo = lookupKoFromMap(koLookup, formattedTerm);
        if (storedKo) {
          setTranslationCache(formattedTerm, storedKo);
        }
        const koTerm = storedKo || (hasHangul ? rawTerm : await translateTagToKo(formattedTerm));
        if (koTerm && containsHangul(koTerm)) {
          setTranslationCache(formattedTerm, koTerm);
        }
        return {
          ...item,
          term: formattedTerm,
          term_ko: koTerm
        };
      }));
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

async function newsFromGoogleNewsRss(sym, name){
  const isKr = isKR(sym);
  const hl = isKr ? 'ko' : 'en-US';
  const gl = isKr ? 'KR' : 'US';
  const ceid = isKr ? 'KR:ko' : 'US:en';
  const q = `"${name}" OR ${sym}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  const txt = await withRetry(() => cachedText(url, (u)=>safeGetText(u, defaultUA), 20*60*1000, true), { max:1, baseMs:600 });
  const items = (txt.match(/<item>/g) || []).length;
  return { count: Math.min(items, 30), sentiment: 0, blogMentions: 0 };
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
  const keywordMap = (() => {
    if (opts.keywordMap && typeof opts.keywordMap === 'object') return opts.keywordMap;
    if (Array.isArray(opts.keywords)) return { [sym]: opts.keywords };
    return {};
  })();

  const queries = buildNaverSearchQueries(sym, name, keywordMap);

  const seen = new Set();
  let posHits = 0, negHits = 0, totalW = 0, rawCount = 0;
  let koHits = 0, enHits = 0;
  for (const entry of queries) {
    const q = entry.query;
    const kind = entry.kind || (hasHangul(q) ? 'ko' : 'en');
    if (process.env.DEBUG_NAVER === '1') {
      console.log(`[naver-debug] Querying Naver with: "${q}"`);
    }

    let res;
    try {
      res = await naverSearch({ query: q, NAVER_ID, NAVER_SECRET });
      if (process.env.DEBUG_NAVER === '1') {
        console.log(`[naver-debug] Naver response for "${q}": ${res?.items?.length || 0} items`);
      }
    } catch (err) {
      console.error(`[naver-debug] Failed Naver call for "${q}":`, err.message);
      continue;
    }
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
      if (kind === 'ko') koHits++;
      else enHits++;
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
    naverCountKO: koHits,
    naverCountEN: enHits,
    blogMentions: 0,
  };
}

async function blogFromNaver(sym, name, NAVER_ID, NAVER_SECRET, keywordsMap){
  if (SKIP_NAVER) return 0;
  if (!NAVER_ID || !NAVER_SECRET) return 0;
  const q = buildNaverBlogQuery(sym, name, keywordsMap);
  if (!q) return 0;
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
  const keywordMap = (opts.keywordMap && typeof opts.keywordMap === 'object')
    ? opts.keywordMap
    : (opts.keywords && typeof opts.keywords === 'object' ? opts.keywords : {});

  // Collect raw weighted counts via name-only queries
  const rows = [];
  for (const sym of symbols) {
    const nm = symbolToName[sym] || sym;
    // newsFromNaver(name-only)
    const nv = await newsFromNaver(nm, NAVER_ID, NAVER_SECRET, { sym, keywordMap });
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
  const providerDisabled = new Set();

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
          ? addDS(['naver','gnews','serpapi','google_rss','kotra','newsapi','newsdata','gdelt','polygon'])      // no finnhub for KR
          : addDS(['naver','gnews','serpapi','google_rss','newsapi','newsdata','gdelt','finnhub','polygon']))
      : (isKR(sym)
          ? addDS(['gnews','naver','serpapi','google_rss','kotra','newsapi','newsdata','gdelt','polygon'])      // no finnhub for KR
          : addDS(['gnews','polygon','serpapi','google_rss','newsapi','newsdata','gdelt','finnhub','kotra','naver']));
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
      if (providerDisabled.has(p)) continue;
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
        else if (p === 'google_rss') v = await guardedCall('google_rss', () => newsFromGoogleNewsRss(sym, name));
        else if (p === 'kotra') v = await guardedCall('kotra', () => newsFromKotra(sym, q));
        else if (p === 'gdelt') v = await guardedCall('gdelt', () => newsFromGdelt(sym, q));
        else if (p === 'naver') v = await guardedCall('naver', () => newsFromNaver(name, NAVER_ID, NAVER_SECRET, { sym, keywords: keywordsMap[sym] }));
        if (v) v._source = p;
        if (v) {
          markProvider(p, true);
          if (!SKIP_NAVER && v.count > 0 && (v.blogMentions||0) === 0) {
            try {
              const blogs = await guardedCall('naver', () => blogFromNaver(sym, name, NAVER_ID, NAVER_SECRET, keywordsMap));
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
        if (/HTTP\s(401|403|429)\b/i.test(String(e?.message || '')) || /timeout|aborted/i.test(String(e?.message || ''))) {
          providerDisabled.add(p);
        }
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

    if (isUSIndexHeavyweight(sym)) {
      const currentWeight = Number(feat.weightedCount || 0);
      if (!Number.isFinite(currentWeight) || currentWeight <= 0) {
        let fallbackWeight = 0;
        if (Number.isFinite(feat.polygonTrend) && feat.polygonTrend !== 0) {
          fallbackWeight += Math.abs(feat.polygonTrend) * 100;
        }
        if (Number.isFinite(feat.naverCount) && feat.naverCount > 0) {
          fallbackWeight += feat.naverCount;
        }
        if (fallbackWeight <= 0) fallbackWeight = 1;
        feat.weightedCount = fallbackWeight;
      }
      if (!Number.isFinite(feat.newsScore) || feat.newsScore <= 0) {
        feat.newsScore = to01(Math.tanh((feat.weightedCount || 0) / 10));
      }
      if (!Number.isFinite(feat.count) || feat.count <= 0) {
        feat.count = Math.max(1, Math.round(feat.weightedCount || 1));
      }
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

async function fetchNaverTrendsByNames(symbols, symbolToName, keywordMap = {}){
  const NAVER_ID = process.env.NAVER_CLIENT_ID || '';
  const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || '';
  if (!NAVER_ID || !NAVER_SECRET || SKIP_NAVER) return {};
  const today = new Date();
  const end = today.toISOString().slice(0,10);
  const start = new Date(today.getTime() - 365*24*3600*1000).toISOString().slice(0,10);
  const km = (keywordMap && typeof keywordMap === 'object') ? keywordMap : {};
  const groups = symbols.map(sym => {
    const nm = symbolToName[sym] || sym;
    const koTerms = gatherKoTerms(sym, nm, km);
    const primary = koTerms[0] || nm;
    return { sym, name: nm, groupName: primary, keyword: primary };
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
    const trends = await fetchNaverTrendsByNames(symbols, symbolToName, opts.keywords || {});
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
  const naverResult = await fetchNaverTrends({
    baskets, startDate: start, endDate: end, timeUnit: 'date',
    cacheTtlMs: Number(process.env.NAVER_TRENDS_CACHE_TTL_MS || 6*60*60*1000),
    budgetLeftMs: Number(process.env.GLOBAL_BUDGET_MS || 90000)
  }).catch(err => {
    console.warn('[news-caches] Naver trends fetch failed:', err?.message || err);
    return null;
  });
  if (!naverResult) {
    console.warn('[news-caches] skipping Naver trends write due to missing results');
  }
  const perSymbol = naverResult?.perSymbol || {};
  const rawMeta = naverResult?.raw ? Object.keys(naverResult.raw) : [];
  await fsp.writeFile(NAVER_TRENDS_FILE, JSON.stringify({ perSymbol, rawMeta }, null, 2));
  console.log(`[news-caches] wrote ${NEWS_FEATURES_FILE} and ${NAVER_TRENDS_FILE}`);

  // 3) Ticker keyword snapshot merged into tags.json
  let tagSnapshotForKeywords = null;

  try {
    const latestTags = await writeSignificantPhrasesJson({ outputPath: TAG_OUTPUT_FILE });
    if (latestTags) {
      tagSnapshotForKeywords = latestTags;
    }
  } catch (err) {
    console.warn('[news-caches] failed to build significant phrase tags:', err?.message || err);
  }

  if (!tagSnapshotForKeywords) {
    tagSnapshotForKeywords = readJsonSafe(TAG_OUTPUT_FILE) || null;
  }
  const keywordPayload = await buildNewsKeywords(collectedArticles, { tagSnapshot: tagSnapshotForKeywords });
  const tickerCount = Object.keys(keywordPayload.tickers).length;
  if (tickerCount) {
    const existing = tagSnapshotForKeywords || readJsonSafe(TAG_OUTPUT_FILE) || {};
    const merged = {
      ...existing,
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
    ensureDirFor(TAG_OUTPUT_FILE);
    await fsp.writeFile(TAG_OUTPUT_FILE, JSON.stringify(merged, null, 2));
    console.log(`[news-caches] updated ${TAG_OUTPUT_FILE} with ${tickerCount} ticker keyword sets`);
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
