/**
 * stockKeywords.js — Final
 * TF-IDF + Naver Trends + Finance Dict + Semantic Boost + External Stopwords
 */

const fs = require("fs");
const fetch = require("node-fetch");
const crypto = require("crypto");
const cheerio = require("cheerio");

// Reusable headers for portals that gate on UA
const UA_HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" };

// URL/fragment filters
const URL_RE = /https?:\/\/\S+/gi;
const BAD_FRAGMENT = new Set([
  "http","https","www","co","kr","com","net","org","news","article","mnews","idxno","html",
  "view","read","amp","utm","ref","story","mobile","sid","aid"
]);

const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const OUTPUT_PATH = "./data/tags.json";
const FINANCE_DICT_PATH = "./data/finance_keywords.json";
const STOPWORDS_PATH = "./data/stopwords.txt";
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

function looksUrlishToken(t) {
  // reject tokens with dots/slashes or that are obvious url/path crumbs
  return /\//.test(t) || /\./.test(t) || BAD_FRAGMENT.has(t.toLowerCase());
}

function isGoodSingleWord(t) {
  // Allow 1-word “keywords” if they are Hangul (≥2 chars) or ≥3 ascii letters
  if (/[가-힣]{2,}/.test(t)) return true;
  if (/^[A-Za-z]{3,}$/.test(t)) return true;
  return false;
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
    console.warn("⚠️ Naver API failed, falling back to Nate:", err.message);

    try {
      // Fetch Nate news (mobile version is simpler)
      const html = await fetch("https://m.news.nate.com/section?mid=m02&sq=1138989", {
        headers: UA_HEADERS,
      }).then((r) => r.text());

      // Extract top article titles
      const matches = [...html.matchAll(/<strong[^>]*>([^<]+)<\/strong>/g)];
      const trending = matches.map((m) => m[1].trim()).filter(Boolean).slice(0, 10);

      const backup = {
        source: "nate.com",
        results: [
          {
            title: "Nate Trends",
            data: trending.map((title, i) => ({ rank: i + 1, title })),
          },
        ],
      };

      fs.writeFileSync("./data/nate-trends.json", JSON.stringify(backup, null, 2));
      console.log(`✅ Fallback: saved ${trending.length} Nate trends`);

      // 🔁 Inject Nate trends into TF-IDF scoring later
      if (globalThis.__trend_terms == null) globalThis.__trend_terms = [];
      globalThis.__trend_terms.push(...trending);

      return backup;
    } catch (err2) {
      console.warn("❌ Nate backup also failed:", err2.message);
      return null;
    }
  }
}

