// extractKeywords.js
// ESM version — Node.js 20+
// Goal: analyze tags.json using finance keyword dictionary, without overwriting tags.json

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import natural from "natural";
import stopword from "stopword";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TAGS_PATH = path.resolve(__dirname, "data", "tags.json");
const DICT_PATH = path.resolve(__dirname, "data", "finance_keywords.json");
const OUTPUT_PATH = path.resolve(__dirname, "data", "output_keywords.json");

// ---- helper functions ----
function cleanText(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPhrases(text, minWords = 2, maxWords = 4) {
  const words = text.split(/\s+/).filter(Boolean);
  const phrases = [];
  for (let i = 0; i < words.length; i++) {
    for (let j = minWords; j <= maxWords; j++) {
      if (i + j <= words.length) {
        const phrase = words.slice(i, i + j).join(" ");
        phrases.push(phrase);
      }
    }
  }
  return phrases;
}

// ---- main workflow ----
async function main() {
  console.log("📈 Starting extractKeywords.js");

  const [tagsRaw, dictRaw] = await Promise.all([
    fs.readFile(TAGS_PATH, "utf-8"),
    fs.readFile(DICT_PATH, "utf-8")
  ]);

  const tags = JSON.parse(tagsRaw);
  const financeDict = JSON.parse(dictRaw);
  const financeWords = Array.isArray(financeDict)
    ? financeDict
    : Array.isArray(financeDict.finance_keywords)
      ? financeDict.finance_keywords
      : [];

  // prepare text corpus from tags.json
  const docs = [];
  const allTexts = [];

  const keywords = [
    ...(tags.discovered_keywords || []),
    ...(tags.keywords || []),
    ...(tags.top_keywords || [])
  ];

  for (const kw of keywords) {
    const text = cleanText(kw.term || kw.term_ko || "");
    if (!text) continue;
    allTexts.push(text);
  }

  const allPhrases = allTexts.flatMap(t => extractPhrases(t));
  const filtered = allPhrases.filter(p => p.split(" ").length <= 4 && p.split(" ").length >= 2);
  const stopRemoved = filtered.map(p => stopword.removeStopwords(p.split(" ")).join(" "));

  const { TfIdf } = natural;
  const tfidf = new TfIdf();
  stopRemoved.forEach(doc => tfidf.addDocument(doc));

  // compute score per phrase
  const phraseScores = {};
  stopRemoved.forEach((phrase, i) => {
    const terms = phrase.split(" ");
    terms.forEach(term => {
      tfidf.tfidfs(term, (j, measure) => {
        phraseScores[phrase] = (phraseScores[phrase] || 0) + measure;
      });
    });
  });

  // finance boost
  const financeSet = new Set(
    financeWords
      .map(word => (typeof word === "string" ? word.toLowerCase() : ""))
      .filter(Boolean)
  );
  for (const phrase in phraseScores) {
    const hasFinance = phrase.split(" ").some(w => financeSet.has(w));
    if (hasFinance) phraseScores[phrase] *= 1.5;
  }

  // sort and pick top 30
  const sorted = Object.entries(phraseScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([term, score]) => ({
      term,
      score: +score.toFixed(3),
      hasFinanceWord: phraseScores[term] > 0
    }));

  const output = {
    generated_at: new Date().toISOString(),
    total_phrases: sorted.length,
    analyzed_from: path.basename(TAGS_PATH),
    finance_keywords_used: financeSet.size,
    top_keywords: sorted
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  console.log(`✅ Wrote ${sorted.length} analyzed phrases to ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error("❌ extractKeywords.js failed:", err);
  process.exit(1);
});
