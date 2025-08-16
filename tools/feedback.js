import fs from 'fs/promises';
import path from 'node:path';

function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.split('=');
    out[k.replace(/^--/, '')] = v;
  }
  return out;
}

async function writeAtomically(file, data) {
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

async function main() {
  const { market, name, delta } = parseArgs();
  if (!market || !name || !delta) {
    console.log('Usage: node tools/feedback.js --market=KOSPI --name=삼성전자 --delta=0.05');
    process.exit(1);
  }
  const d = parseFloat(delta);
  if (!Number.isFinite(d)) {
    console.error('Invalid delta');
    process.exit(1);
  }
  const file = path.resolve('feedback.json');
  let fb;
  try { fb = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { fb = { version: 1, weights: {}, decay: { half_life_days: 14, last_decay_ts: new Date().toISOString() } }; }
  fb.weights[market] = fb.weights[market] || {};
  fb.weights[market][name] = (fb.weights[market][name] || 0) + d;
  await writeAtomically(file, JSON.stringify(fb, null, 2));
  console.log(`Updated ${market} ${name} by ${d}`);
}

main().catch(e => { console.error(e); process.exit(1); });
