#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const KEYWORDS_PATH = path.resolve(__dirname, '../data/finance_keywords.json');
const MAX_KEYWORDS = Number(process.env.MAX_FINANCE_KEYWORDS || 20000);

const allowedPattern = /[\p{Script=Hangul}A-Za-z]/u;
const invalidCharPattern = /[^\p{Script=Hangul}A-Za-z0-9\s&+%\-.,'"“”’()/·∙•:]/u;
const repeatingCharPattern = /(.)\1{3,}/u;

function loadKeywords(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.finance_keywords)) {
    throw new Error('finance_keywords.json must contain a finance_keywords array.');
  }
  return parsed.finance_keywords.map((value) => (typeof value === 'string' ? value : ''));
}

function normalizeForDedup(keyword) {
  return keyword
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function cleanKeyword(keyword) {
  return keyword.replace(/\s+/g, ' ').trim();
}

function isValidKeyword(keyword, stats) {
  const cleaned = cleanKeyword(keyword);
  if (!cleaned) {
    stats.blanks += 1;
    return false;
  }

  const letters = cleaned.match(/[\p{Script=Hangul}A-Za-z]/gu) || [];
  if (letters.length < 2) {
    stats.tooShort += 1;
    return false;
  }

  if (cleaned.length < 2) {
    stats.tooShort += 1;
    return false;
  }

  if (cleaned.split(/\s+/).filter(Boolean).length > 6) {
    stats.tooLong += 1;
    return false;
  }

  if (!allowedPattern.test(cleaned) || invalidCharPattern.test(cleaned)) {
    stats.invalidChars += 1;
    return false;
  }

  if (/https?:\/\//i.test(cleaned)) {
    stats.invalidChars += 1;
    return false;
  }

  if (repeatingCharPattern.test(cleaned.replace(/\s+/g, ''))) {
    stats.gibberish += 1;
    return false;
  }

  const digits = (cleaned.match(/\d/g) || []).length;
  if (digits && digits / cleaned.replace(/\s+/g, '').length > 0.6) {
    stats.gibberish += 1;
    return false;
  }

  return true;
}

function trimKeywords(keywords) {
  const stats = {
    blanks: 0,
    tooShort: 0,
    tooLong: 0,
    invalidChars: 0,
    gibberish: 0,
    duplicates: 0,
    kept: 0,
  };

  const seen = new Set();
  const result = [];

  for (let i = keywords.length - 1; i >= 0; i -= 1) {
    const raw = typeof keywords[i] === 'string' ? keywords[i] : '';
    const cleaned = cleanKeyword(raw);
    if (!isValidKeyword(cleaned, stats)) {
      continue;
    }

    const normalized = normalizeForDedup(cleaned);
    if (!normalized) {
      stats.gibberish += 1;
      continue;
    }

    if (seen.has(normalized)) {
      stats.duplicates += 1;
      continue;
    }

    seen.add(normalized);
    result.push(cleaned);
  }

  result.reverse();
  const limited = result.slice(-MAX_KEYWORDS);
  stats.kept = limited.length;

  return { keywords: limited, stats };
}

function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const keywords = loadKeywords(KEYWORDS_PATH);
  const originalCount = keywords.length;

  const { keywords: trimmed, stats } = trimKeywords(keywords);
  const finalCount = trimmed.length;

  const payload = { finance_keywords: trimmed };
  const output = `${JSON.stringify(payload, null, 2)}\n`;

  if (!isDryRun) {
    fs.writeFileSync(KEYWORDS_PATH, output);
  }

  console.log('finance_keywords.json trimming summary:');
  console.log(`  Original entries: ${originalCount}`);
  console.log(`  Kept entries: ${finalCount}`);
  console.log(`  Removed blanks: ${stats.blanks}`);
  console.log(`  Removed too-short/too-long: ${stats.tooShort + stats.tooLong}`);
  console.log(`  Removed invalid chars: ${stats.invalidChars}`);
  console.log(`  Removed gibberish: ${stats.gibberish}`);
  console.log(`  Removed duplicates: ${stats.duplicates}`);
  if (finalCount > MAX_KEYWORDS) {
    console.log(`  ⚠️  Result still exceeds ${MAX_KEYWORDS} entries; check filtering rules.`);
  }
  if (isDryRun) {
    console.log('  (Dry run: no changes written)');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('Failed to trim finance keywords:', err);
    process.exitCode = 1;
  }
}

