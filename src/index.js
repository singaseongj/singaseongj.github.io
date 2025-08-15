import { CONFIG, PATHS } from './config.js';
import { nowKSTISO } from './util.js';
import { setDeadline, testConnectivity } from './net.js';
import { tryFetchAndEnrich, sortData, pruneEmptyMarkets, rotateFromPools, writeSmartFallback } from './recommend.js';
import { writeAtomically } from './io.js';

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');

setDeadline(Number(process.env.HARD_DEADLINE_MS || CONFIG.RUN_TIMEOUT_MS));

async function main() {
  if (!(await testConnectivity())) {
    await writeSmartFallback('no_connectivity', PATHS);
    return;
  }
  try {
    const { data } = await tryFetchAndEnrich();
    let out = sortData(data);
    out.lastUpdated = nowKSTISO();
    out.mode = 'live';
    pruneEmptyMarkets(out);
    await writeAtomically(PATHS.OUT_FILE, JSON.stringify(out, null, 2));
  } catch (e) {
    const rotated = rotateFromPools();
    let out = sortData(rotated);
    out.lastUpdated = nowKSTISO();
    out.mode = 'rotation';
    pruneEmptyMarkets(out);
    await writeAtomically(PATHS.OUT_FILE, JSON.stringify(out, null, 2));
  }
}

main().catch(async () => {
  await writeSmartFallback('unhandled', PATHS);
});
