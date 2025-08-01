// src/build.js
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
// use the global fetch available in modern versions of Node
// parsing is done with simple regular expressions to avoid
// external dependencies which cannot be installed in this
// environment

// Load HTML template
const tpl = fs.readFileSync(path.resolve('src/template.html'), 'utf-8');

// offline mode can be enabled with the OFFLINE environment variable. When set
// the build will use local sample data rather than fetching from the network.
const OFFLINE = process.env.OFFLINE === '1';

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

// URLs of the recommendation data
const SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbzgzE7psPX5rfMLsDprAy8jmYqwUphiKuzCDUc2ji3-dRKWSgIhb1O4Kgnrg7zk1FCyrA/exec';

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
  if (OFFLINE) {
    const data = JSON.parse(fs.readFileSync(
      path.resolve('data/sample_market_data.json'),
      'utf-8'
    ));
    const rows = Object.keys(data).map(key => {
      const info = data[key];
      const changeNum = parseFloat(info.changePct);
      const cls = changeNum > 0 ? 'positive' : changeNum < 0 ? 'negative' : 'neutral';
      return `<tr><td>${key}</td><td>${info.price}</td><td class="${cls}">${info.changePct}</td></tr>`;
    });
    return `
    <table>
      <thead>
        <tr><th>지수</th><th>현재지수</th><th>등락(%)</th></tr>
      </thead>
      <tbody id="marketBody">
        ${rows.join('')}
      </tbody>
    </table>
    `;
  }
  const fallbackData = JSON.parse(
    fs.readFileSync(path.resolve('data/sample_market_data.json'), 'utf-8')
  );
  const indices = [
    { name: 'KOSPI', code: 'KOSPI', type: 'naver' },
    { name: 'KOSDAQ', code: 'KOSDAQ', type: 'naver' },
    { name: 'S&P500', url: 'https://www.investing.com/indices/us-spx-500', type: 'invest' },
    { name: 'NASDAQ100', url: 'https://www.investing.com/indices/nq-100', type: 'invest' },
  ];

  const rows = [];
  for (const idx of indices) {
    let price = 'N/A';
    let prevClose = 'N/A';
    let changePct = 'N/A';
    
    try {
      console.log(`Fetching data for ${idx.name}...`);
      
      if (idx.type === 'naver') {
        const api = `https://polling.finance.naver.com/api/realtime?query=SERVICE_INDEX:${idx.code}`;
        const data = await fetchWithRetry(api);
        const info = data?.result?.areas?.[0]?.datas?.[0];
        if (info) {
          price = (info.nv / 100).toFixed(2);
          prevClose = ((info.nv - info.cv) / 100).toFixed(2);
          changePct = (info.cr >= 0 ? '+' : '') + info.cr.toFixed(2) + '%';
        }
        console.log(`${idx.name} (api): ${price} (${changePct})`);
        
      } else if (idx.type === 'invest') {
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(idx.url)}`;
        const { contents } = await fetchWithRetry(proxyUrl);

        const priceMatch = contents.match(/id="last_last"[^>]*>([0-9.,]+)/);
        const prevMatch = contents.match(/Prev\.\s?Close[^0-9]*([0-9.,]+)/i);

        if (priceMatch) price = priceMatch[1].replace(/,/g, '');
        if (prevMatch) prevClose = prevMatch[1].replace(/,/g, '');
        if (price !== 'N/A' && prevClose !== 'N/A') {
          const current = parseFloat(price);
          const previous = parseFloat(prevClose);
          const change = ((current - previous) / previous) * 100;
          changePct = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
        }
        console.log(`${idx.name} (Investing): ${price} (${changePct})`);

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
    }

    if ((price === 'N/A' || changePct === 'N/A') && fallbackData[idx.name]) {
      const info = fallbackData[idx.name];
      price = info.price;
      prevClose = info.prevClose;
      changePct = info.changePct;
    }

    const changeNum = parseFloat(changePct);
    const cls = changeNum > 0 ? 'positive' : changeNum < 0 ? 'negative' : 'neutral';
    rows.push(`<tr><td>${idx.name}</td><td>${price}</td><td class="${cls}">${changePct}</td></tr>`);
  }

  return `
    <table>
      <thead>
        <tr><th>지수</th><th>현재지수</th><th>등락(%)</th></tr>
      </thead>
      <tbody id="marketBody">
        ${rows.join('')}
      </tbody>
    </table>
  `;
}

// Fetch portfolio recommendations from Google Drive and build HTML
async function fetchPortfolioRecommendations() {
  const filePath = path.resolve('recommendations.json');
  const CACHE_MAX_AGE = 1000 * 60 * 60 * 24; // 24 hours
  let data;

  // Try to use cached data if it is recent
  if (fs.existsSync(filePath)) {
    try {
      const stat = fs.statSync(filePath);
      if (Date.now() - stat.mtimeMs < CACHE_MAX_AGE) {
        console.log('Using cached recommendations.json');
        data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch (err) {
      console.error('Failed to read cached recommendations:', err.message);
    }
  }

  // Fetch from remote if no valid cache and not in offline mode
  if (!data && !OFFLINE) {
    try {
      data = await fetchWithRetry(SCRIPT_URL);
      data.lastUpdated = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      console.log('recommendations.json updated');
    } catch (err) {
      console.error('Failed to fetch recommendations:', err.message);
    }
  }

  // Fallback to local file when fetch failed or offline
  if (!data) {
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      console.error('Failed to load local recommendations:', err.message);
      return {
        html: '<div id="recommendations"><p class="error">추천 데이터를 불러오지 못했습니다.</p></div>',
        lastUpdated: new Date(),
      };
    }
  }

  try {
    const markets = ['KOSPI', 'KOSDAQ', 'NASDAQ', 'NYSE'];
    const htmlParts = [];
    for (const m of markets) {
      const info = data[m];
      if (!info) continue;
      htmlParts.push(
        `<div class="portfolio-group"><h3>${m} 안전주</h3><ul>` +
          info.safe.map(s => `<li>${typeof s === 'string' ? s : s.name}</li>`).join('') +
        '</ul></div>'
      );
      htmlParts.push(
        `<div class="portfolio-group"><h3>${m} 공격적 종목</h3><ul>` +
          info.aggressive.map(s => `<li>${typeof s === 'string' ? s : s.name}</li>`).join('') +
        '</ul></div>'
      );
    }
    return {
      html: `<div id="recommendations">${htmlParts.join('')}</div>`,
      lastUpdated: data.lastUpdated ? new Date(data.lastUpdated) : new Date()
    };
  } catch (err) {
    console.error('Failed to process recommendations', err);
    return {
      html: '<div id="recommendations"><p class="error">추천 데이터를 불러오지 못했습니다.</p></div>',
      lastUpdated: new Date()
    };
  }
}

// Main build function
async function build() {
  console.log('🚀 빌드 시작...');
  const now = new Date();

  console.log('📊 마켓 데이터 수집 중...');
  const [marketTable, portfolioData] = await Promise.all([
    fetchMarketIndices(),
    fetchPortfolioRecommendations(),
  ]);
  const { html: portfolioHTML } = portfolioData;

  console.log('📝 HTML 템플릿 처리 중...');
  const result = tpl
    .replace('{{CURRENT_DATE}}', formatDateKR(now))
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
