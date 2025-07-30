// src/build.js
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';

// Load HTML template
const tpl = fs.readFileSync(path.resolve('src/template.html'), 'utf-8');

// Format date in Korean
function formatDateKR(date) {
  return date.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Calculate last business day (KST 기준)
function getLastBusinessDay() {
  const now = new Date();
  let d = new Date(now);
  // KST 기준 16시 이전이면 전날
  if (now.getHours() < 16) {
    d.setDate(d.getDate() - 1);
  }
  // 주말 제외 (일요일=0, 토요일=6)
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d;
}

// Fetch market indices data
async function fetchMarketIndices() {
  const indices = [
    { name: 'KOSPI', url: 'https://finance.naver.com/sise/sise_index.naver?code=KOSPI' },
    { name: 'KOSDAQ', url: 'https://finance.naver.com/sise/sise_index.naver?code=KOSDAQ' },
    { name: 'S&P500', url: 'https://finance.yahoo.com/quote/%5EGSPC' },
    { name: 'NASDAQ', url: 'https://finance.yahoo.com/quote/%5EIXIC' },
  ];

  const rows = [];
  for (const idx of indices) {
    let price = 'N/A';
    let changePct = 'N/A';
    try {
      console.log(`Fetching data for ${idx.name}...`);
      const resp = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(idx.url)}`);
      const { contents } = await resp.json();
      
      // JSDOM 사용
      const dom = new JSDOM(contents);
      const document = dom.window.document;
      
      // 네이버 파이낸스 (KOSPI, KOSDAQ)
      const em = document.querySelector('em#now_value');
      const sp = document.querySelector('span#rate');
      
      if (em && sp) {
        price = em.textContent.trim().replace(/,/g, '');
        changePct = sp.textContent.trim();
        console.log(`${idx.name}: ${price} (${changePct})`);
      } else {
        // Yahoo Finance (S&P500, NASDAQ) - JSON 데이터에서 추출
        const marketPriceMatch = contents.match(/"regularMarketPrice":\{"raw":([\d.]+)/);
        const prevCloseMatch = contents.match(/"regularMarketPreviousClose":\{"raw":([\d.]+)/);
        
        if (marketPriceMatch && prevCloseMatch) {
          const current = parseFloat(marketPriceMatch[1]);
          const previous = parseFloat(prevCloseMatch[1]);
          price = current.toFixed(2);
          changePct = ((current - previous) / previous * 100).toFixed(2) + '%';
          console.log(`${idx.name}: ${price} (${changePct})`);
        } else {
          console.log(`${idx.name}: 데이터 파싱 실패`);
        }
      }
    } catch (err) {
      console.error(`Error fetching ${idx.name}:`, err.message);
    }

    const changeNum = parseFloat(changePct);
    const cls = changeNum > 0 ? 'positive' : changeNum < 0 ? 'negative' : 'neutral';
    rows.push(`<tr><td>${idx.name}</td><td>${price}</td><td class="${cls}">${changePct}</td></tr>`);
  }

  return `<table><thead><tr><th>지수</th><th>전일 종가</th><th>등락(%)</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

// Fetch portfolio recommendations (구현 예시)
async function fetchPortfolioRecommendations() {
  // 임시 데모 데이터
  return `
    <div class="portfolio-group">
      <h3>🇰🇷 국내 안정형 (Stable Domestic)</h3>
      <p>삼성전자, SK하이닉스, NAVER 등 대형주 중심의 안정적인 포트폴리오</p>
      <div class="no-data"><p>실제 데이터 연동 준비 중입니다.</p></div>
    </div>
    
    <div class="portfolio-group">
      <h3>🚀 국내 공격형 (Growth Domestic)</h3>
      <p>성장성이 높은 중소형주 및 테마주 중심</p>
      <div class="no-data"><p>실제 데이터 연동 준비 중입니다.</p></div>
    </div>
    
    <div class="portfolio-group">
      <h3>🇺🇸 미국 안정형 (Stable US)</h3>
      <p>S&P 500 대형주 중심의 배당주 포트폴리오</p>
      <div class="no-data"><p>실제 데이터 연동 준비 중입니다.</p></div>
    </div>
    
    <div class="portfolio-group">
      <h3>⚡ 미국 공격형 (Growth US)</h3>
      <p>NASDAQ 성장주 및 기술주 중심</p>
      <div class="no-data"><p>실제 데이터 연동 준비 중입니다.</p></div>
    </div>
  `;
}

// Main build function
async function build() {
  console.log('🚀 빌드 시작...');
  const now = new Date();
  const lastBusiness = getLastBusinessDay();

  console.log('📊 마켓 데이터 수집 중...');
  const [marketTable, portfolioHTML] = await Promise.all([
    fetchMarketIndices(),
    fetchPortfolioRecommendations(),
  ]);

  console.log('📝 HTML 템플릿 처리 중...');
  const result = tpl
    .replace('{{CURRENT_DATE}}', formatDateKR(now))
    .replace('{{DATA_DATE}}', formatDateKR(lastBusiness))
    .replace('{{MARKET_TABLE}}', marketTable)
    .replace('{{PORTFOLIO_SECTIONS}}', portfolioHTML)
    .replace('{{BUILD_TIMESTAMP}}', now.toISOString().replace('T', ' ').split('.')[0] + ' KST');

  fs.writeFileSync(path.resolve('stocks.html'), result, 'utf-8');
  console.log('✅ stocks.html 생성 완료');
  console.log(`📅 생성 시간: ${now.toLocaleString('ko-KR')}`);
}

// Run build
build().catch(err => {
  console.error('❌ 빌드 실패:', err);
  process.exit(1);
});
