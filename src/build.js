// src/build.js
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { load } from 'cheerio';

// Load HTML template
const tpl = fs.readFileSync(path.resolve('src/template.html'), 'utf-8');

// Format date in Korean
function formatDateKR(date) {
  return date.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Calculate last business day (KST 기준)
function getLastBusinessDay() {
  const today = new Date();
  let d = new Date(today);
  // KST 16시 이전은 전날
  if (d.getHours() < 16) d.setDate(d.getDate() - 1);
  // 주말 제외
  while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() - 1);
  return d;
}

// Fetch market indices data
async function fetchMarketIndices() {
  const indices = [
    { name: 'KOSPI', url: 'https://finance.naver.com/sise/sise_index.naver?code=KOSPI' },
    { name: 'KOSDAQ', url: 'https://finance.naver.com/sise/sise_index.naver?code=KOSDAQ' },
    { name: 'S&P500', url: 'https://finance.yahoo.com/quote/%5EGSPC' },
    { name: 'NASDAQ', url: 'https://finance.yahoo.com/quote/%5EIXIC' }
  ];

  const rows = [];
  for (const idx of indices) {
    let price = 'N/A';
    let changePct = 'N/A';
    try {
      const resp = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(idx.url)}`);
      const { contents } = await resp.json();
      const $ = load(contents);
      const em = $('em#now_value').first();
      const sp = $('span#rate').first();
      if (em.length && sp.length) {
        price = em.text().trim().replace(/,/g, '');
        changePct = sp.text().trim();
      } else {
        const m = contents.match(/"regularMarketPrice":\{"raw":([\d.]+)/);
        const p = contents.match(/"regularMarketPreviousClose":\{"raw":([\d.]+)/);
        if (m && p) {
          const cur = parseFloat(m[1]);
          const prev = parseFloat(p[1]);
          price = cur.toFixed(2);
          changePct = ((cur - prev) / prev * 100).toFixed(2) + '%';
        }
      }
    } catch (e) {
      console.error(`Error fetching ${idx.name}:`, e);
    }
    const cls = parseFloat(changePct) > 0 ? 'positive' : parseFloat(changePct) < 0 ? 'negative' : 'neutral';
    rows.push(`<tr><td>${idx.name}</td><td>${price}</td><td class="${cls}">${changePct}</td></tr>`);
  }

  return `<table><thead><tr><th>지수</th><th>전일 종가</th><th>등락(%)</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

// Fetch portfolio recommendations (구현 예시)
async function fetchPortfolioRecommendations() {
  // TODO: 실제 로직 포팅
  return `<div class="no-data"><p>데이터를 불러올 수 없습니다.</p></div>`;
}

// Main build function\ async function build() {
  const now = new Date();
  const lastBusiness = getLastBusinessDay();

  const [marketTable, portfolioHTML] = await Promise.all([
    fetchMarketIndices(),
    fetchPortfolioRecommendations()
  ]);

  const result = tpl
    .replace('{{CURRENT_DATE}}', formatDateKR(now))
    .replace('{{DATA_DATE}}', formatDateKR(lastBusiness))
    .replace('{{MARKET_TABLE}}', marketTable)
    .replace('{{PORTFOLIO_SECTIONS}}', portfolioHTML)
    .replace('{{BUILD_TIMESTAMP}}', now.toISOString().replace('T', ' ').split('.')[0] + ' KST');

  fs.writeFileSync(path.resolve('stocks.html'), result, 'utf-8');
  console.log('✅ stocks.html 생성 완료');
}

// Run build
build().catch(err => {
  console.error(err);
  process.exit(1);
});
