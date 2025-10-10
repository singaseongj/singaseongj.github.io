#!/usr/bin/env node
'use strict';

/**
 * stockKeywords.js — Naver search driven keyword scorer
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

const OUTPUT_PATH = path.resolve(__dirname, '../data/tags.json');
const FINANCE_KEYWORDS_PATH = path.resolve(__dirname, '../data/finance_keywords.json');

const SAMPLE_SIZE = 30;
const NAVER_NEWS_ENDPOINT = 'https://openapi.naver.com/v1/search/news.json';
const REQUEST_DELAY_MS = 180;
const WINDOW_LABEL = '12_hours';

if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
  console.error('❌ NAVER_CLIENT_ID and NAVER_CLIENT_SECRET environment variables are required.');
  console.error('   Please obtain credentials from https://developers.naver.com and set them before running this script.');
  process.exit(1);
}

function loadFinanceKeywords() {
  const raw = JSON.parse(fs.readFileSync(FINANCE_KEYWORDS_PATH, 'utf8'));
  const keywords = Array.isArray(raw.finance_keywords) ? raw.finance_keywords : [];
  const cleaned = keywords
    .map((kw) => String(kw).trim())
    .filter((kw) => kw.length >= 2 && /[가-힣]/.test(kw));
  return Array.from(new Set(cleaned));
}

function shuffleSample(list, size) {
  const pool = [...list];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(size, pool.length));
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

function buildSearchLinks(keyword) {
  const query = encodeURIComponent(keyword);
  return {
    news: `https://search.naver.com/search.naver?where=news&query=${query}`,
    blog: `https://search.naver.com/search.naver?where=blog&query=${query}`,
    cafe: `https://search.naver.com/search.naver?where=post&query=${query}`,
  };
}

async function evaluateKeyword(keyword) {
  const url = `${NAVER_NEWS_ENDPOINT}?query=${encodeURIComponent(keyword)}&display=20&sort=date`;
  const headers = {
    'X-Naver-Client-Id': NAVER_CLIENT_ID,
    'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
  };

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`NAVER API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const total = Number(data.total) || 0;
  const items = Array.isArray(data.items) ? data.items : [];
  const now = Date.now();
  const recencyScore = items.reduce((sum, item) => {
    const timestamp = Date.parse(item.pubDate || '');
    if (!Number.isFinite(timestamp)) return sum;
    const hoursAgo = (now - timestamp) / (1000 * 60 * 60);
    const weight = Math.max(0, 72 - hoursAgo);
    return sum + weight;
  }, 0);
  const displayCount = Number(data.display) || items.length;
  const score = Math.round(total * 0.6 + items.length * 10 + recencyScore);

  const topHeadlines = items.slice(0, 3).map((item) => ({
    title: cleanSnippet(item.title),
    summary: cleanSnippet(item.description),
    link: item.originallink || item.link || '',
    pubDate: item.pubDate || null,
  }));

  console.log(
    `🔎 ${keyword.padEnd(16, ' ')} → score ${String(score).padStart(5)} (total ${String(total).padStart(4)}, recent ${String(items.length).padStart(2)})`
  );

  return {
    term: keyword,
    term_ko: keyword,
    significance_score: score,
    mentions: total,
    evaluation: {
      source: 'naver_search_news',
      query: keyword,
      total_results: total,
      returned_results: items.length,
      display_count: displayCount,
      recency_weight: Number(recencyScore.toFixed(2)),
      last_build_date: data.lastBuildDate || null,
    },
    search: buildSearchLinks(keyword),
    top_headlines: topHeadlines,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildTags() {
  console.log('🚀 Generating data/tags.json from finance_keywords.json');
  const keywords = loadFinanceKeywords();
  if (!keywords.length) {
    throw new Error('finance_keywords.json does not contain any usable Korean keywords.');
  }

  const sampled = shuffleSample(keywords, SAMPLE_SIZE);
  console.log(`🎯 Selected ${sampled.length} random finance keywords for evaluation.`);

  const evaluated = [];
  for (const keyword of sampled) {
    try {
      const result = await evaluateKeyword(keyword);
      evaluated.push(result);
    } catch (err) {
      console.warn(`⚠️  Failed to evaluate "${keyword}": ${err.message}`);
      evaluated.push({
        term: keyword,
        term_ko: keyword,
        significance_score: 0,
        mentions: 0,
        evaluation: {
          source: 'naver_search_news',
          query: keyword,
          error: err.message,
        },
        search: buildSearchLinks(keyword),
        top_headlines: [],
      });
    }
    await delay(REQUEST_DELAY_MS + Math.floor(Math.random() * 120));
  }

  evaluated.sort((a, b) => b.significance_score - a.significance_score);

  const now = new Date();
  const result = {
    date: now.toISOString().split('T')[0],
    window: WINDOW_LABEL,
    total_phrases: evaluated.length,
    discovered_keywords: evaluated,
    metadata: {
      collection_method: 'naver_search_random_sample',
      sample_size: SAMPLE_SIZE,
      generated_at: now.toISOString(),
      keyword_limit: SAMPLE_SIZE,
      lookback_hours: 12,
      keyword_source: path.relative(process.cwd(), FINANCE_KEYWORDS_PATH),
    },
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(`✅ Saved ${evaluated.length} keywords to ${OUTPUT_PATH}`);
}

if (require.main === module) {
  buildTags().catch((err) => {
    console.error('❌ Generation failed:', err);
    process.exitCode = 1;
  });
}

module.exports = { buildTags };
