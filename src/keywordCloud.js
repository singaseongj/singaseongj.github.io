import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

export function buildKeywordSnapshot(tags, limit = 30) {
  const seen = new Set();
  const pool = [...(tags.keywords || []), ...(tags.discovered_keywords || []), ...(tags.top_keywords || [])];
  const keywords = [];
  for (const entry of pool) {
    const translation = tags.translations?.[entry?.term];
    const termKo = String(entry?.term_ko || (typeof translation === 'string' ? translation : translation?.ko) || entry?.term || '').trim();
    if (!/[가-힣]/.test(termKo) || seen.has(termKo)) continue;
    seen.add(termKo);
    const score = Number(entry.weight ?? entry.score ?? entry.count);
    const weight = Number.isFinite(score) && score > 0 ? score : Math.max(1, limit - keywords.length);
    const defaultUrl = `https://www.google.com/search?q=${encodeURIComponent(termKo)}&tbm=nws&hl=ko&gl=KR&ceid=KR%3Ako`;
    let url = defaultUrl;
    try {
      const supplied = new URL(entry.search?.ko);
      if (['https:', 'http:'].includes(supplied.protocol)) url = supplied.href;
    } catch { /* Use the existing Korean news search behavior. */ }
    keywords.push({ term: entry.term || termKo, term_ko: termKo, weight, search: { ko: url } });
    if (keywords.length >= limit) break;
  }
  if (!keywords.length) throw new Error('No Korean keywords in data/tags.json; generate tags with GPT_API first.');
  return {
    generatedAt: tags.metadata?.generated_at || tags.generatedAt || tags.generated_at || tags.date || null,
    language: 'ko',
    source: 'data/tags.json',
    keywords
  };
}

export async function writeKeywordSnapshot(root = ROOT) {
  const tags = JSON.parse(await readFile(path.join(root, 'data/tags.json'), 'utf8'));
  const snapshot = buildKeywordSnapshot(tags);
  await writeFile(path.join(root, 'keyword.json'), JSON.stringify(snapshot, null, 2) + '\n');
  return snapshot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeKeywordSnapshot();
  console.log('[keywords] Generated keyword.json');
}
