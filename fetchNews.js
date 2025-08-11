import fs from 'fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT_FILE = path.join(__dirname, 'data', 'market_news.json');
const HANGUL = /[\u3131-\u318E\uAC00-\uD7A3]/;
const KR_DOMAIN = /(yonhap|yna|hankyung|mk\.co\.kr|chosun|joongang|edaily|sedaily|newsis|hankyoreh|donga|fnnews|biz\.chosun|etnews|kmib|koreatimes|joongangdaily|koreaherald)\./i;
const isKR = it => HANGUL.test(it.title) || KR_DOMAIN.test(it.link);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0'
};

const US_FEEDS = [
  'https://www.marketwatch.com/rss/topstories',
  'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',
  'https://www.investing.com/rss/news_25.rss'
];

const KR_FEEDS = [
  'https://news.google.com/rss/search?q=%EC%A6%9D%EC%8B%9C&hl=ko&gl=KR&ceid=KR:ko',
  'https://news.google.com/rss/search?q=%EC%BD%94%EC%8A%A4%ED%94%BC&hl=ko&gl=KR&ceid=KR:ko'
];

function toKSTISOString(d = new Date()) {
  const kst = new Date(d.getTime() + (9 * 60 - d.getTimezoneOffset()) * 60000);
  const p = n => String(n).padStart(2, '0');
  return `${kst.getFullYear()}-${p(kst.getMonth() + 1)}-${p(kst.getDate())}` +
    `T${p(kst.getHours())}:${p(kst.getMinutes())}:${p(kst.getSeconds())}+09:00`;
}

const parser = new XMLParser({ ignoreAttributes: false });
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

async function gather() {
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

  const seen = new Set();
  const deduped = [];
  for (const it of all) {
    const key = it.link || it.title;
    const key2 = it.title;
    if (seen.has(key) || seen.has(key2)) continue;
    seen.add(key);
    seen.add(key2);
    deduped.push(it);
  }

  const us = [];
  const kr = [];
  for (const it of deduped) {
    (isKR(it) ? kr : us).push(it);
  }

  return [...us.slice(0, 5), ...kr.slice(0, 3)];
}

async function main() {
  const items = await gather();
  if (!items.length) throw new Error('No news items after filtering');
  const out = { lastUpdated: toKSTISOString(), items };
  await fs.writeFile(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`Wrote ${items.length} items to ${OUT_FILE}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
