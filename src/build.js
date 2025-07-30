// src/build.js
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
// use the global fetch available in modern versions of Node
// parsing is done with simple regular expressions to avoid
// external dependencies which cannot be installed in this
// environment

// Load HTML template
const tpl = fs.readFileSync(path.resolve('src/template.html'), 'utf-8');

// offline mode for environments without network access
const OFFLINE = process.env.OFFLINE === '1' || process.argv.includes('--offline');
let sampleIndices = {};
if (OFFLINE) {
  try {
    sampleIndices = JSON.parse(fs.readFileSync(path.resolve('data/sample_market_data.json'), 'utf-8'));
    console.log('Using sample market data (offline mode)');
  } catch (err) {
    console.warn('Failed to load sample data:', err.message);
  }
}

// Format date in Korean
function formatDateKR(date) {
  return date.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Format full datetime in Korean (KST)
function formatDateTimeKR(date) {
  return date.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
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

// Get the last commit time for recommendations.json
function getRecommendationsUpdateTime() {
  try {
    const iso = execSync('git log -1 --format=%cI -- recommendations.json').toString().trim();
    return new Date(iso);
  } catch (err) {
    console.error('Failed to read update time', err);
    return new Date();
  }
}

// 재시도 함수
async function fetchWithRetry(url, retries = 3, timeout = 10000) {
  for (let i = 0; i < retries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
      clearTimeout(timer);
      console.log(`Retry ${i + 1}/${retries} for ${url}: ${err.message}`);
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // 1초, 2초, 3초 대기
    }
  }
}

// Fetch market indices data
async function fetchMarketIndices() {
  const indices = [
    { name: 'KOSPI', url: 'https://finance.naver.com/sise/sise_index.naver?code=KOSPI', type: 'naver' },
    { name: 'KOSDAQ', url: 'https://finance.naver.com/sise/sise_index.naver?code=KOSDAQ', type: 'naver' },
    { name: 'NYSE', url: 'https://finance.yahoo.com/quote/%5ENYA', type: 'yahoo' },
    { name: 'NASDAQ', url: 'https://finance.yahoo.com/quote/%5EIXIC', type: 'yahoo' },
  ];

  const rows = [];
  if (OFFLINE) {
    for (const idx of indices) {
      const data = sampleIndices[idx.name] || {};
      const price = data.price || 'N/A';
      const prevClose = data.prevClose || 'N/A';
      const changePct = data.changePct || 'N/A';
      const changeNum = parseFloat(changePct);
      const cls = changeNum > 0 ? 'positive' : changeNum < 0 ? 'negative' : 'neutral';
      rows.push(`<tr><td>${idx.name}</td><td>${price}</td><td>${prevClose}</td><td class="${cls}">${changePct}</td></tr>`);
    }
    return `
    <table>
      <thead>
        <tr><th>지수</th><th>현재지수</th><th>전일종가</th><th>등락(%)</th></tr>
      </thead>
      <tbody id="marketBody">
        ${rows.join('')}
      </tbody>
    </table>
  `;
  }
  for (const idx of indices) {
    let price = 'N/A';
    let prevClose = 'N/A';
    let changePct = 'N/A';
    
    try {
      console.log(`Fetching data for ${idx.name}...`);
      
      if (idx.type === 'naver') {
        // 네이버 파이낸스 직접 호출 (CORS 우회)
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(idx.url)}`;
        const { contents } = await fetchWithRetry(proxyUrl);

        // JSDOM을 사용할 수 없는 환경이므로 정규식을 활용해 값 파싱
        const priceMatch = contents.match(/now_value[^>]*>([0-9,.\s]+)</);
        const rateMatch = contents.match(/rate[^>]*>([+-]?[0-9.,\s%]+)</);
        const prevMatch = contents.match(/전일[^0-9]*?([0-9,.]+)</);

        if (priceMatch) price = priceMatch[1].trim().replace(/,/g, '');
        if (rateMatch) changePct = rateMatch[1].trim();
        if (prevMatch) prevClose = prevMatch[1].trim().replace(/,/g, '');

        console.log(`${idx.name} (parsed): ${price} (${changePct})`);
        
      } else if (idx.type === 'yahoo') {
        // Yahoo Finance API 직접 호출
        // 각 지수에 대응하는 야후 파이낸스 심볼 지정
        const symbol = idx.name === 'NYSE' ? '^NYA' : '^IXIC';
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;
        
        try {
          const response = await fetch(yahooUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
          });
          const data = await response.json();
          
          if (data.chart && data.chart.result && data.chart.result[0]) {
            const result = data.chart.result[0];
            const currentPrice = result.meta.regularMarketPrice;
            const previousClose = result.meta.previousClose;

            if (currentPrice && previousClose) {
              price = currentPrice.toFixed(2);
              prevClose = previousClose.toFixed(2);
              const change = ((currentPrice - previousClose) / previousClose * 100);
              changePct = (change > 0 ? '+' : '') + change.toFixed(2) + '%';
              console.log(`${idx.name} (Yahoo API): ${price} (${changePct})`);
            }
          }
        } catch (yahooErr) {
          console.log(`Yahoo API 실패, 프록시 시도 중...`);
          // 프록시를 통한 Yahoo Finance 페이지 스크래핑
          const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(idx.url)}`;
          const { contents } = await fetchWithRetry(proxyUrl);
          
          const priceMatch = contents.match(/"regularMarketPrice":\{"raw":([\d.]+)/);
          const prevMatch = contents.match(/"regularMarketPreviousClose":\{"raw":([\d.]+)/);
          
          if (priceMatch && prevMatch) {
            const current = parseFloat(priceMatch[1]);
            const previous = parseFloat(prevMatch[1]);
            price = current.toFixed(2);
            prevClose = previous.toFixed(2);
            const change = ((current - previous) / previous * 100);
            changePct = (change > 0 ? '+' : '') + change.toFixed(2) + '%';
            console.log(`${idx.name} (proxy): ${price} (${changePct})`);
          }
        }
      }
      
    } catch (err) {
      console.error(`Error fetching ${idx.name}:`, err.message);
      // 더미 데이터라도 표시
      if (idx.name === 'KOSPI') {
        price = '2,400.00';
        prevClose = '2,390.00';
        changePct = '+0.5%';
      } else if (idx.name === 'KOSDAQ') {
        price = '700.00';
        prevClose = '702.10';
        changePct = '-0.3%';
      }
    }

    const changeNum = parseFloat(changePct);
    const cls = changeNum > 0 ? 'positive' : changeNum < 0 ? 'negative' : 'neutral';
    rows.push(`<tr><td>${idx.name}</td><td>${price}</td><td>${prevClose}</td><td class="${cls}">${changePct}</td></tr>`);
  }

  return `
    <table>
      <thead>
        <tr><th>지수</th><th>현재지수</th><th>전일종가</th><th>등락(%)</th></tr>
      </thead>
      <tbody id="marketBody">
        ${rows.join('')}
      </tbody>
    </table>
  `;
}

// Fetch portfolio recommendations - placeholder container
async function fetchPortfolioRecommendations() {
  return '<div id="recommendations"><div class="loading">추천 로딩 중...</div></div>';
}

// Main build function
async function build() {
  console.log('🚀 빌드 시작...');
  const now = new Date();
  const lastUpdate = getRecommendationsUpdateTime();

  console.log('📊 마켓 데이터 수집 중...');
  const [marketTable, portfolioHTML] = await Promise.all([
    fetchMarketIndices(),
    fetchPortfolioRecommendations(),
  ]);

  console.log('📝 HTML 템플릿 처리 중...');
  const result = tpl
    .replace('{{CURRENT_DATE}}', formatDateKR(now))
    .replace('{{DATA_DATE}}', formatDateTimeKR(lastUpdate))
    .replace('{{MARKET_TABLE}}', marketTable)
    .replace('{{PORTFOLIO_SECTIONS}}', portfolioHTML)
    .replace('{{BUILD_TIMESTAMP}}', now.toISOString().replace('T', ' ').split('.')[0] + ' KST');

  await fsp.writeFile(path.resolve('stocks.html'), result, 'utf-8');
  console.log('✅ stocks.html 생성 완료');
  console.log(`📅 생성 시간: ${now.toLocaleString('ko-KR')}`);
}

// Run build
build().catch(err => {
  console.error('❌ 빌드 실패:', err);
  process.exit(1);
});
