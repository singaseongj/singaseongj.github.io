import fs from 'fs';
import { execSync } from 'child_process';
import test from 'node:test';
import assert from 'assert';

function readJSONSafe(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readPrevPoolsFromGit() {
  try {
    const txt = execSync('git show HEAD~1:pools.json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
    return JSON.parse(txt);
  } catch {
    return null; // first run / file not in previous commit
  }
}

function setFromPools(pools) {
  const out = {};
  for (const m of Object.keys(pools || {})) {
    const s = pools[m]?.safe || [];
    const a = pools[m]?.aggressive || [];
    out[m] = new Set([...s, ...a]);
  }
  return out;
}

test('pools show at least some rotation vs previous commit', () => {
  const cur = readJSONSafe('pools.json');
  assert.ok(cur, 'missing pools.json');

  const prev = readPrevPoolsFromGit();
  if (!prev) {
    // Nothing to compare; do not fail on first run
    return;
  }

  const A = setFromPools(cur);
  const B = setFromPools(prev);

  // Require change in at least one key KR market
  const targets = ['KOSPI', 'KOSDAQ'];
  let changed = false;
  for (const m of targets) {
    const a = A[m] || new Set();
    const b = B[m] || new Set();
    for (const n of a) {
      if (!b.has(n)) {
        changed = true;
        break;
      }
    }
    if (changed) break;
  }

  assert.ok(changed, 'no new names introduced in KOSPI or KOSDAQ');
});
