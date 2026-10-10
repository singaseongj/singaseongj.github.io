import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildKeywordSnapshot } from '../src/keywordCloud.js';

const snapshot = buildKeywordSnapshot({
  generatedAt: '2026-10-10T00:00:00Z',
  keywords: [
    { term: 'semiconductor', term_ko: '반도체', score: 8, search: { ko: 'https://example.com/news' } },
    { term: 'duplicate', term_ko: '반도체' },
    { term: 'English only' },
    { term: 'energy', term_ko: '에너지', weight: 2, search: { ko: 'javascript:alert(1)' } }
  ],
  discovered_keywords: [{ term: 'rates', term_ko: '금리' }]
});
assert.equal(snapshot.language, 'ko');
assert.equal(snapshot.generatedAt, '2026-10-10T00:00:00Z');
assert.deepEqual(snapshot.keywords.map(entry => entry.term_ko), ['반도체', '에너지', '금리']);
assert.equal(snapshot.keywords[0].weight, 8);
assert.equal(snapshot.keywords[0].search.ko, 'https://example.com/news');
assert.match(snapshot.keywords[1].search.ko, /^https:\/\/www.google.com\/search\?/);
assert.equal(new URL(snapshot.keywords[1].search.ko).searchParams.get('q'), '에너지');
assert.throws(() => buildKeywordSnapshot({ keywords: [{ term: 'English only' }] }), /No Korean keywords/);
assert.equal(buildKeywordSnapshot({ keywords: [], translations: { rates: { ko: '금리' } }, discovered_keywords: [{ term: 'rates' }] }).keywords[0].term_ko, '금리');

const template = await readFile('src/template.html', 'utf8');
const mainScript = template.match(/<script>\s*(const translations[\s\S]*?)<\/script>/)[1];
const context = vm.createContext({ URL, console, document: { addEventListener() {} } });
vm.runInContext(mainScript, context);
context.entries = snapshot.keywords;
const html = vm.runInContext('buildKeywordCloudHtml(entries)', context);
assert.equal((html.match(/class="keyword-word"/g) || []).length, 3);
assert.match(html, /href="https:\/\/example.com\/news"/);
assert.match(html, /target="_blank" rel="noopener noreferrer"/);
assert.match(html, /반도체 뉴스 검색/);
assert.doesNotMatch(html, /English|한국어<\/a>|<li/);
context.entries = [
  { term_ko: '반도체 <script>', weight: 10, search: { ko: 'javascript:alert(1)' } },
  { term_ko: '금리', weight: 1 }
];
const escaped = vm.runInContext('buildKeywordCloudHtml(entries)', context);
assert.match(escaped, /&lt;script&gt;/);
assert.doesNotMatch(escaped, /href="javascript:/);
assert.match(escaped, /--word-size:2.40rem/);
assert.match(escaped, /--word-size:1.00rem/);
assert.doesNotMatch(template, /languageToggle|btnKo|btnEn/);
console.log('Keyword cloud tests passed');
