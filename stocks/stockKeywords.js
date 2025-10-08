/**
 * stockKeywords.js — Final
 * TF-IDF + Naver Trends + Finance Dict + Semantic Boost + External Stopwords
 */

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const crypto = require("crypto");

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const OUTPUT_PATH = "./data/tags.json";
const FINANCE_DICT_PATH = "./data/finance_keywords.json";
const STOPWORDS_PATH = "./data/stopwords.txt";
const ARTICLE_DIRS = ["./news", "./articles"];
const LOOKBACK_HOURS = 12;
const KEYWORD_LIMIT = 30;

// Stopword management
const STOPWORD_STATS_PATH = "./data/stopword_stats.json";
const PRUNE_INTERVAL = 10;

// CLI flag
const args = process.argv.slice(2);
const FORCE_RESET = args.includes("--reset-stopwords");

// 🧩 Load Stopwords dynamically
function loadStopwords() {
  if (fs.existsSync(STOPWORDS_PATH)) {
    return new Set(
      fs
        .readFileSync(STOPWORDS_PATH, "utf8")
        .split(/\r?\n/)
        .map((w) => w.trim())
        .filter(Boolean)
    );
  }
  // Fallback built-in set
  return new Set([
    "으로", "에서", "에게", "하고", "그리고", "하지만", "또한", "그런데",
    "때문에", "위해", "대한", "관련", "통해", "이후", "현재", "있다",
    "된다", "등", "및", "것", "수", "중", "같은",
    "and", "or", "the", "in", "on", "of", "to", "for", "with", "as", "by",
    "that", "is", "are", "be", "from", "it", "its", "at", "an", "was",
    "this", "these", "those", "a", "their", "they"
  ]);
}
const STOPWORDS = loadStopwords();

// Optional reset flag
if (FORCE_RESET && fs.existsSync(STOPWORDS_PATH)) {
  const baseWords = Array.from(STOPWORDS).slice(0, 50);
  fs.writeFileSync(STOPWORDS_PATH, baseWords.join("\n"));
  console.log("🧹 Stopwords reset (kept core 50 common words)");
}

function loadStopwordStats() {
  if (fs.existsSync(STOPWORD_STATS_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(STOPWORD_STATS_PATH, "utf8"));
    } catch {
      return { runs: 0, counts: {} };
    }
  }
  return { runs: 0, counts: {} };
}

function saveStopwordStats(stats) {
  fs.writeFileSync(STOPWORD_STATS_PATH, JSON.stringify(stats, null, 2));
}

function cosineSimilarity(a, b) {
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  const mag = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0));
  return mag(a) && mag(b) ? dot / (mag(a) * mag(b)) : 0;
}
function vectorize(str) {
  const hash = crypto.createHash("sha256").update(str).digest();
  return Array.from({ length: 16 }, (_, i) => hash[i] / 255);
}
function isStopwordToken(t) {
  return STOPWORDS.has(t.toLowerCase());
}

// ---- NAVER API ----
async function fetchNaverTrends() {
  try {
    const url = "https://openapi.naver.com/v1/datalab/search";
    const today = new Date().toISOString().split("T")[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
    const body = {
      startDate: weekAgo,
      endDate: today,
      timeUnit: "date",
      keywordGroups: [
        { groupName: "금융", keywords: ["주식", "증시", "금리", "환율", "채권", "ETF"] },
      ],
    };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Naver-Client-Id": NAVER_CLIENT_ID,
        "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`NAVER API error: ${res.statusText}`);
    const data = await res.json();
    fs.writeFileSync("./data/naver-trends.json", JSON.stringify(data, null, 2));
    console.log("✅ Updated Naver finance trends");
    return data;
  } catch (err) {
    console.warn("⚠️ Naver API skipped:", err.message);
    return null;
  }
}

// ---- PHRASE EXTRACTION ----
function extractPhrasesFromText(text, minLen = 2, maxLen = 4) {
  const tokens = text
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !isStopwordToken(t));
  const phrases = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let len = minLen; len <= maxLen; len++) {
      const slice = tokens.slice(i, i + len);
      if (slice.length === len && !slice.some(isStopwordToken))
        phrases.push(slice.join(" "));
    }
  }
  return phrases;
}

