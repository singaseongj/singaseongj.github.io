import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const ORIGINAL_TAG_FILE = process.env.MARKET_TAG_FILE;
const ORIGINAL_KEYWORD_FILE = process.env.MARKET_KEYWORD_FILE;

test('buildMarketKeywordSnapshot writes tags and keyword snapshots from pre-collected data', async (t) => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fetchByTicker-'));
  const tagFile = path.join(tmpDir, 'tags.json');
  const keywordFile = path.join(tmpDir, 'newsKeywords.json');

  process.env.MARKET_TAG_FILE = tagFile;
  process.env.MARKET_KEYWORD_FILE = keywordFile;

  t.after(async () => {
    if (ORIGINAL_TAG_FILE === undefined) {
      delete process.env.MARKET_TAG_FILE;
    } else {
      process.env.MARKET_TAG_FILE = ORIGINAL_TAG_FILE;
    }

    if (ORIGINAL_KEYWORD_FILE === undefined) {
      delete process.env.MARKET_KEYWORD_FILE;
    } else {
      process.env.MARKET_KEYWORD_FILE = ORIGINAL_KEYWORD_FILE;
    }

    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  const preCollected = {
    keywords: [
      { term: 'Semiconductor Boom', term_ko: '반도체 호황', sources: ['naver-news'] },
      { term: 'Battery Demand', term_ko: '배터리 수요', sources: ['zum'] }
    ],
    totalRaw: 4,
    uniqueTerms: 2
  };

  const mod = await import('../src/news/fetchByTicker.js');

  const snapshot = await mod.buildMarketKeywordSnapshot({ outputPath: keywordFile, preCollected });

  const tagContent = JSON.parse(await fsp.readFile(tagFile, 'utf8'));
  const keywordContent = JSON.parse(await fsp.readFile(keywordFile, 'utf8'));

  assert.equal(tagContent.discovered_keywords.length, 2);
  assert.deepEqual(tagContent.discovered_keywords, [
    { term: 'Semiconductor Boom', term_ko: '반도체 호황' },
    { term: 'Battery Demand', term_ko: '배터리 수요' }
  ]);

  const translationEntry = tagContent.translations['Semiconductor Boom'];
  assert.ok(translationEntry);
  assert.equal(translationEntry.en, 'Semiconductor Boom');
  assert.equal(translationEntry.ko, '반도체 호황');
  assert.equal(typeof translationEntry.translator, 'string');
  assert.notEqual(translationEntry.translator.trim(), '');

  assert.equal(keywordContent.keywords.length, 2);
  assert.deepEqual(keywordContent.keywords, [
    { term: 'Semiconductor Boom', term_ko: '반도체 호황' },
    { term: 'Battery Demand', term_ko: '배터리 수요' }
  ]);

  assert.equal(snapshot.keywords.length, 2);
  assert.equal(snapshot.keywords[0].term_ko, '반도체 호황');
});
