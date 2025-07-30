import fs from 'fs';

// Helper to fetch JSON with retries
async function fetchJson(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function getTrending(region) {
  try {
    const data = await fetchJson(`https://query1.finance.yahoo.com/v1/finance/trending/${region}`);
    const quotes = data.finance?.result?.[0]?.quotes || [];
    return quotes.map(q => q.symbol).slice(0, 10);
  } catch (err) {
    console.error('Failed to fetch trending for', region, err.message);
    return [];
  }
}

export default async function updateRecommendations() {
  const safe = {
    KOSPI: ['삼성전자', '현대차', 'LG화학', 'SK텔레콤', 'POSCO홀딩스'],
    KOSDAQ: ['셀트리온헬스케어', '에코프로비엠', '카카오게임즈', 'CJ ENM', '스튜디오드래곤'],
    NASDAQ: ['Apple', 'Microsoft', 'Amazon', 'Alphabet', 'Meta'],
    NYSE: ['Coca-Cola', 'Johnson & Johnson', 'Procter & Gamble', 'Walmart', "McDonald's"]
  };

  const fallbackAggressive = {
    KOSPI: ['카카오', '네이버', '셀트리온', 'HMM', '두산에너빌리티'],
    KOSDAQ: ['제넥신', '펄어비스', '에이치엘비', '알테오젠', '씨젠'],
    NASDAQ: ['NVIDIA', 'Tesla', 'AMD', 'Netflix', 'Palantir'],
    NYSE: ['Snowflake', 'Shopify', 'Uber', 'Block', 'Coinbase']
  };

  const krTrending = await getTrending('KR');
  const usTrending = await getTrending('US');

  const recommendations = {
    KOSPI: {
      safe: safe.KOSPI,
      aggressive: krTrending.slice(0, 5).length === 5 ? krTrending.slice(0, 5) : fallbackAggressive.KOSPI
    },
    KOSDAQ: {
      safe: safe.KOSDAQ,
      aggressive: krTrending.slice(5, 10).length === 5 ? krTrending.slice(5, 10) : fallbackAggressive.KOSDAQ
    },
    NASDAQ: {
      safe: safe.NASDAQ,
      aggressive: usTrending.slice(0, 5).length === 5 ? usTrending.slice(0, 5) : fallbackAggressive.NASDAQ
    },
    NYSE: {
      safe: safe.NYSE,
      aggressive: usTrending.slice(5, 10).length === 5 ? usTrending.slice(5, 10) : fallbackAggressive.NYSE
    }
  };

  fs.writeFileSync('recommendations.json', JSON.stringify(recommendations, null, 2));
  console.log('recommendations.json updated');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  updateRecommendations().catch(err => {
    console.error('Failed to update recommendations:', err);
    process.exitCode = 1;
  });
}