function collectArticles() {
  const texts = [];
  for (const dir of ARTICLE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".txt") || f.endsWith(".md"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), "utf8");
      texts.push(content);
    }
  }
  return texts;
}

function computeTfIdfPhrases(texts, topN = 100) {
  const tf = {}, df = {};
  texts.forEach((text) => {
    const phrases = extractPhrasesFromText(text);
    const seen = new Set();
    phrases.forEach((p) => {
      tf[p] = (tf[p] || 0) + 1;
      if (!seen.has(p)) {
        df[p] = (df[p] || 0) + 1;
        seen.add(p);
      }
    });
  });
  const N = texts.length || 1;
  const scores = Object.entries(tf).map(([phrase, freq]) => {
    const idf = Math.log((N + 1) / ((df[phrase] || 1) + 1)) + 1;
    return [phrase, freq * idf];
  });
  scores.sort((a, b) => b[1] - a[1]);
  const phrases = scores.slice(0, topN).map(([term, score]) => ({
    term,
    term_ko: term,
    significance_score: score,
    mentions: tf[term],
    combined_score: score,
    sources: ["tfidf"],
    finance_boost: 0,
    context: {},
  }));

  // --- Learn and prune stopwords dynamically ---
  const stats = loadStopwordStats();
  stats.runs += 1;

  Object.entries(tf).forEach(([t, f]) => {
    stats.counts[t] = (stats.counts[t] || 0) + f;
  });

  const avgFreq =
    Object.keys(tf).length === 0
      ? 0
      : Object.values(tf).reduce((a, b) => a + b, 0) / Object.keys(tf).length;
  const frequent = Object.entries(tf)
    .filter(([_, f]) => f > avgFreq * 3)
    .map(([t]) => t)
    .filter((t) => !STOPWORDS.has(t));

  if (frequent.length > 0) {
    console.log(`🧠 Learned ${frequent.length} new stopwords`);
    fs.appendFileSync(STOPWORDS_PATH, "\n" + frequent.join("\n"));
    frequent.forEach((t) => STOPWORDS.add(t));
  }

  if (stats.runs % PRUNE_INTERVAL === 0) {
    const threshold = 2;
    const surviving = [...STOPWORDS].filter((t) => (stats.counts[t] || 0) >= threshold);
    fs.writeFileSync(STOPWORDS_PATH, surviving.join("\n"));
    console.log(`✂️ Pruned stopwords: ${STOPWORDS.size - surviving.length}`);
    STOPWORDS.clear();
    surviving.forEach((t) => STOPWORDS.add(t));
    stats.runs = 0;
    stats.counts = {};
  }

  saveStopwordStats(stats);

  return phrases;
}

