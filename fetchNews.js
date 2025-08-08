import fs from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { XMLParser } from 'fast-xml-parser';

const OUTPUT = 'data/market_news.json';
const SIX_HOURS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 12_000;
const RETRIES = 2;

const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;

const HEADERS = {
  // Many RSS endpoints reject default UA
  'User-Agent': 'market-news-bot/1.0 (+https://example.local)',
  'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8'
};

// US + KR feeds (KR via Google News search terms)
const FEEDS = {
  en: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC&region=US&lang=en-US',
  kr1: 'https://news.google.com/rss/search?q=%ED%95%9C%EA%B5%AD%20%EC%A6%9D%EC%8B%9C&hl=ko&gl=KR&ceid=KR:ko',
  kr2: 'https://news.google.com/rss/search?q=%EC%BD%94%EC%8A%A4%ED%94%BC&hl=ko&gl=KR&ceid=KR:ko',
  kr3: 'https://news.google.com/rss/search?q=%EC%A3%BC%EC%8B%9D%20%EC%8B%9C%ED%99%A9&hl=ko&gl=KR&ceid=KR:ko'
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // Handle CDATA safely
  cdataPropName: 'cdata',
  processEntities: true,
});

function toKSTISOString(d = new Date()) {
  // Force KST (+09:00) regardless of server TZ
  const kst = new Date(d.getTime() + (9 * 60 - d.getTimezoneOffset()) * 60_000);
  const pad = n => String(n).padStart(2, '0');
  const yyyy = kst.getFullYear();
  const mm = pad(kst.getMonth() + 1);
  const dd = pad(kst.getDate());
  const hh = pad(kst.getHours());
  const mi = pad(kst.getMinutes());
  const ss = pad(kst.getSeconds());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+09:00`;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function get(url) {
  let lastErr;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      const res = await fetchWithTimeout(url, { headers: HEADERS, agent });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      // brief backoff
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

function normalizeItems(rawXml, preferGoogleNewsLink = true) {
  const xml = parser.parse(rawXml);
  const channel = xml?.rss?.channel || xml?.feed; // RSS vs Atom
  if (!channel) return [];

  let items = channel.item || channel.entry || [];
  if (!Array.isArray(items)) items = [items];

  // Map to {title, link}
  return items.map(it => {
    // Google News sometimes puts original link under <link href=""> or in <link> with redirects.
    let title =
      it.title?.cdata || it.title?._ || it.title || '';
    if (typeof title === 'object') title = String(title?.cdata || '');

    // Prefer typical RSS <link>, else Atom <link href="...">
    let link = it.link;
    if (typeof link === 'object') {
      link = link.href || link._ || link.cdata || '';
    }
    if (Array.isArray(link)) {
      // choose first reasonable href
      const atom = link.find(l => typeof l === 'object' && l.href)?.href;
      link = atom || link[0];
    }
    link = String(link || '').replace(/&amp;/g, '&').trim();

    return { title: (title || '').trim(), link: (link || '').trim() };
  }).filter(x => x.title && x.link);
}

function dedup(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.link || it.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

async function fetchFeed(url) {
  const xml = await get(url);
  return normalizeItems(xml);
}

async function main() {
  // Load current for fallback + freshness check
  let current;
  try {
    current = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
  } catch {}

  if (current?.lastUpdated) {
    const age = Date.now() - new Date(current.lastUpdated).getTime();
    if (age < SIX_HOURS && current.items?.length) {
      console.log('News is up to date.');
      return;
    }
  }

  // Fetch in parallel
  const keys = ['en', 'kr1', 'kr2', 'kr3'];
  const results = await Promise.allSettled(keys.map(k => fetchFeed(FEEDS[k])));

  const enItems = results[0].status === 'fulfilled' ? results[0].value.slice(0, 5) : [];
  const krItems = results.slice(1).flatMap(r => (r.status === 'fulfilled' ? r.value.slice(0, 3) : []));

  // If KR is too long, trim; but ensure at least 3 KR headlines if available
  let combined = [...enItems, ...krItems];
  combined = dedup(combined);

  if (combined.length === 0 && current?.items?.length) {
    console.log('Using existing news due to failures.');
    return; // keep existing file untouched
  }

  // Final cap: 8 items, but try to keep at least 3 KR
  const krFiltered = combined.filter(x => x.link.includes('news.google.com') || /kr|hankyun|chosun|yonhap|koreatimes|mk\.co\.kr/i.test(x.link));
  const enFiltered = combined.filter(x => !krFiltered.includes(x));

  let finalItems = [];
  // Take up to 5 EN and 3 KR by default, but adapt if one side lacks items
  const KR_TARGET = 3;
  const EN_TARGET = 5;

  const takeKR = Math.min(KR_TARGET, krFiltered.length);
  const takeEN = Math.min(EN_TARGET, enFiltered.length);

  finalItems = [
    ...enFiltered.slice(0, EN_TARGET + Math.max(0, KR_TARGET - takeKR)), // give KR slack to EN if KR short
    ...krFiltered.slice(0, KR_TARGET + Math.max(0, EN_TARGET - takeEN)), // and vice versa
  ].slice(0, 8);

  const out = {
    lastUpdated: toKSTISOString(new Date()),
    items: finalItems
  };

  fs.mkdirSync(require('path').dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2), 'utf8');
  console.log('Updated', OUTPUT);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
