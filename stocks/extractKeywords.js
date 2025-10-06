import fs from "fs";
import natural from "natural";
import sw from "stopword";
import pos from "pos";
import financeDict from "./data/finance_keywords.json" assert { type: "json" };

const tags = JSON.parse(fs.readFileSync("./stocks/data/tags.json", "utf-8"));

const OUTPUT_FILE = "./stocks/data/output_keywords.json";
const MAX_TERMS = 30;
const HANGUL_REGEX = /[\u3131-\u318E\uAC00-\uD7A3]/;
const stopwordSet = new Set(sw.en || []);
const lexer = new pos.Lexer();
const tagger = new pos.Tagger();
const financeKeywords = Array.isArray(financeDict?.finance_keywords)
  ? financeDict.finance_keywords
      .map((k) => (typeof k === "string" ? k.trim().toLowerCase() : ""))
      .filter(Boolean)
  : [];

const documents = Array.isArray(tags?.discovered_keywords) ? tags.discovered_keywords : [];

function normalizeTimestamp(raw) {
  if (!raw) {
    return Date.now();
  }
  const parsed = typeof raw === "number" ? raw : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isNounToken(token, tag) {
  if (!token) return false;
  if (HANGUL_REGEX.test(token)) {
    return true;
  }
  if (!tag) return false;
  return tag.startsWith("NN") || tag === "FW" || tag === "JJ" || tag === "CD";
}

function cleanToken(token) {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function trendBoost(timestamp) {
  const hours = (Date.now() - timestamp) / 36e5;
  if (hours < 6) return 1.5;
  if (hours < 12) return 1.2;
  return 1.0;
}

function getFinanceBoost(term) {
  if (!term) return 1.0;
  const lower = term.toLowerCase();
  const hasFinanceMatch = financeKeywords.some((keyword) =>
    keyword && lower.includes(keyword)
  );
  return hasFinanceMatch ? 3.0 : 1.0;
}

function prepareDocumentTerms(text) {
  if (!text || typeof text !== "string") {
    return [];
  }

  const lexTokens = lexer.lex(text);
  const taggedTokens = tagger.tag(lexTokens);

  const processed = [];

  for (const [word, tag] of taggedTokens) {
    const cleaned = cleanToken(word);
    if (!cleaned) continue;
    const lower = cleaned.toLowerCase();
    if (stopwordSet.has(lower)) continue;
    const noun = isNounToken(cleaned, tag);
    processed.push({
      word: cleaned,
      lower,
      tag,
      noun,
    });
  }

  return processed;
}

function buildPhraseStats() {
  const phraseStats = new Map();
  const tfidf = new natural.TfIdf();

  documents.forEach((entry, index) => {
    const text = entry?.term_ko || entry?.term || "";
    const mentions = Number(entry?.mentions) || 1;
    const timestamp = normalizeTimestamp(
      entry?.timestamp || entry?.time || entry?.generated_at || entry?.date || tags?.metadata?.generated_at
    );
    const tokens = prepareDocumentTerms(text);

    if (!tokens.length) {
      return;
    }

    const ngrams = [];
    const totalTokens = tokens.length;

    for (let i = 0; i < totalTokens; i += 1) {
      const window = [];
      for (let j = i; j < Math.min(i + 3, totalTokens); j += 1) {
        window.push(tokens[j]);
        const length = window.length;
        if (length < 1 || length > 3) continue;
        if (!window.some((token) => token.noun)) continue;
        const phrase = window.map((token) => token.word).join(" ");
        const normalized = phrase.toLowerCase();
        ngrams.push({ phrase, normalized });
      }
    }

    if (!ngrams.length) {
      return;
    }

    const counts = new Map();
    const docTokensForTfidf = [];

    for (const { phrase, normalized } of ngrams) {
      const tokenKey = normalized.replace(/\s+/g, "_");
      const prev = counts.get(tokenKey) || { count: 0, display: phrase, normalized };
      prev.count += 1;
      if (!prev.display || prev.display.length < phrase.length) {
        prev.display = phrase;
      }
      prev.normalized = normalized;
      counts.set(tokenKey, prev);
    }

    for (const [tokenKey, { count }] of counts.entries()) {
      for (let i = 0; i < count; i += 1) {
        docTokensForTfidf.push(tokenKey);
      }
    }

    tfidf.addDocument(docTokensForTfidf);

    for (const [tokenKey, { count, display, normalized }] of counts.entries()) {
      if (!phraseStats.has(tokenKey)) {
        phraseStats.set(tokenKey, {
          phrase: display,
          normalized,
          token: tokenKey,
          count: 0,
          mentions: 0,
          docs: new Set(),
          latestTimestamp: 0,
        });
      }
      const stats = phraseStats.get(tokenKey);
      stats.count += count;
      stats.mentions += mentions;
      stats.docs.add(index);
      if (!stats.phrase || display.length > stats.phrase.length) {
        stats.phrase = display;
      }
      stats.latestTimestamp = Math.max(stats.latestTimestamp, timestamp);
    }
  });

  const results = [];

  for (const stats of phraseStats.values()) {
    const docIndices = Array.from(stats.docs);
    let tfidfScore = 0;
    docIndices.forEach((docIndex) => {
      tfidfScore += tfidf.tfidf(stats.token, docIndex) || 0;
    });

    if (!Number.isFinite(tfidfScore)) {
      tfidfScore = 0;
    }

    const financeBoost = getFinanceBoost(stats.phrase);
    const trend = trendBoost(stats.latestTimestamp || Date.now());

    const score =
      0.5 * tfidfScore +
      0.3 * stats.mentions +
      0.2 * financeBoost +
      100 * trend;

    results.push({
      term: stats.phrase,
      score: Number(score.toFixed(4)),
      financeBoost,
      mentions: stats.mentions,
      tfidf: Number(tfidfScore.toFixed(4)),
      latestTimestamp: stats.latestTimestamp,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, MAX_TERMS).map(({ term, score }) => ({ term, score }));
}

function main() {
  const topKeywords = buildPhraseStats();
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(topKeywords, null, 2), "utf-8");
  console.log("✅ Extracted keywords saved to stocks/data/output_keywords.json");
}

main();
