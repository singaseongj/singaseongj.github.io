// Minimal smoke test for ESM export shape
import test from 'node:test';
import assert from 'node:assert/strict';

test('fetchByTickers export exists', async (t) => {
  const mod = await import('../src/data/quotes.js');
  assert.equal(typeof mod.fetchByTickers, 'function');
});

