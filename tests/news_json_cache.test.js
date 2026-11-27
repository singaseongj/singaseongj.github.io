import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cachedNewsJson, newsCacheFilename } from '../src/news/helpers/jsonCache.js';

test('cache keys exclude each provider credential and preserve query identity', () => {
  const providers = [
    ['https://finnhub.io/api/v1/company-news', 'token'],
    ['https://newsapi.org/v2/everything', 'apiKey'],
    ['https://serpapi.com/search.json', 'api_key'],
    ['https://gnews.io/api/v4/search', 'apikey'],
    ['https://newsdata.io/api/1/archive', 'apikey'],
    ['https://apis.data.go.kr/B410001/kotra_overseasMarketNews/ovseaMrktNews', 'serviceKey'],
  ];

  for (const [url, param] of providers) {
    const name = newsCacheFilename(`${url}?q=NVDA&page=1`);
    assert.match(name, /^news-v2-[0-9a-f]{64}\.json$/);
    assert.equal(newsCacheFilename(`${url}?page=1&${param}=test%2Ffirst&q=NVDA`), name);
    assert.equal(newsCacheFilename(`${url}?q=NVDA&${param}=test-second&page=1`), name);
    assert.notEqual(newsCacheFilename(`${url}?q=MSFT&page=1`), name);
    assert.notEqual(newsCacheFilename(`${url}?q=NVDA&page=2`), name);
  }
  assert.equal(
    newsCacheFilename('https://user:synthetic@example.test/news?API_KEY=synthetic#synthetic'),
    newsCacheFilename('https://example.test/news'),
  );
  assert.notEqual(
    newsCacheFilename('https://example.test/news'),
    newsCacheFilename('https://other.example.test/news'),
  );
});

test('cache writes a safe filename, passes auth on the wire, and reuses hits after rotation', async (t) => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'news-json-cache-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const first = 'https://example.test/news?q=example&token=synthetic-one';
  const second = 'https://example.test/news?q=example&token=synthetic-two';
  const data = { articles: [] };
  let calls = 0;
  const fetcher = async (url) => {
    calls++;
    assert.equal(url, first);
    return data;
  };
  const options = { cacheDir, ttlMs: 60_000, allowStale: true };
  assert.deepEqual(await cachedNewsJson(first, fetcher, options), data);
  assert.deepEqual(await cachedNewsJson(second, fetcher, options), data);
  assert.equal(calls, 1);
  const files = await readdir(cacheDir);
  assert.deepEqual(files, [newsCacheFilename('https://example.test/news?q=example')]);
  assert.deepEqual(JSON.parse(await readFile(path.join(cacheDir, files[0]), 'utf8')), data);

  const offline = async () => { throw new Error('offline'); };
  assert.deepEqual(await cachedNewsJson(second, offline, { ...options, ttlMs: 0 }), data);
  await assert.rejects(cachedNewsJson(second, offline, { ...options, ttlMs: 0, allowStale: false }), /offline/);
});
