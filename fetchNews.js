import fs from 'fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nowKSTISO } from './utils/time.js';
import { fetchKotraRecent } from './src/news/kotraOverseas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT_FILE = path.join(__dirname, 'data', 'market-news.json');
const HANGUL = /[\u3131-\u318E\uAC00-\uD7A3]/;
const KR_DOMAIN = /(yonhap|yna|hankyung|mk\.co\.kr|chosun|joongang|edaily|sedaily|newsis|hankyoreh|donga|fnnews|biz\.chosun|etnews|kmib|koreatimes|joongangdaily|koreaherald)\./i;
const isKR = it => HANGUL.test(it.title) || KR_DOMAIN.test(it.link);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0'
};

const NAVER_ENDPOINT = 'https://openapi.naver.com/v1/search/news.json';
const NAVER_US_QUERIES = ['NASDAQ', '"S&P 500"'];
const NAVER_KR_QUERIES = ['한국 금리', '한국 증시 전망'];

const US_FEEDS = [
  'https://www.marketwatch.com/rss/topstories',
  'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',
  'https://www.investing.com/rss/news_25.rss'
];

const KR_FEEDS = [
  'https://news.google.com/rss/search?q=%EC%A6%9D%EC%8B%9C&hl=ko&gl=KR&ceid=KR:ko',
  'https://news.google.com/rss/search?q=%EC%BD%94%EC%8A%A4%ED%94%BC&hl=ko&gl=KR&ceid=KR:ko'
];

const parser = new XMLParser({ ignoreAttributes: false });
const MIN_NEWS = Number(process.env.MIN_NEWS || 8);
const execFileP = promisify(execFile);

function extract(item) {
  const title = item.title?.['#text'] || item.title;
  let link = item.link;
  if (link && typeof link === 'object') {
    link = link['@_href'] || (Array.isArray(link) ? link[0]['@_href'] || link[0] : link);
  }
  if (!title || !link) return null;
  return { title: String(title).trim(), link: String(link).trim() };
}

async function fetchFeed(url) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const data = parser.parse(xml);
    let items = [];
    if (data.rss?.channel?.item) items = data.rss.channel.item;
    else if (data.feed?.entry) items = data.feed.entry;
    return (Array.isArray(items) ? items : [items]).map(extract).filter(Boolean);
  } catch (err) {
    console.warn('Fetch failed, fallback to curl for', url, err.message);
    try {
      const { stdout } = await execFileP('curl', ['-sL', '-H', `User-Agent: ${HEADERS['User-Agent']}`, url]);
      const data = parser.parse(stdout);
      let items = [];
      if (data.rss?.channel?.item) items = data.rss.channel.item;
      else if (data.feed?.entry) items = data.feed.entry;
      return (Array.isArray(items) ? items : [items]).map(extract).filter(Boolean);
    } catch (err2) {
      console.warn('curl failed', err2.message);
      return [];
    }
  }
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.link || it.title;
    const key2 = it.title;
    if (seen.has(key) || seen.has(key2)) continue;
    seen.add(key);
    seen.add(key2);
    out.push(it);
  }
  return out;
}

// Prefer a 6/6 split, but backfill from whichever side has extra.
function pickMixed(us, kr, total = 12, capPerSide = 6) {
  const first = [...us.slice(0, capPerSide), ...kr.slice(0, capPerSide)];
  if (first.length >= total) return first.slice(0, total);
  const rest = [...us.slice(capPerSide), ...kr.slice(capPerSide)];
  return [...first, ...rest.slice(0, total - first.length)];
}

async function naverSearch(query, headers, display = 20) {
  const url = `${NAVER_ENDPOINT}?query=${encodeURIComponent(query)}&display=${display}&sort=date`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Naver HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || []).map(it => {
    const title = it.title ? it.title.replace(/<[^>]*>/g, '').trim() : '';
    const link = (it.link || it.originallink || '').trim();
    return title && link ? { title, link } : null;
  }).filter(Boolean);
}

async function fetchNaverNews() {
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) throw new Error('NAVER client credentials missing');
  const headers = {
    'X-Naver-Client-Id': id,
    'X-Naver-Client-Secret': secret,
  };
  const usRaw = await Promise.all(NAVER_US_QUERIES.map(q => naverSearch(q, headers)));
  const krRaw = await Promise.all(NAVER_KR_QUERIES.map(q => naverSearch(q, headers)));
  const us = dedupe(usRaw.flat()).slice(0, 6);
  const kr = dedupe(krRaw.flat()).slice(0, 6);
  return [...us, ...kr].slice(0, 12);
}

async function gatherFeeds() {
  const all = [];
  for (const url of [...US_FEEDS, ...KR_FEEDS]) {
    try {
      const items = await fetchFeed(url);
      all.push(...items);
    } catch (err) {
      console.warn('Feed failed', url, err.message);
    }
  }
  if (!all.length) throw new Error('No items fetched');

  const deduped = dedupe(all);

  const us = [];
  const kr = [];
  for (const it of deduped) {
    (isKR(it) ? kr : us).push(it);
  }

  return pickMixed(us, kr, 12, 6);
}

async function gather() {
  if (process.env.SKIP_NAVER !== '1') {
    try {
      const naverItems = await fetchNaverNews();
      if (naverItems.length >= 8) return naverItems;
      console.warn('Naver returned insufficient items; falling back to feeds');
    } catch (e) {
      console.warn('Naver fetch failed', e.message);
    }
  } else {
    console.log('SKIP_NAVER=1: skipping Naver news');
  }
  return await gatherFeeds();
}

async function main() {
  let items = await gather();
  const NEED = process.env.USE_KOTRA_BACKUP === "1" && (!items?.length || items.length < 12);
  if (NEED) {
    try {
      const kotraRaw = await fetchKotraRecent({ pages: 2, pageSize: 50 });
      const kotra = kotraRaw.map(it => ({ title: it.title, link: it.url })).filter(it => it.link);
      items = dedupe([...(items || []), ...kotra]).slice(0, 120);
      console.log(`[kotra-backup] merged ${kotra.length} items`);
    } catch (e) {
      console.error('[kotra-backup] homepage backup failed:', e.message);
    }
  }
  const us = [];
  const kr = [];
  for (const it of items) {
    (isKR(it) ? kr : us).push(it);
  }
  items = pickMixed(us, kr, 12, 6);
  if (items.length < MIN_NEWS) {
    if (process.env.ALLOW_EMPTY_NEWS === '1') {
      const out = { lastUpdated: nowKSTISO(), items };
      await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2));
      console.warn(`Only ${items.length} items; ALLOW_EMPTY_NEWS=1 so not failing.`);
      return;
    }
    throw new Error(`No news items after filtering (got ${items.length}, need >= ${MIN_NEWS})`);
  }
  const out = { lastUpdated: nowKSTISO(), items };
  await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`Wrote ${items.length} items to ${OUT_FILE}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
