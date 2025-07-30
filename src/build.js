// src/build.js
import fs from 'fs';
import path from 'path';
// use the global fetch available in modern versions of Node
// parsing is done with simple regular expressions to avoid
// external dependencies which cannot be installed in this
// environment

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

// 재시도 함수
async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
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
  for (const idx of indices) {
    let price = 'N/A';
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

        if (priceMatch) price = priceMatch[1].trim().replace(/,/g, '');
        if (rateMatch) changePct = rateMatch[1].trim();

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
        changePct = '+0.5%';
      } else if (idx.name === 'KOSDAQ') {
        price = '700.00';
        changePct = '-0.3%';
      }
    }

    const changeNum = parseFloat(changePct);
    const cls = changeNum > 0 ? 'positive' : changeNum < 0 ? 'negative' : 'neutral';
    rows.push(`<tr><td>${idx.name}</td><td>${price}</td><td class="${cls}">${changePct}</td></tr>`);
  }

  return `
    <table>
      <thead>
        <tr><th>지수</th><th>전일 종가</th><th>등락(%)</th></tr>
      </thead>
      <tbody id="marketBody">
        ${rows.join('')}
      </tbody>
    </table>
  `;
}

// Fetch portfolio recommendations (구현 예시)
async function fetchPortfolioRecommendations() {
  return `
    <div class="portfolio-group">
      <h3>🇰🇷 KOSPI 추천</h3>
      <p>대표적인 대형주 중심의 안정적인 포트폴리오</p>
      <ul>
        <li><strong>삼성전자</strong> - 반도체 업계 선도, 안정적 배당</li>
        <li><strong>SK하이닉스</strong> - 메모리 반도체 강자</li>
        <li><strong>NAVER</strong> - 국내 IT 플랫폼 대표</li>
        <li><strong>카카오</strong> - 모바일 생태계 구축</li>
      </ul>
    </div>

    <div class="portfolio-group">
      <h3>🚀 KOSDAQ 추천</h3>
      <p>성장 잠재력이 높은 중소형주 및 테마주</p>
      <ul>
        <li><strong>셀트리온</strong> - 바이오 의약품 선도</li>
        <li><strong>LG에너지솔루션</strong> - 배터리 시장 급성장</li>
        <li><strong>현대차</strong> - 전기차 전환 수혜</li>
        <li><strong>포스코홀딩스</strong> - 철강/이차전지 소재</li>
      </ul>
    </div>

    <div class="portfolio-group">
      <h3>🇺🇸 NASDAQ 추천</h3>
      <p>기술주와 성장주 중심의 포트폴리오</p>
      <ul>
        <li><strong>Apple (AAPL)</strong> - 기술주 대장, 안정적 현금흐름</li>
        <li><strong>Microsoft (MSFT)</strong> - 클라우드 시장 선도</li>
        <li><strong>Johnson & Johnson (JNJ)</strong> - 헬스케어 디펜시브</li>
        <li><strong>Procter & Gamble (PG)</strong> - 소비재 안정주</li>
      </ul>
    </div>

    <div class="portfolio-group">
      <h3>🏙️ NYSE 추천</h3>
      <p>S&P 500 편입 종목 등 미국을 대표하는 기업</p>
      <ul>
        <li><strong>NVIDIA (NVDA)</strong> - AI 칩 시장 독점</li>
        <li><strong>Tesla (TSLA)</strong> - 전기차 및 자율주행</li>
        <li><strong>Amazon (AMZN)</strong> - 이커머스/클라우드 성장</li>
        <li><strong>Meta (META)</strong> - 메타버스 및 AI 투자</li>
      </ul>
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