async function fetchNaverSearchFromFinanceDict() {
  console.log("🌐 Fetching Naver search results from finance_keywords.json ...");
  const headers = {
    "X-Naver-Client-Id": NAVER_CLIENT_ID,
    "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
  };

  // Load finance keywords dynamically
  const financeDict = JSON.parse(fs.readFileSync(FINANCE_DICT_PATH, "utf8")).finance_keywords;
  // 🔁 Randomly sample 40 keywords per run for variety
  const shuffled = financeDict.sort(() => 0.5 - Math.random());
  const keywords = shuffled.slice(0, 40);
  console.log(`🎯 Using ${keywords.length} random finance keywords (e.g., ${keywords.slice(0, 5).join(", ")} ...)`);

  const texts = [];

  for (const kw of keywords) {
    for (const type of ["webkr", "blog", "news"]) {
      const url = `https://openapi.naver.com/v1/search/${type}.json?query=${encodeURIComponent(kw)}&display=10&sort=date`;
      try {
        const res = await fetch(url, { headers });
        if (!res.ok) {
          console.warn(`⚠️ Naver ${type} search failed for ${kw}: ${res.statusText}`);
          continue;
        }
        const data = await res.json();
        const items = data.items || [];
        items.forEach((item) => {
          const text = `${item.title || ""} ${item.description || ""}`;
          const cleaned = text
            .replace(/<[^>]+>/g, " ")
            .replace(/https?:\/\/\S+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          if (cleaned.length > 10) texts.push(cleaned);
        });
        await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
      } catch (err) {
        console.warn(`⚠️ Naver ${type} search error for ${kw}:`, err.message);
      }
    }
  }

  console.log(`🌐 Collected ${texts.length} items from Naver Search (finance keywords)`);
  return texts;
}

async function fetchDaumNews() {
  // mobile endpoint renders server-side
  const url = "https://m.news.daum.net/breakingnews/economic";
  try {
    const res = await fetch(url, { headers: UA_HEADERS });
    if (!res.ok) throw new Error(`Daum fetch failed: ${res.statusText}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const headlines = [];
    $("a.link_news, strong.tit_thumb, a.link_txt").each((i, el) => {
      const title = $(el).text().trim();
      if (title.length > 5) headlines.push(title);
    });
    console.log(`📰 Daum headlines: ${headlines.length}`);
    if (!headlines.length) console.warn("⚠️ Daum HTML sample:", html.slice(0, 200));
    return headlines;
  } catch (err) {
    console.warn("⚠️ Daum news fetch failed:", err.message);
    return [];
  }
}

async function fetchNateNews() {
  const url = "https://m.news.nate.com/section?mid=m02";
  try {
    const res = await fetch(url, { headers: UA_HEADERS });
    if (!res.ok) throw new Error(`Nate fetch failed: ${res.statusText}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const headlines = [];
    // try multiple possible containers
    $("strong.tit a, a.tit, div.mduSubject a").each((i, el) => {
      const title = $(el).text().trim();
      if (title.length > 5) headlines.push(title);
    });
    console.log(`📰 Nate headlines: ${headlines.length}`);
    if (!headlines.length) console.warn("⚠️ Nate HTML sample:", html.slice(0, 200));
    return headlines;
  } catch (err) {
    console.warn("⚠️ Nate news fetch failed:", err.message);
    return [];
  }
}

async function fetchZumNews() {
  const url = "https://m.news.zum.com/home";
  try {
    const res = await fetch(url, { headers: UA_HEADERS });
    if (!res.ok) throw new Error(`Zum fetch failed: ${res.statusText}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const headlines = [];
    $("a.item-desc, .headline a, .item-title, strong.tit a").each((i, el) => {
      const title = $(el).text().trim();
      if (title.length > 5) headlines.push(title);
    });
    console.log(`📰 Zum headlines: ${headlines.length}`);
    if (!headlines.length) console.warn("⚠️ Zum HTML sample:", html.slice(0, 200));
    return headlines;
  } catch (err) {
    console.warn("⚠️ Zum news fetch failed:", err.message);
    return [];
  }
}

async function fetchMkNews() {
  const url = "https://m.mk.co.kr";
  try {
    const res = await fetch(url, { headers: UA_HEADERS });
    if (!res.ok) throw new Error(`MK fetch failed: ${res.statusText}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const headlines = [];
    // wider net for MK mobile
    $("a.news_ttl, a.headline, .news_item a, .tit a, .list_area a").each((i, el) => {
      const title = $(el).text().trim();
      if (title.length > 5) headlines.push(title);
    });
    console.log(`📰 MK headlines: ${headlines.length}`);
    if (!headlines.length) console.warn("⚠️ MK HTML sample:", html.slice(0, 200));
    return headlines;
  } catch (err) {
    console.warn("⚠️ MK news fetch failed:", err.message);
    return [];
  }
}

async function fetchHankyungNews() {
  const url = "https://m.hankyung.com/economy";
  try {
    const res = await fetch(url, { headers: UA_HEADERS });
    if (!res.ok) throw new Error(`Hankyung fetch failed: ${res.statusText}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const headlines = [];
    $("a.news-tit, a.link_news, .article_tit a, .news_list a").each((i, el) => {
      const title = $(el).text().trim();
      if (title.length > 5) headlines.push(title);
    });
    console.log(`📰 Hankyung headlines: ${headlines.length}`);
    if (!headlines.length) console.warn("⚠️ Hankyung HTML sample:", html.slice(0, 200));
    return headlines;
  } catch (err) {
    console.warn("⚠️ Hankyung news fetch failed:", err.message);
    return [];
  }
}

async function fetchChosunBizNews() {
  const url = "https://biz.chosun.com/";
  try {
    const res = await fetch(url, { headers: UA_HEADERS });
    if (!res.ok) throw new Error(`ChosunBiz fetch failed: ${res.statusText}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const headlines = [];
    $("h2.news_ttl a, div.list_item a.tit, a.link_txt, .story-card a").each((i, el) => {
      const title = $(el).text().trim();
      if (title.length > 5) headlines.push(title);
    });
    console.log(`📰 ChosunBiz headlines: ${headlines.length}`);
    if (!headlines.length) console.warn("⚠️ ChosunBiz HTML sample:", html.slice(0, 200));
    return headlines;
  } catch (err) {
    console.warn("⚠️ ChosunBiz news fetch failed:", err.message);
    return [];
  }
}

async function fetchYonhapNews() {
  const url = "https://m.yna.co.kr/economy/all";
  try {
    const res = await fetch(url, { headers: UA_HEADERS });
    if (!res.ok) throw new Error(`Yonhap fetch failed: ${res.statusText}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const headlines = [];
    $("strong.tit-news a, div.list-type038 a, .list-type023 a").each((i, el) => {
      const title = $(el).text().trim();
      if (title.length > 5) headlines.push(title);
    });
    console.log(`📰 Yonhap headlines: ${headlines.length}`);
    if (!headlines.length) console.warn("⚠️ Yonhap HTML sample:", html.slice(0, 200));
    return headlines;
  } catch (err) {
    console.warn("⚠️ Yonhap news fetch failed:", err.message);
    return [];
  }
}

// ---- PHRASE EXTRACTION ----
function extractPhrasesFromText(text, minLen = 1, maxLen = 4) {
  // Strip URLs first, then normalize and split
  const tokens = text
    .replace(URL_RE, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => {
      if (!t) return false;
      if (t.length <= 1) return false;             // too short
      if (/^\d+$/.test(t)) return false;           // pure numbers
      if (looksUrlishToken(t)) return false;       // url/path crumbs
      if (isStopwordToken(t)) return false;        // external stopwords
      // For single-word phrases we will re-check via isGoodSingleWord later
      return true;
    });
  const phrases = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let len = minLen; len <= maxLen; len++) {
      const slice = tokens.slice(i, i + len);
      if (slice.length === len && !slice.some(isStopwordToken)) {
        if (len === 1 && !isGoodSingleWord(slice[0])) continue;
        phrases.push(slice.join(" "));
      }
    }
  }
  return phrases;
}

// ---- NAVER NEWS COLLECTOR ----
async function collectArticles() {
  console.log("📰 Fetching articles directly from Naver API...");
  const queries = ["주식", "증시", "금리", "환율", "ETF", "반도체", "미국 증시"];
  const headers = {
    "X-Naver-Client-Id": NAVER_CLIENT_ID,
    "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
  };
  let texts = [];

  for (const q of queries) {
    try {
      const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(q)}&display=20&sort=date`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        console.warn(`⚠️ Naver search for '${q}' failed (${res.status})`);
        continue;
      }
      const data = await res.json();
      const items = data.items || [];
      items.forEach(item => {
        // DO NOT include item.link; strip HTML tags and URLs from text
        const text = [item.title || "", item.description || ""].join(" ");
        const cleaned = text
          .replace(/<[^>]+>/g, " ")
          .replace(URL_RE, " ");
        if (cleaned.trim()) texts.push(cleaned.trim());
      });
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.warn(`⚠️ Failed fetching Naver articles for ${q}:`, err.message);
    }
  }

  const financeDictTexts = await fetchNaverSearchFromFinanceDict();
  if (financeDictTexts.length) {
    texts.push(...financeDictTexts);
  }

  if (texts.length === 0) console.warn("⚠️ No Naver articles collected, continuing with empty set");
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
    .filter((t) => !STOPWORDS.has(t))
    // never learn URLish or 1-word junk as stopwords
    .filter((t) => !looksUrlishToken(t) && (t.includes(" ") || isGoodSingleWord(t)));

  if (frequent.length > 0) {
    const toAdd = frequent.slice(0, 50); // cap growth per run
    console.log(`🧠 Learned ${toAdd.length} new stopwords (capped)`);
    fs.appendFileSync(STOPWORDS_PATH, "\n" + toAdd.join("\n"));
    toAdd.forEach((t) => STOPWORDS.add(t));
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
  // 🔹 Collect backup headlines from major Korean portals
  const [daum, nate, zum, mk, hankyung, chosun, yonhap] = await Promise.all([
    fetchDaumNews(),
    fetchNateNews(),
    fetchZumNews(),
    fetchMkNews(),
    fetchHankyungNews(),
    fetchChosunBizNews(),
    fetchYonhapNews(),
  ]);

  const backupHeadlines = [
    ...daum,
    ...nate,
    ...zum,
    ...mk,
    ...hankyung,
    ...chosun,
    ...yonhap,
  ];

  if (backupHeadlines.length) {
    console.log(
      `🧩 Added ${backupHeadlines.length} fallback headlines (Daum/Nate/Zum/MK/Hankyung/ChosunBiz/Yonhap)`
    );
  }
  const trendSet = new Set();
  if (trends?.results?.[0]?.data)
    trends.results[0].data.forEach((d) => trendSet.add(d.title || d.period));

  const financeDict = JSON.parse(fs.readFileSync(FINANCE_DICT_PATH, "utf8")).finance_keywords;
  const articles = await collectArticles();
  // Merge portal headlines into the corpus
  articles.push(...backupHeadlines.map(t => t.replace(URL_RE, " ").trim()).filter(Boolean));
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

  // 🔁 Include Nate backup keywords if available
  const extraTrends = (globalThis.__trend_terms || []).slice(0, 10);
  if (extraTrends.length) {
    console.log(`💡 Including ${extraTrends.length} Nate trends in weighting`);
    themes.push(...extraTrends.map((t) => ({ text: t, vec: vectorize(t) })));
  }

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