// ---- MAIN ----
async function generateKeywords() {
  console.log("🚀 Generating tags.json ...");
  const trends = await fetchNaverTrends();
  const trendSet = new Set();
  if (trends?.results?.[0]?.data)
    trends.results[0].data.forEach((d) => trendSet.add(d.title || d.period));

  const financeDict = JSON.parse(fs.readFileSync(FINANCE_DICT_PATH, "utf8")).finance_keywords;
  const articles = collectArticles();
  let discovered_keywords = computeTfIdfPhrases(articles, 150);

  // Finance boost
  for (const kw of discovered_keywords) {
    const text = kw.term_ko.toLowerCase();
    const matches = financeDict.filter((f) => text.includes(f));
    kw.finance_boost = matches.length * 10;
    kw.combined_score += kw.finance_boost / 100;
  }

  // Semantic + Trend rerank
  const themes = [
    "금리 인상 인하 환율",
    "AI 반도체 전기차 로봇",
    "에너지 유가 원자재 수출입",
    "미국 증시 코스피 코스닥",
    "경기 회복 둔화 인플레이션",
    "투자 심리 기관 외국인 수급",
  ].map((t) => ({ text: t, vec: vectorize(t) }));

  for (const kw of discovered_keywords) {
    const v = vectorize(kw.term_ko);
    const sim = Math.max(...themes.map((th) => cosineSimilarity(v, th.vec)));
    kw.semantic_score = sim;
    if (sim > 0.8) kw.combined_score *= 1.5;
    else if (sim > 0.6) kw.combined_score *= 1.3;
    for (const t of trendSet) if (kw.term_ko.includes(t)) kw.combined_score *= 1.2;
  }

  // Finalize
  const seen = new Set();
  discovered_keywords = discovered_keywords.filter((k) => {
    if (seen.has(k.term_ko)) return false;
    seen.add(k.term_ko);
    return true;
  });
  discovered_keywords.forEach((k) => {
    k.final_score =
      k.combined_score * 0.5 +
      k.significance_score * 0.3 +
      (k.semantic_score || 0) * 100 * 0.2;
  });
  discovered_keywords.sort((a, b) => b.final_score - a.final_score);
  discovered_keywords = discovered_keywords.slice(0, KEYWORD_LIMIT);

  const result = {
    date: new Date().toISOString().split("T")[0],
    window: `${LOOKBACK_HOURS}_hours`,
    total_phrases: discovered_keywords.length,
    discovered_keywords,
    metadata: {
      collection_method: "semantic_tfidf_trend",
      phrase_length: "2-4 words",
      scoring: "semantic_hybrid",
      generated_at: new Date().toISOString(),
      keyword_limit: KEYWORD_LIMIT,
      lookback_hours: LOOKBACK_HOURS,
    },
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(`✅ Saved ${discovered_keywords.length} tags to ${OUTPUT_PATH}`);

  // --- Trend tracking ---
  const TREND_LOG_PATH = "./data/trend_log.json";
  let trendLog = [];
  if (fs.existsSync(TREND_LOG_PATH)) {
    try {
      trendLog = JSON.parse(fs.readFileSync(TREND_LOG_PATH, "utf8"));
    } catch {
      trendLog = [];
    }
  }

  // Compare with last run
  const prev = trendLog.length ? trendLog[trendLog.length - 1] : null;
  const trendEntry = {
    date: result.date,
    top_terms: discovered_keywords.map((k) => ({
      term: k.term,
      score: k.final_score,
    })),
  };

  if (prev) {
    const prevScores = Object.fromEntries(prev.top_terms.map((t) => [t.term, t.score]));
    trendEntry.changes = discovered_keywords.map((k) => {
      const diff = prevScores[k.term]
        ? (k.final_score - prevScores[k.term]).toFixed(2)
        : "+new";
      return { term: k.term, delta: diff };
    });

    const rising = trendEntry.changes
      .filter((c) => c.delta !== "+new" && Number(c.delta) > 5)
      .map((c) => c.term);
    const falling = trendEntry.changes
      .filter((c) => c.delta !== "+new" && Number(c.delta) < -5)
      .map((c) => c.term);

    if (rising.length || falling.length) {
      console.log(`📈 Rising: ${rising.join(", ")}`);
      console.log(`📉 Falling: ${falling.join(", ")}`);
    }
  }

  // Keep last 10 trend logs
  trendLog.push(trendEntry);
  if (trendLog.length > 10) trendLog = trendLog.slice(-10);
  fs.writeFileSync(TREND_LOG_PATH, JSON.stringify(trendLog, null, 2));
  console.log("🪄 Updated trend_log.json");

  // --- Export to CSV ---
  const CSV_PATH = "./data/keyword_trends.csv";
  const csvLines = ["date,term,score"];
  trendLog.forEach((entry) => {
    entry.top_terms.forEach((t) => {
      csvLines.push(`${entry.date},"${t.term}",${t.score}`);
    });
  });
  fs.writeFileSync(CSV_PATH, csvLines.join("\n"));
  console.log("📊 Exported keyword_trends.csv");
}

generateKeywords().catch((err) => console.error("❌ Generation failed:", err));
