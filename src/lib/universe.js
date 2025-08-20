const KR_KOSPI = [
  { symbol: '005930.KS', market: 'KOSPI', name: 'Samsung Electronics' },
  { symbol: '000660.KS', market: 'KOSPI', name: 'SK Hynix' },
  { symbol: '051910.KS', market: 'KOSPI', name: 'LG Chem' },
  { symbol: '035420.KS', market: 'KOSPI', name: 'NAVER' },
  { symbol: '005380.KS', market: 'KOSPI', name: 'Hyundai Motor' },
  { symbol: '012330.KS', market: 'KOSPI', name: 'Hyundai Mobis' }
];

const KR_KOSDAQ = [
  { symbol: '035720.KQ', market: 'KOSDAQ', name: 'Kakao' },
  { symbol: '068270.KQ', market: 'KOSDAQ', name: 'Celltrion' },
  { symbol: '036570.KQ', market: 'KOSDAQ', name: 'NCSoft' },
  { symbol: '247540.KQ', market: 'KOSDAQ', name: 'EcoPro BM' }
];

const US_SPX = [
  { symbol: 'AAPL', market: 'SPX', name: 'Apple' },
  { symbol: 'MSFT', market: 'SPX', name: 'Microsoft' },
  { symbol: 'GOOGL', market: 'SPX', name: 'Alphabet' },
  { symbol: 'AMZN', market: 'SPX', name: 'Amazon' },
  { symbol: 'NVDA', market: 'SPX', name: 'NVIDIA' },
  { symbol: 'TSLA', market: 'SPX', name: 'Tesla' }
];

const US_NDX = [
  { symbol: 'MSFT', market: 'NDX', name: 'Microsoft' },
  { symbol: 'AAPL', market: 'NDX', name: 'Apple' },
  { symbol: 'AMZN', market: 'NDX', name: 'Amazon' },
  { symbol: 'NVDA', market: 'NDX', name: 'NVIDIA' },
  { symbol: 'GOOGL', market: 'NDX', name: 'Alphabet' },
  { symbol: 'META', market: 'NDX', name: 'Meta Platforms' }
];

const MAP = { KOSPI: KR_KOSPI, KOSDAQ: KR_KOSDAQ, SPX: US_SPX, NDX: US_NDX };

export function buildUniverse({ markets = [], limit = 200 } = {}) {
  const out = [];
  for (const m of markets) {
    const arr = MAP[m] || [];
    out.push(...arr.slice(0, limit));
  }
  return out;
}

export const FALLBACK_UNIVERSE = MAP;
