'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const fetch = (...args) =>
  import('node-fetch').then(({ default: nodeFetch }) => nodeFetch(...args));

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

const FINANCE_KEYWORDS_PATH = path.resolve(__dirname, '../data/finance_keywords.json');
const NEWS_CORPUS_OUTPUT = path.resolve(__dirname, '../data/articles/news_corpus.json');

// Load keywords from finance dictionary
function loadFinanceKeywords(limit = 40) {
  const dict = JSON.parse(fs.readFileSync(FINANCE_KEYWORDS_PATH, 'utf8'));
  const all = dict.finance_keywords || [];
  const shuffled = all.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, limit);
}

// Helper for scraping plain text from HTML
async function scrapeText(url, selector) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const $ = cheerio.load(html);
    const texts = [];
    $(selector).each((_, el) => {
      const t = $(el).text().trim();
      if (t.length > 10) texts.push(t);
    });
    return texts;
  } catch (err) {
    console.warn(`❌ scrape failed for ${url}:`, err.message);
    return [];
  }
}

// ---- NAVER API fetch ----
async function fetchNaverNews(keywords) {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
    console.warn('⚠️ Missing Naver API credentials — skipping API call.');
    return [];
  }

  const headers = {
    'X-Naver-Client-Id': NAVER_CLIENT_ID,
    'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
  };
  const texts = [];

  for (const kw of keywords) {
    const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(kw)}&display=10&sort=date`;
    try {
      const res = await fetch(url, { headers });
      const data = await res.json();
      (data.items || []).forEach((it) => {
        const text = `${it.title || ''} ${it.description || ''}`
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text.length > 10) texts.push(text);
      });
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
    } catch (e) {
      console.warn(`⚠️ Naver failed for ${kw}:`, e.message);
    }
  }

  console.log(`✅ Collected ${texts.length} items from Naver API`);
  return texts;
}

// ---- Scrape fallback sites ----
async function fetchFromFallbackSites(keywords) {
  const all = [];
  for (const kw of keywords) {
    console.log(`🌐 Scraping for keyword: ${kw}`);
    const encoded = encodeURIComponent(kw);

    // Nate
    all.push(
      ...(await scrapeText(`https://m.news.nate.com/search?q=${encoded}`, '.mdu_subject, .mdu_text')),
    );

    // Daum
    all.push(
      ...(await scrapeText(`https://search.daum.net/search?w=news&q=${encoded}`, '.tit_item, .desc_f')),
    );

    // Zum
    all.push(
      ...(await scrapeText(`https://m.news.zum.com/search?query=${encoded}`, 'a.tit, .desc')),
    );

    // MK (Maeil Kyungje)
    all.push(
      ...(await scrapeText(`https://m.mk.co.kr/news/search?word=${encoded}`, '.tit, .desc')),
    );

    await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));
  }
  console.log(`✅ Collected ${all.length} items from fallback sites`);
  return all;
}

// ---- Combined workflow ----
async function buildNewsCorpus() {
  const keywords = loadFinanceKeywords();
  console.log(`🎯 Using ${keywords.length} keywords (e.g., ${keywords.slice(0, 5).join(', ')})`);

  const naverData = await fetchNaverNews(keywords);
  const fallbackData = await fetchFromFallbackSites(keywords);

  const combined = [...new Set([...naverData, ...fallbackData])];
  console.log(`📦 Final corpus size: ${combined.length}`);

  fs.writeFileSync(NEWS_CORPUS_OUTPUT, JSON.stringify(combined, null, 2), 'utf8');
  console.log('💾 Saved to data/articles/news_corpus.json');
  return combined;
}

if (require.main === module) {
  buildNewsCorpus();
}

module.exports = {
  buildNewsCorpus,
  loadFinanceKeywords,
  fetchNaverNews,
  fetchFromFallbackSites,
};
