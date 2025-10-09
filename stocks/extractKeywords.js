// extractKeywords.js (refined)
// ESM + POS tagging + semantic boosting + noise filtering

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { TfIdf } = require("natural");
const stopword = require("stopword");
const pos = require("pos");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, "..", "data");
const TAGS_PATH = path.join(DATA_DIR, "tags.json");
const DICT_PATH = path.join(DATA_DIR, "finance_keywords.json");
const OUTPUT_PATH = path.join(DATA_DIR, "output_keywords.json");

function cleanText(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 🧠 Noun phrase extraction (POS)
function extractNounPhrases(text) {
  const words = new pos.Lexer().lex(text);
  const tagger = new pos.Tagger();
  const tagged = tagger.tag(words);
  const phrases = [];
  let current = [];
  for (const [word, tag] of tagged) {
    if (tag.startsWith("NN") || tag.startsWith("JJ")) current.push(word);
    else if (current.length >= 2) {
      phrases.push(current.join(" "));
      current = [];
    } else current = [];
  }
  if (current.length >= 2) phrases.push(current.join(" "));
  return phrases;
}

// 🧹 Filter noisy or overly specific phrases
function isNoisy(phrase) {
  return (
    /\d+/.test(phrase) ||
    /(shares?|co\.?|corp\.?|inc\.?|ltd\.?|company|holding|fund|bond|percent|price)/i.test(
      phrase
    ) ||
    phrase.length < 5 ||
    phrase.split(" ").length > 5
  );
}

// 💡 Semantic boost (finance-related overlap)
function semanticBoost(phrase, financeSet) {
  const words = phrase.split(" ");
  const overlap = words.filter((w) => financeSet.has(w)).length;
  return 1 + overlap * 0.3;
}

async function main() {
  console.log("🚀 Running improved extractKeywords.js");

  const [tagsRaw, dictRaw] = await Promise.all([
    fs.readFile(TAGS_PATH, "utf-8"),
    fs.readFile(DICT_PATH, "utf-8"),
  ]);

  const tags = JSON.parse(tagsRaw);
  const financeDict = JSON.parse(dictRaw);
  const financeKeywords = Array.isArray(financeDict)
    ? financeDict
    : Array.isArray(financeDict.finance_keywords)
    ? financeDict.finance_keywords
    : [];

  if (financeKeywords.length === 0) {
    console.warn(
      "⚠️ finance_keywords.json did not contain a keyword array; continuing with an empty set"
    );
  }

  const financeSet = new Set(financeKeywords.map((w) => w.toLowerCase()));

  const allTexts = [
    ...(tags.discovered_keywords || []),
    ...(tags.keywords || []),
    ...(tags.top_keywords || []),
  ]
    .map((kw) => cleanText(kw.term || kw.term_ko || ""))
    .filter(Boolean);

  // 1️⃣ Extract noun phrases
  const phrases = allTexts.flatMap(extractNounPhrases).filter((p) => !isNoisy(p));

  // 2️⃣ Stopword removal
  const cleaned = phrases
    .map((p) => stopword.removeStopwords(p.split(" ")).join(" "))
    .filter((p) => p.split(" ").length >= 2);

  // 3️⃣ TF-IDF scoring
  const tfidf = new TfIdf();
  cleaned.forEach((doc) => tfidf.addDocument(doc));

  const phraseScores = {};
  cleaned.forEach((phrase) => {
    phrase.split(" ").forEach((term) => {
      tfidf.tfidfs(term, (i, measure) => {
        phraseScores[phrase] = (phraseScores[phrase] || 0) + measure;
      });
    });
  });

  // 4️⃣ Semantic finance boost
  for (const phrase in phraseScores) {
    phraseScores[phrase] *= semanticBoost(phrase, financeSet);
  }

  // 5️⃣ Time-decay weight (prefer recent)
  const generatedAt = new Date(tags.metadata?.generated_at || Date.now());
  const ageHours = (Date.now() - generatedAt.getTime()) / 3600000;
  const timeWeight = Math.max(0.5, 1 - ageHours / 48);
  for (const phrase in phraseScores) {
    phraseScores[phrase] *= timeWeight;
  }

  // 6️⃣ Sort + deduplicate semantically similar
  const sorted = Object.entries(phraseScores)
    .sort((a, b) => b[1] - a[1])
    .map(([term, score]) => ({ term, score: +score.toFixed(3) }));

  const seen = new Set();
  const final = [];
  for (const { term, score } of sorted) {
    const key = term.replace(/\s+/g, "").toLowerCase();
    if (![...seen].some((k) => key.includes(k) || k.includes(key))) {
      seen.add(key);
      final.push({ term, score });
    }
    if (final.length >= 30) break;
  }

  const output = {
    date: new Date().toISOString().split("T")[0],
    generated_at: new Date().toISOString(),
    total_phrases: final.length,
    analyzed_from: path.basename(TAGS_PATH),
    finance_keywords_used: financeSet.size,
    keywords: final,
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  console.log(`✅ Wrote refined keywords to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("❌ extractKeywords.js failed:", err);
  process.exit(1);
});
