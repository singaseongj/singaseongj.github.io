import { TICKER_MAP } from '../maps.js';

export async function yahooTrending(region = 'US', count = 60) {
  if (region === 'US') return ['MSFT','AAPL','NVDA','AMZN','META'];
  return ['005930.KS','000660.KS','035420.KS'];
}

export async function yahooPredefined(scrId = 'day_gainers', count = 60) {
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
