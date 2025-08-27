// summarize-news.js
// Creates per-company summaries (no LLM).
// Inputs (read if present): recommendations.json, pools-metrics.json, data/news-features.json
// Outputs: summary.md, summary.json

import fs from "fs";
import path from "path";

const readJSON = (p) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
};

const exists = (p) => fs.existsSync(p);
const root = process.cwd();

const recPath   = path.join(root, "recommendations.json");
const metricsPath = path.join(root, "pools-metrics.json");
const newsFeatPath = path.join(root, "data", "news-features.json");

const rec = readJSON(recPath) || {};
const metrics = readJSON(metricsPath) || {};
const newsFeat = readJSON(newsFeatPath) || {};

const lastUpdated = rec.lastUpdated || new Date().toISOString();

function labelMomentum(n) {
  if (!Number.isFinite(n)) return "unknown";
  if (n >= 15) return "very high";
  if (n >= 8)  return "high";
  if (n >= 4)  return "medium";
  if (n >= 1)  return "low";
  return "none";
}
function labelSentiment(s) {
  if (s == null || !Number.isFinite(s)) return "unknown";
  if (s >= 0.25) return `positive (+${s.toFixed(2)})`;
  if (s <= -0.25) return `negative (${s.toFixed(2)})`;
  return `slightly ${s >= 0 ? "positive" : "negative"} (${s.toFixed(2)})`;
}
function labelVolatility(normVol) {
  // If we have normalized vol in metrics.norm.vol20 use that; else judge by raw vol20
  if (normVol != null && Number.isFinite(normVol)) {
    if (normVol >= 0.66) return "high";
    if (normVol >= 0.33) return "medium";
    return "low";
  }
  return "unknown";
}

function mdEsc(s) { return String(s || "").replace(/\|/g, "\\|"); }

function findMetricBlockFor(market, name) {
  const block = metrics?.[market];
  if (!block || typeof block !== "object") return null;
  // metrics[market][name]
  const exact = block[name];
  if (exact) return exact;

  // Fallback: case-insensitive match by name key
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(block)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function newsForTicker(ticker) {
  if (!ticker) return null;
  const feat = newsFeat[ticker] || newsFeat[ticker.toUpperCase()] || null;
  return feat ? {
    count: Number(feat.count) || 0,
    sentiment: Number.isFinite(feat.sentiment) ? feat.sentiment : null,
    blogs: Number(feat.blogMentions) || 0
  } : null;
}

function buildCompanySummary({ market, bucket, entry }) {
  const name = entry?.name ?? "";
  const ticker = entry?.ticker ?? null;
  const sector = entry?.sector ?? null;
  const searchUrl = entry?.searchUrl ?? null;

  const m = findMetricBlockFor(market, name) || {};
  const norm = m.norm || {};
  const ret5 = Number.isFinite(m.ret5) ? `${m.ret5.toFixed(1)}%` : "n/a";
  const ret20 = Number.isFinite(m.ret20) ? `${m.ret20.toFixed(1)}%` : "n/a";
  const volBand = labelVolatility(norm.vol20);
  const earn = m.recentEarnings === true ? "Yes" : "No";

  const nf = newsForTicker(ticker) || {};
  const newsCount = Number(nf.count) || 0;
  const blogs = Number(nf.blogs) || 0;
  const sentimentLabel = nf.sentiment == null ? "unknown" : labelSentiment(nf.sentiment);
  const momentum = labelMomentum(newsCount);

  const bullets = [
    `News (7d): **${newsCount}** ${blogs ? `(blogs: ${blogs})` : ""} — momentum: **${momentum}**, sentiment: **${sentimentLabel}**`.trim(),
    `Returns: 5d **${ret5}**, 20d **${ret20}**; volatility (20d): **${volBand}**`,
    `Earnings window (±10d): **${earn}**`,
    sector ? `Sector: **${sector}**` : null,
    searchUrl ? `News search: ${searchUrl}` : null
  ].filter(Boolean);

  return {
    market, bucket, name, ticker, sector,
    metrics: { ret5: m.ret5 ?? null, ret20: m.ret20 ?? null, volBand, earningsWindow: earn === "Yes" },
    news: { count: newsCount, blogs, sentiment: nf.sentiment ?? null, momentum },
    links: { searchUrl },
    bullets
  };
}

// ---- Walk recommendations and build summaries
const out = {
  generatedAtKST: lastUpdated,
  companies: []
};

for (const [market, buckets] of Object.entries(rec)) {
  if (market === "lastUpdated") continue;
  for (const bucket of ["safe", "aggressive"]) {
    const arr = Array.isArray(buckets?.[bucket]) ? buckets[bucket] : [];
    for (const entry of arr) {
      out.companies.push(buildCompanySummary({ market, bucket, entry }));
    }
  }
}

// ---- Write JSON
const jsonPath = path.join(root, "summary.json");
fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2), "utf8");

// ---- Write Markdown (grouped by market/bucket)
let md = `# Stock News Summary (no-LLM)\n\n- Generated: **${lastUpdated} (KST)**\n- Sources: recommendations.json, pools-metrics.json, data/news-features.json\n\n`;
const byMarket = {};
for (const c of out.companies) {
  byMarket[c.market] ||= { safe: [], aggressive: [] };
  byMarket[c.market][c.bucket].push(c);
}
for (const market of Object.keys(byMarket).sort()) {
  md += `## ${market}\n\n`;
  for (const bucket of ["safe", "aggressive"]) {
    const list = byMarket[market][bucket];
    if (!list?.length) continue;
    md += `### ${bucket.toUpperCase()} (${list.length})\n\n`;
    for (const c of list) {
      md += `**${mdEsc(c.name)}** ${c.ticker ? `(${c.ticker})` : ""}\n\n`;
      for (const b of c.bullets) md += `- ${b}\n`;
      md += `\n`;
    }
  }
}
const mdPath = path.join(root, "summary.md");
fs.writeFileSync(mdPath, md, "utf8");

console.log(`Wrote:\n- ${jsonPath}\n- ${mdPath}`);
