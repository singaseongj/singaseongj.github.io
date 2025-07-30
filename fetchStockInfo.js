import fs from 'fs/promises';

// Mapping of stock names to Yahoo Finance tickers
const TICKER_MAP = {
  '삼성전자': '005930.KS',
  '현대차': '005380.KS',
  'LG화학': '051910.KS',
  'SK텔레콤': '017670.KS',
  'POSCO홀딩스': '005490.KS',
  '카카오': '035720.KS',
  '네이버': '035420.KS',
  '셀트리온': '068270.KS',
  'HMM': '011200.KS',
  '두산에너빌리티': '034020.KS',
  '셀트리온헬스케어': '091990.KQ',
  '에코프로비엠': '247540.KQ',
  '카카오게임즈': '293490.KQ',
  'CJ ENM': '035760.KQ',
  '스튜디오드래곤': '253450.KQ',
  '제넥신': '095700.KQ',
  '펄어비스': '263750.KQ',
  '에이치엘비': '028300.KQ',
  '알테오젠': '196170.KQ',
  '씨젠': '096530.KQ',
  'Apple': 'AAPL',
  'Microsoft': 'MSFT',
  'Amazon': 'AMZN',
  'Alphabet': 'GOOGL',
  'Meta': 'META',
  'NVIDIA': 'NVDA',
  'Tesla': 'TSLA',
  'AMD': 'AMD',
  'Netflix': 'NFLX',
  'Palantir': 'PLTR',
  'Coca-Cola': 'KO',
  'Johnson & Johnson': 'JNJ',
  'Procter & Gamble': 'PG',
  'Walmart': 'WMT',
  "McDonald's": 'MCD',
  'Snowflake': 'SNOW',
  'Shopify': 'SHOP',
  'Uber': 'UBER',
  'Block': 'SQ',
  'Coinbase': 'COIN'
};

async function fetchInfo(name) {
  const ticker = TICKER_MAP[name];
  if (!ticker) {
    throw new Error('Ticker not found');
  }
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const item = data?.quoteResponse?.result?.[0];
  if (!item) throw new Error('No data');
  return {
    sector: item.sector || null,
    prevClose: item.regularMarketPreviousClose || null,
  };
}

async function updateRecommendations() {
  const json = JSON.parse(await fs.readFile('recommendations.json', 'utf-8'));
  for (const market of Object.keys(json)) {
    for (const group of ['safe', 'aggressive']) {
      json[market][group] = await Promise.all(
        json[market][group].map(async entry => {
          const name = typeof entry === 'string' ? entry : entry.name;
          try {
            const info = await fetchInfo(name);
            return { name, sector: info.sector, prevClose: info.prevClose };
          } catch (err) {
            console.error('Failed to fetch', name, err.message);
            return { name, sector: null, prevClose: null };
          }
        })
      );
    }
  }
  await fs.writeFile('recommendations.json', JSON.stringify(json, null, 2));
  console.log('recommendations.json updated');
}

updateRecommendations().catch(err => {
  console.error('Update failed', err);
});
