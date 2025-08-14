// src/build.js
import fs from 'fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');           // repo root
const TEMPLATE = path.join(ROOT, 'src', 'template.html');
const RECS = path.join(ROOT, 'recommendations.json');
const OUT_HTML = path.join(ROOT, 'stocks.html');

function log(...a){ console.log('[build]', ...a); }
function warn(...a){ console.warn('[build:warn]', ...a); }
function fail(msg, err){
  console.error('[build:error]', msg);
  if (err) console.error(err.stack || err.message || err);
  process.exit(1);
}

async function readJson(fp){
  try {
    const raw = await fs.readFile(fp, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    fail(`Unable to read/parse JSON at ${fp}`, e);
  }
}

function normItem(it){
  // Accept "Apple" or { name: "Apple", sector: "Tech" }
  if (typeof it === 'string') return { name: it };
  if (it && typeof it === 'object') {
    const name = String(it.name ?? '').trim();
    const sector = it.sector ? String(it.sector).trim() : '';
    return name ? { name, sector } : null;
  }
  return null;
}

function normBucket(arr){
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    const n = normItem(it);
    if (n) out.push(n);
  }
  return out;
}

function normalizeRecs(data){
  if (!data || typeof data !== 'object') {
    throw new Error('recommendations.json is not an object');
  }
  const result = {};
  for (const [market, val] of Object.entries(data)) {
    if (market === 'lastUpdated') { result.lastUpdated = val; continue; }
    const safe = normBucket(val?.safe);
    const aggressive = normBucket(val?.aggressive);
    result[market] = { safe, aggressive };
  }
  return result;
}

function renderSections(recs, lang='ko'){
  const label = (key)=> key === 'safe'
    ? (lang==='ko' ? '안전주' : 'Safe Picks')
    : (lang==='ko' ? '공격주' : 'Aggressive Picks');

  const markets = Object.keys(recs).filter(k => k !== 'lastUpdated');
  const parts = [];

  for (const m of markets) {
    const group = recs[m] || { safe: [], aggressive: [] };
    for (const bucket of ['safe', 'aggressive']) {
      const items = (group[bucket] || []).map(it => {
        const sec = it.sector ? `<span class="sector">${it.sector}</span>` : '';
        return `<li>${it.name}${sec}</li>`;
      }).join('');
      parts.push(
        `<div class="portfolio-group"><h3>${m} ${label(bucket)}</h3><ul>${items}</ul></div>`
      );
    }
  }
  return parts.join('\n');
}

async function main(){
  log('Start build');

  // 1) Read inputs
  const [tpl, recsRaw] = await Promise.all([
    fs.readFile(TEMPLATE, 'utf8').catch(e=>fail(`Cannot read template: ${TEMPLATE}`, e)),
    readJson(RECS)
  ]);

  // 2) Normalize recs
  let recs;
  try {
    recs = normalizeRecs(recsRaw);
  } catch (e) {
    // Show a helpful preview
    const preview = JSON.stringify(recsRaw, null, 2).slice(0, 600);
    warn('Raw recommendations preview (truncated 600 chars):\n' + preview);
    fail('Failed to normalize recommendations.json', e);
  }

  // 3) Render
  const dateStr = new Date().toLocaleDateString('ko-KR', { year:'numeric', month:'long', day:'numeric' });
  const sections = renderSections(recs, 'ko');

  let html = tpl.replace('{{CURRENT_DATE}}', dateStr);
  html = html.replace('{{PORTFOLIO_SECTIONS}}', sections);

  // 4) Write out
  await fs.writeFile(OUT_HTML, html, 'utf8').catch(e=>fail(`Cannot write ${OUT_HTML}`, e));

  log('Build complete →', OUT_HTML);
}

main().catch(e=>fail('Unhandled error in build', e));
