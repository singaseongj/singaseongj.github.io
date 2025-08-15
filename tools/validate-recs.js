import fs from 'fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tools/validate-recs.js <file>');
  process.exit(1);
}

try {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof data.lastUpdated !== 'string') throw new Error('lastUpdated missing');
  const markets = ['KOSPI','KOSDAQ','NASDAQ'];
  let total = 0;
  let hasMarket = false;
  for (const m of markets) {
    if (!data[m]) continue;
    hasMarket = true;
    for (const bucket of ['safe','aggressive']) {
      const arr = data[m][bucket];
      if (!Array.isArray(arr) || arr.length < 1 || arr.length > 5) throw new Error(`${m}.${bucket} length invalid`);
      const names = new Set();
      for (const item of arr) {
        if (typeof item.name !== 'string') throw new Error(`${m}.${bucket} item missing name`);
        if (names.has(item.name)) throw new Error(`${m}.${bucket} duplicate name`);
        names.add(item.name);
        if (item.sector !== undefined && item.sector !== null && typeof item.sector !== 'string') throw new Error(`${m}.${bucket} sector invalid`);
        total++;
      }
    }
  }
  if (!hasMarket) throw new Error('no market present');
  if (total < 6) throw new Error('not enough total items');
  console.log('recommendations.json valid');
  process.exit(0);
} catch (e) {
  console.error('Validation failed:', e.message);
  process.exit(1);
}
