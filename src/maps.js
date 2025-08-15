export const TICKER_MAP = {
  '삼성전자': '005930.KS', 'SK하이닉스': '000660.KS', '삼성바이오로직스': '207940.KS',
  '현대차': '005380.KS', 'LG에너지솔루션': '373220.KS', '한화에어로스페이스': '012450.KS',
  'HD현대일렉트릭': '267260.KS', 'POSCO퓨처엠': '003670.KS', '두산에너빌리티': '034020.KS',
  'HD한국조선해양': '009540.KS', 'POSCO홀딩스': '005490.KS', 'LG화학': '051910.KS',
  'SK텔레콤': '017670.KS', '카카오': '035720.KS', '네이버': '035420.KS', 'NAVER': '035420.KS',
  '셀트리온': '068270.KS', 'BGF리테일': '282330.KS', '기아': '000270.KS', 'LG전자': '066570.KS',
  '삼성SDI': '006400.KS', '에코프로': '086520.KS',
  '에코프로비엠': '247540.KQ', '셀트리온헬스케어': '091990.KQ', '천보': '278280.KQ',
  '리노공업': '058470.KQ', 'JYP엔터테인먼트': '035900.KQ', '알테오젠': '196170.KQ',
  '레인보우로보틱스': '277810.KQ', 'HLB': '028300.KQ', '지아이이노베이션': '358570.KQ',
  '펩트론': '087010.KQ', '펄어비스': '263750.KQ', '아이오케이': '078860.KQ', 'CJ ENM': '035760.KQ',
  'Microsoft': 'MSFT', 'Apple': 'AAPL', 'NVIDIA': 'NVDA', 'Amazon': 'AMZN',
  'Meta Platforms': 'META', 'Alphabet': 'GOOGL', 'Tesla': 'TSLA', 'Netflix': 'NFLX',
  'Super Micro Computer': 'SMCI', 'Palantir': 'PLTR', 'Arm Holdings': 'ARM',
  'Micron Technology': 'MU', 'UiPath': 'PATH', 'CrowdStrike': 'CRWD',
  'Berkshire Hathaway (B)': 'BRK-B', 'Johnson & Johnson': 'JNJ',
  'Procter & Gamble': 'PG', 'Visa': 'V', 'Coca-Cola': 'KO',
  'ServiceNow': 'NOW', 'Eli Lilly': 'LLY', 'Uber Technologies': 'UBER',
  'NRG Energy': 'NRG', 'JPMorgan Chase': 'JPM', 'UnitedHealth': 'UNH',
  'Moderna': 'MRNA', 'Zoom': 'ZM', 'MongoDB': 'MDB', 'Snowflake': 'SNOW'
};

export const STATIC_SECTORS = {
  '005930.KS': 'Technology', '000660.KS': 'Technology', '005380.KS': 'Consumer Discretionary',
  '051910.KS': 'Materials', '035720.KS': 'Communication Services', '035420.KS': 'Communication Services',
  '005490.KS': 'Materials', '267260.KS': 'Industrials', '012450.KS': 'Industrials',
  '034020.KS': 'Industrials', '282330.KS': 'Consumer Staples', '000270.KS': 'Consumer Discretionary',
  '066570.KS': 'Technology', '006400.KS': 'Technology', '086520.KS': 'Materials',
  '247540.KQ': 'Materials', '091990.KQ': 'Healthcare', '278280.KQ': 'Industrials',
  '058470.KQ': 'Industrials', '035900.KQ': 'Communication Services', '196170.KQ': 'Healthcare',
  '277810.KQ': 'Industrials', '028300.KQ': 'Healthcare', '358570.KQ': 'Technology',
  '087010.KQ': 'Healthcare', '263750.KQ': 'Communication Services', '078860.KQ': 'Technology',
  '035760.KQ': 'Communication Services',
  'MSFT': 'Technology', 'AAPL': 'Technology', 'NVDA': 'Technology', 'AMZN': 'Consumer Discretionary',
  'META': 'Communication Services', 'GOOGL': 'Communication Services', 'TSLA': 'Consumer Discretionary',
  'NFLX': 'Communication Services', 'SMCI': 'Technology', 'PLTR': 'Technology', 'ARM': 'Technology',
  'MU': 'Technology', 'PATH': 'Technology', 'CRWD': 'Technology', 'BRK-B': 'Financial Services',
  'JNJ': 'Healthcare', 'PG': 'Consumer Staples', 'V': 'Financial Services', 'KO': 'Consumer Staples',
  'NOW': 'Technology', 'LLY': 'Healthcare', 'UBER': 'Technology', 'NRG': 'Utilities',
  'JPM': 'Financial Services', 'UNH': 'Healthcare', 'MRNA': 'Healthcare', 'ZM': 'Technology',
  'MDB': 'Technology', 'SNOW': 'Technology'
};

export const looksKorean = s => /[가-힣]/.test(s);
export const looksSymbol = s => /^[A-Z.\-]+$/.test(s) || /^\d{6}\.K[QS]$/.test(s);
