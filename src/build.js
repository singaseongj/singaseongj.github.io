// src/build.js
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { load } from 'cheerio';

// 1) 템플릿 로드
const tpl = fs.readFileSync(path.resolve('src/template.html'), 'utf-8');

// 날짜 포맷 유틸
function formatDateKR(date) {
  return date.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
}

// 전 영업일 계산
function getLastBusinessDay() {
  const today = new Date();
  let d = new Date(today);
  // KST 기준 16시 이전이면 전날 기준
  if (d.getHours() < 16) d.setDate(d.getDate() - 1);
  // 주말 제외
  while ([0,6].includes(d.getDay())) d.setDate(d.getDate() - 1);
  return d;
}

// 2) 데이터 가져오기 함수들
async function fetchMarketIndices() {
  const indices = [
    { name: 'KOSPI', url: 'https://finance.naver.com/sise/sise_index.naver?code=KOSPI' },
    { name: 'KOSDAQ', url: 'https://finance.naver.com/sise/sise_index.naver?code=KOSDAQ' },
    { name: 'S&P500', url: 'https://finance.yahoo.com/quote/%5EGSPC' },
    { name: 'NASDAQ', url: 'https://finance.yahoo.com/quote/%5EIXIC' }
  ];
  const rows = [];
  for (const idx of indices) {
    let price = 'N/A', change = 'N/A';
    try {
      const resp = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(idx.url)}`);
      const { contents } = await resp.json();
      const $ = load(contents);
      const em = $('em#now_value').first();
      const sp = $('span#rate').first();
      if (em.length && sp.length) {
        price = em.text().trim().replace(/,/g, '');
        change = sp.text().trim();
      } else {
        const m = contents.match(/"regularMarketPrice":\{"raw":([\d.]+)/);
        const p = contents.match(/"regularMarketPreviousClose":\{"raw":([\d.]+)/);
        if (m && p) {
          const cur = parseFloat(m[1]);
          const prev = parseFloat(p[1]);
          price = cur.toFixed(2);
          change = ((cur - prev)/prev * 100).toFixed(2) + '%';
        }
      }
    } catch {}
    rows.push(`<tr><td>${idx.name}</td><td>${price}</td><td class="${parseFloat(change) > 0 ? 'positive' : parseFloat(change) < 0 ? 'negative' : 'neutral'}">${change}</td></tr>`);
  }
  return `<table><thead><tr><th>지수</th><th>전일 종가</th><th>등락(%)</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

async function fetchPortfolioRecommendations() {
  // 간단 예시: 빈 데이터 대신 "No Data"
  // 실제 로직은 client 코드를 포팅하세요.
  return `<div class="no-data"><p>데이터를 불러올 수 없습니다.</p></div>`;
}

// 3) 빌드 함수
async function build() {
  const now = new Date();
  const lastBusiness = getLastBusinessDay();

  const [marketTable, portfolioHTML] = await Promise.all([
    fetchMarketIndices(),
    fetchPortfolioRecommendations()
  ]);

  let out = tpl
    .replace('{{CURRENT_DATE}}', formatDateKR(now))
    .replace('{{DATA_DATE}}', formatDateKR(lastBusiness))
    .replace('{{MARKET_TABLE}}', marketTable)
    .replace('{{PORTFOLIO_SECTIONS}}', portfolioHTML)
    .replace('{{BUILD_TIMESTAMP}}', now.toISOString().replace('T', ' ').split('.')[0]);

  fs.writeFileSync(path.resolve('stocks.html'), out, 'utf-8');
  console.log('✅ stocks.html 생성 완료');
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
