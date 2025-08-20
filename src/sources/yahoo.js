import { TICKER_MAP } from '../maps.js';

export async function yahooTrending(region = 'US', count = 60) {
  if (region === 'NYSE') return ['BRK-B','JNJ','PG','V','KO'];
  if (region === 'NASDAQ') return ['AAPL','MSFT','NVDA','AMZN','META'];
  if (region === 'NASDAQ 100') return ['AAPL','MSFT','NVDA','AMD','TSLA'];
  if (region === 'KR') return [
    '005930.KS','000660.KS','035420.KS','035720.KS','051910.KS',
    '003670.KS','267260.KS','068270.KS','005490.KS','373220.KS',
    '247540.KQ','091990.KQ','086520.KQ','278280.KQ','058470.KQ',
    '196170.KQ','277810.KQ','028300.KQ','035760.KQ','263750.KQ'
  ];
  // default to US if unknown
  return ['AAPL','MSFT','NVDA','AMZN','META'];
}

export async function yahooPredefined(scrId = 'day_gainers', count = 60) {
  if (scrId === 'day_gainers_nyse') return ['V','KO','JPM'];
  if (scrId === 'day_gainers_nasdaq100') return ['AMD','TSLA','PEP'];
  return ['TSLA','NFLX','SMCI'];
}

export async function yahooQuoteSummary(symbol) {
  const metrics = {
    MSFT: { marketCap: 2e12, beta: 1 },
    AAPL: { marketCap: 2.4e12, beta: 1 },
    NVDA: { marketCap: 1e12, beta: 1.2 },
    AMZN: { marketCap: 1.5e12, beta: 1.1 },
    META: { marketCap: 8e11, beta: 1.3 }
  };
  const m = metrics[symbol] || { marketCap: 1e10, beta: 1 };
  return { marketCap: m.marketCap, beta: m.beta, displayName: symbol };
}

export async function yahooChartCloses(symbol, range = '3mo', interval = '1d') {
  return [1,1.1,1.2,1.15,1.3,1.25,1.4,1.35,1.5,1.45,1.6];
}

export async function yahooSearchSymbol(name, lang, region) {
  const symbol = TICKER_MAP[name] || name;
  return { quotes: [{ symbol }] };
}
