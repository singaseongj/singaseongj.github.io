import fs from 'fs';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const OUTPUT = 'data/market_news.json';
const SIX_HOURS = 6 * 60 * 60 * 1000;

const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;

const FEEDS = {
  en: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC&region=US&lang=en-US',
  kr1: 'https://news.google.com/rss/search?q=%ED%95%9C%EA%B5%AD%20%EC%A6%9D%EC%8B%9C&hl=ko&gl=KR&ceid=KR:ko',
  kr2: 'https://news.google.com/rss/search?q=%EC%BD%94%EC%8A%A4%ED%94%BC&hl=ko&gl=KR&ceid=KR:ko',
  kr3: 'https://news.google.com/rss/search?q=%EC%A3%BC%EC%8B%9D%20%EC%8B%9C%ED%99%A9&hl=ko&gl=KR&ceid=KR:ko'
};

function parseItems(xml) {
  const items = [];
  const regex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = regex.exec(xml)) && items.length < 5) {
    const item = m[1];
    const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
    if (titleMatch && linkMatch) {
      const title = titleMatch[1].trim();
      const link = linkMatch[1].trim();
      items.push({ title, link });
    }
  }
  return items;
}

async function fetchFeed(url) {
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxyUrl, { agent });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { contents } = await res.json();
  return parseItems(contents);
}

async function main() {
  let current;
  try {
    current = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
  } catch {}
  if (current && current.lastUpdated) {
    const age = Date.now() - new Date(current.lastUpdated).getTime();
    if (age < SIX_HOURS && current.items?.length) {
      console.log('News is up to date.');
      return;
    }
  }

  const all = [];
  try {
    const items = await fetchFeed(FEEDS.en);
    all.push(...items.slice(0, 5));
  } catch (e) {
    console.error('Failed EN feed', e.message);
  }
  for (const key of ['kr1', 'kr2', 'kr3']) {
    try {
      const items = await fetchFeed(FEEDS[key]);
      all.push(...items.slice(0, 1));
    } catch (e) {
      console.error('Failed', key, e.message);
    }
  }

  if (all.length === 0 && current) {
    console.log('Using existing news due to failures.');
    return;
  }

  const out = { lastUpdated: new Date().toISOString(), items: all.slice(0, 8) };
  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
  console.log('Updated', OUTPUT);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
