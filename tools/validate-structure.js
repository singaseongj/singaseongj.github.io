import { existsSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const required = {
  'src/config.js': ['CONFIG','PATHS','HEADERS_HTML','HEADERS_JSON'],
  'src/util.js': ['sleep','nowKSTISO','seededRandom','pickDeterministic','chunkArray','withTimeout'],
  'src/net.js': ['noteStatus','nextDelay','fetchWithTimeout','fetchWithRetry','testConnectivity','setDeadline'],
  'src/io.js': ['loadJSON','saveJSON','writeAtomically','tryPullRemote','tryPushRemote'],
  'src/maps.js': ['TICKER_MAP','STATIC_SECTORS','looksKorean','looksSymbol'],
  'src/sources/yahoo.js': ['yahooTrending','yahooPredefined','yahooQuoteSummary','yahooChartCloses','yahooSearchSymbol'],
  'src/sources/naver.js': ['naverSectorKR','naverPopularKR'],
  'src/classify.js': ['annualizedVol','classify','ensureMetrics'],
  'src/recommend.js': ['buildTrendingPools','fetchSectorByTicker','fetchSector','tryFetchAndEnrich','sortData','pruneEmptyMarkets','rotateFromPools','writeSmartFallback'],
  'src/index.js': []
};

let errors = [];

for (const [file, exports] of Object.entries(required)) {
  if (!existsSync(file)) {
    errors.push(`Missing file: ${file}`);
    continue;
  }
  const mod = await import(pathToFileURL(path.resolve(file)));
  for (const e of exports) {
    if (!(e in mod)) errors.push(`Missing export ${e} in ${file}`);
  }
}

if (errors.length) {
  errors.forEach(e => console.error(e));
  process.exit(1);
}

console.log('All modules present with required exports');
