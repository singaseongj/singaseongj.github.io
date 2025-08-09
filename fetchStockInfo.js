import fs from 'fs/promises';

const SIX_HOURS = 6 * 60 * 60 * 1000;

const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;

const FORCE = process.argv.includes('--force');

// Yahoo Finance ticker mapping for every name in your JSON
const TICKER_MAP = {
  // --- KOSPI (KS) ---
  '삼성전자': '005930.KS',
  'SK하이닉스': '000660.KS',
  '삼성바이오로직스': '207940.KS',
  '현대차': '005380.KS',
  'LG에너지솔루션': '373220.KS',
  '한화에어로스페이스': '012450.KS',
  'HD현대일렉트릭': '267260.KS',
  'POSCO퓨처엠': '003670.KS',
  '두산에너빌리티': '034020.KS',
  'HD한국조선해양': '009540.KS',

  // --- KOSDAQ (KQ) ---
  '에코프로비엠': '247540.KQ',
  '셀트리온헬스케어': '091990.KQ',
  '천보': '278280.KQ',
  '리노공업': '058470.KQ',
  'JYP엔터테인먼트': '035900.KQ',
  '알테오젠': '196170.KQ',
  '레인보우로보틱스': '277810.KQ',
  'HLB': '028300.KQ',
  '지아이이노베이션': '358570.KQ',
  '펩트론': '087010.KQ',

  // --- NASDAQ / S&P 500 (US) ---
  'Microsoft': 'MSFT',
  'Apple': 'AAPL',
  'NVIDIA': 'NVDA',
  'Amazon': 'AMZN',
  'Alphabet': 'GOOGL',
  'Super Micro Computer': 'SMCI',
  'Advanced Micro Devices': 'AMD',
  'Arm Holdings': 'ARM',
  'Micron Technology': 'MU',
  'CrowdStrike': 'CRWD',
  'Berkshire Hathaway (B)': 'BRK-B',
  'Johnson & Johnson': 'JNJ',
  'Procter & Gamble': 'PG',
  'Visa': 'V',
  'Palantir': 'PLTR',
  'Eli Lilly': 'LLY',
  'Uber Technologies': 'UBER',
  'NRG Energy': 'NRG'
};

async function fetchSector(name) {
  const ticker = TICKER_MAP[name];
  if (!ticker) throw new Error(`Ticker not found for ${name}`);

  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    ticker
  )}?modules=assetProfile`;

  const res = await fetch(url, { agent, headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  const result = json?.quoteSummary?.result?.[0];
  const sector = result?.assetProfile?.sector ?? null;

  if (!sector) throw new Error('Sector not found');
  return sector;
}

async function updateRecommendations() {
  let data;
  try {
    data = JSON.parse(await fs.readFile('recommendations.json', 'utf-8'));
  } catch {
    console.error('recommendations.json not found. Save your JSON file first.');
    process.exit(1);
  }

  // Cache guard (skipped with --force)
  if (data.lastUpdated && !FORCE) {
    const age = Date.now() - new Date(data.lastUpdated).getTime();
    if (age < SIX_HOURS) {
      console.log('recommendations.json is up to date (<6h). Use --force to override.');
      return;
    }
  }

  const markets = Object.keys(data).filter(k => typeof data[k] === 'object' && data[k] !== null);
  for (const market of markets) {
    const bucket = data[market];
    if (!bucket?.safe || !bucket?.aggressive) continue;

    for (const group of ['safe', 'aggressive']) {
      const entries = bucket[group];
      if (!Array.isArray(entries)) continue;

      // Refresh every name's sector, but never replace a good value with null
      data[market][group] = await Promise.all(
        entries.map(async entry => {
          const name = typeof entry === 'string' ? entry : entry.name;
          const prevSector = typeof entry === 'object' ? entry.sector ?? null : null;

          if (!TICKER_MAP[name]) {
            console.warn(`[WARN] No ticker mapping for "${name}". Add it to TICKER_MAP.`);
            return { name, sector: prevSector };
          }

          try {
            const sector = await fetchSector(name);
            return { name, sector: sector ?? prevSector ?? null };
          } catch (err) {
            console.error(`[WARN] Sector fetch failed for "${name}": ${err.message}`);
            // Keep whatever was there before rather than nulling it out
            return { name, sector: prevSector };
          }
        })
      );
    }
  }

  data.lastUpdated = new Date().toISOString();
  await fs.writeFile('recommendations.json', JSON.stringify(data, null, 2));
  console.log('recommendations.json updated');
}

updateRecommendations().catch(err => {
  console.error('Update failed', err);
  process.exit(1);
});
