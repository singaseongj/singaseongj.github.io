// src/build.js
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { load } from 'cheerio';

// 1) 템플릿 로드
const tpl = fs.readFileSync(path.resolve('src/template.html'), 'utf-8');

// 2) 데이터 가져오는 함수들 (client 코드 로직을 그대로 재사용 가능)
async function fetchMarketIndices() {
  // 예시: 네이버/야후 API 호출 → 배열 리턴
}

async function fetchPortfolioRecommendations() {
  // 예시: KRX/API 호출 → 포트폴리오 데이터 리턴
}

// 3) 템플릿에 데이터 주입
async function build() {
  const [indices, portfolios] = await Promise.all([
    fetchMarketIndices(),
    fetchPortfolioRecommendations()
  ]);

  let html = tpl
    .replace('{{MARKET_TABLE}}', generateMarketTable(indices))
    .replace('{{PORTFOLIO_SECTIONS}}', generatePortfolioHTML(portfolios));

  fs.writeFileSync('index.html', html);
  console.log('✅ index.html 생성 완료');
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});

// --- helper functions: generateMarketTable, generatePortfolioHTML 등 ---
