import { yahooTrending, yahooPredefined } from '../sources/yahoo.js';
import { TICKER_MAP } from '../maps.js';

const FMP = process.env.FMP_KEY || '';
const INCLUDE_ETFS = process.env.INCLUDE_ETFS === '1';

const NAME_TO_SYMBOL = TICKER_MAP;
const SYMBOL_TO_NAME = {};
for (const [n, s] of Object.entries(TICKER_MAP)) SYMBOL_TO_NAME[s] = n;

const UNMAPPED = new Set();
function tickerToName(t){
  const n = SYMBOL_TO_NAME[t];
  if (n) return n;
  if (!UNMAPPED.has(t)) { console.warn(`[universe] unmapped: ${t}`); UNMAPPED.add(t); }
  return t;
}

async function fmpActives(exchange){
  if (!FMP) return [];
  try {
    const url = `https://financialmodelingprep.com/api/v3/actives?apikey=${FMP}`;
    const res = await fetch(url);
    const data = await res.json();
    return (Array.isArray(data)?data:[]).filter(d=>d.exchangeShortName===exchange).map(d=>d.ticker);
  } catch {
    return [];
  }
}

const SP_MEGA = ['AAPL','MSFT','NVDA','AMZN','META','GOOGL','TSLA','BRK-B','JNJ','PG','V','KO','JPM','UNH','LLY'];
const ETF_LIST = ['SPY','QQQ','XLK','XLF','ARKK'];

export async function buildUniverse(basePools={}, {limitPerMarket=60}={}){
  const out = {};
  const markets = ['KOSPI','KOSDAQ','S&P 500','NASDAQ 100'];
  for (const m of markets){
    const seen = new Set();
    const names = new Set();
    const base = [...(basePools[m]?.safe||[]), ...(basePools[m]?.aggressive||[])];
    for (const n of base){
      const sym = NAME_TO_SYMBOL[n] || n;
      if (seen.has(sym)) continue;
      seen.add(sym);
      names.add(n);
    }
    let tickers = [];
    try {
      if (m === 'KOSPI') {
        tickers = (await yahooTrending('KR')).filter(t=>/\.KS$/.test(t));
        tickers.push(...await fmpActives('KOSPI'));
      } else if (m === 'KOSDAQ') {
        tickers = (await yahooTrending('KR')).filter(t=>/\.KQ$/.test(t));
        tickers.push(...await fmpActives('KOSDAQ'));
      } else if (m === 'S&P 500') {
        tickers = [
          ...(await yahooTrending('US')),
          ...(await yahooPredefined('day_gainers')),
          ...SP_MEGA
        ];
        if (INCLUDE_ETFS) tickers.push(...ETF_LIST);
      } else if (m === 'NASDAQ 100') {
        tickers = [
          ...(await yahooTrending('NASDAQ 100')),
          ...(await yahooPredefined('day_gainers_nasdaq100'))
        ];
        if (INCLUDE_ETFS) tickers.push(...ETF_LIST);
      }
    } catch {}
    for (const t of tickers){
      const sym = t;
      if (seen.has(sym)) continue;
      seen.add(sym);
      names.add(tickerToName(sym));
      if (names.size >= limitPerMarket) break;
    }
    out[m] = Array.from(names).slice(0, limitPerMarket);
  }
  return out;
}
