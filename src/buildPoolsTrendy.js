import fs from 'fs';
import { buildUniverse } from './lib/universe.js';

function parseArgs(){
  const args = process.argv.slice(2);
  const out = { offline: false, markets: ['KOSPI','KOSDAQ','SPX','NDX'], total: 12 };
  for (const a of args){
    if (a === '--offline') out.offline = true;
    else if (a.startsWith('--markets=')) out.markets = a.split('=')[1].split(',');
    else if (a.startsWith('--total=')) out.total = Number(a.split('=')[1] || out.total);
  }
  return out;
}

function computeK(N){
  let kSafe = Math.max(Math.round(N * 0.7), 1);
  let kAggr = Math.max(N - kSafe, 1);
  return { kSafe, kAggr };
}

function fillAggressive(aggrRanked, takenSet, kAggr){
  const out = [];
  for (const x of aggrRanked){
    if (out.length >= kAggr) break;
    if (!takenSet.has(x.symbol)) out.push(x);
  }
  if (out.length === 0 && aggrRanked.length){
    const first = aggrRanked.find(x => !takenSet.has(x.symbol)) || aggrRanked[0];
    if (first) out.push(first);
  }
  return out;
}

function rotateIfStatic(prev, curr, N, ranked, takenSet){
  if (!prev) return curr;
  const prevSet = new Set([...prev.safe||[], ...prev.aggressive||[]]);
  const overlap = curr.filter(s => prevSet.has(s)).length / N;
  if (overlap >= 0.8 || overlap === 1){
    const need = Math.max(2, Math.ceil(N * 0.2));
    const candidates = ranked.map(x => x.symbol).filter(s => !takenSet.has(s) && !curr.includes(s));
    let replaced = 0;
    for (const s of candidates){
      if (replaced >= need) break;
      curr.pop();
      curr.push(s);
      replaced++;
    }
  }
  return curr;
}

function pickForMarket(market, candidates, total, prev){
  const { kSafe, kAggr } = computeK(total);
  const rankedSafe = [...candidates].sort((a,b)=>b.safeScore - a.safeScore);
  const rankedAggr = [...candidates].sort((a,b)=>b.aggrScore - a.aggrScore);
  const safe = rankedSafe.slice(0, kSafe);
  const taken = new Set(safe.map(x=>x.symbol));
  const aggressive = fillAggressive(rankedAggr, taken, kAggr);
  const takenAll = new Set([...taken, ...aggressive.map(x=>x.symbol)]);
  const combined = [...safe.map(x=>x.symbol), ...aggressive.map(x=>x.symbol)];
  const rotated = rotateIfStatic(prev, combined, total, rankedAggr, takenAll);
  return {
    safe: rotated.slice(0, safe.length),
    aggressive: rotated.slice(safe.length)
  };
}

function loadPrevPools(){
  try {
    return JSON.parse(fs.readFileSync('pools.json', 'utf8'));
  } catch { return null; }
}

function writeJSONAtomic(path, obj){
  const tmp = path + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, path);
}

async function main(){
  const opts = parseArgs();
  const prev = loadPrevPools();
  if (opts.offline){
    const metrics = { offline: true, asOf: new Date().toISOString() };
    writeJSONAtomic('pools-metrics.json', metrics);
    return;
  }

  const universe = buildUniverse({ markets: opts.markets, limit: Number(process.env.UNIVERSE_LIMIT) || 200 });
  const pools = { asOf: new Date().toISOString(), markets: {} };
  for (const m of opts.markets){
    const candidates = universe.filter(u=>u.market===m).map(u=>({ ...u, safeScore: Math.random(), aggrScore: Math.random() }));
    const prevMarket = prev?.markets?.[m];
    const sel = pickForMarket(m, candidates, opts.total, prevMarket);
    pools.markets[m] = {
      safe: sel.safe.map(x=>x.symbol),
      aggressive: sel.aggressive.map(x=>x.symbol)
    };
  }
  writeJSONAtomic('pools.json', pools);
  const metrics = { offline: false, markets: Object.keys(pools.markets) };
  writeJSONAtomic('pools-metrics.json', metrics);
}

main().catch(err=>{ console.error(err); process.exit(1); });
