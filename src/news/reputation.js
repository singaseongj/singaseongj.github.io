import fs from 'fs';
import path from 'path';

// --- load taxonomy once
const TAX_PATH = path.join(process.cwd(), 'src/news/keyword-taxonomy.json');
const TAX = JSON.parse(fs.readFileSync(TAX_PATH, 'utf8'));
const HALF_LIFE_D = TAX.halfLifeDays ?? 14;
const ALPHA = TAX.alpha ?? 1.1;
const BIAS = TAX.defaultBias ?? 0;

// Precompile regexes
function esc(s){return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');}
function makeRegex(terms){
  if (!terms?.length) return null;
  const pat = terms.map(t => esc(t)).join('|');
  return new RegExp(`(${pat})`, 'iu');
}
const CLASSES = TAX.classes.map(c => ({
  ...c,
  rxKR: makeRegex(c.terms_kr),
  rxEN: makeRegex(c.terms_en)
}));

function decayWeight(publishedAtIso){
  const t = new Date(publishedAtIso).getTime();
  if (!Number.isFinite(t)) return 0.8;
  const ageDays = Math.max(0, (Date.now() - t) / 86400000);
  const lambda = Math.log(2) / HALF_LIFE_D;
  return Math.exp(-lambda * ageDays);
}

function sourceWeight(tier){
  return TAX.sourceWeights?.[tier] ?? TAX.sourceWeights?.default ?? 1.0;
}

/**
 * @param {Object} args
 * @param {Array<Object>} args.items - news items for ONE symbol
 *   shape: {
 *     id, headline, snippet, lang?: 'ko'|'en'|..., publishedAt, sourceTier?: 'major'|'wire'|'blog'|'forum'|'default'|'unknown'
 *   }
 * @param {Object} args.company
 *   shape: { ticker: '005930.KS', names: ['삼성전자','Samsung Electronics','Samsung'] }
 * @returns {{ reputationScore:number, topKeywords:Array, tallies:Object, hitIds:Array }}
 */
export function computeReputation({ items = [], company }){
  const nameRegex = company?.names?.length
    ? new RegExp(company.names.map(esc).join('|'), 'iu')
    : null;
  const tickerRegex = company?.ticker ? new RegExp(esc(company.ticker), 'i') : null;

  let pos = 0, neg = 0;
  const keywordTallies = new Map();
  const hitIds = new Set();

  for (const it of items){
    const text = [it.headline, it.snippet].filter(Boolean).join('  ').slice(0, 600);
    if (!text) continue;

    const inScope = !nameRegex && !tickerRegex ? true : (
      (nameRegex ? nameRegex.test(text) : false) || (tickerRegex ? tickerRegex.test(text) : false)
    );
    if (!inScope) continue;

    const wDecay = decayWeight(it.publishedAt);
    const wSource = sourceWeight(it.sourceTier);
    const baseW = wDecay * wSource;

    for (const cls of CLASSES){
      const rx = (it.lang && /^ko/i.test(it.lang)) ? (cls.rxKR || cls.rxEN) : (cls.rxEN || cls.rxKR);
      if (!rx) continue;
      let m;
      if ((m = rx.exec(text))){
        const intensity = TAX.intensity?.normal ?? 1.0;
        const contribution = (cls.weight ?? 1.0) * baseW * intensity;

        const keyShown = m[1] || cls.id;
        const entry = keywordTallies.get(keyShown) || { polarity: cls.polarity, score: 0, count: 0, lastSeen: null };
        entry.score += contribution;
        entry.count += 1;
        entry.lastSeen = it.publishedAt || entry.lastSeen;
        keywordTallies.set(keyShown, entry);

        const hid = it.id || it.url;
        if (hid) hitIds.add(hid);

        if (cls.polarity === 'positive') pos += contribution;
        else neg += contribution;
      }
    }
  }

  const raw = (pos - neg) + BIAS;
  const reputationScore = 1 / (1 + Math.exp(-ALPHA * raw));

  const topKeywords = [...keywordTallies.entries()]
    .sort((a,b)=>Math.abs(b[1].score) - Math.abs(a[1].score))
    .slice(0, 5)
    .map(([term, v]) => ({ term, polarity: v.polarity, weight: +v.score.toFixed(3), count: v.count, lastSeen: v.lastSeen }));

  const tallies = Object.fromEntries([...keywordTallies.entries()].map(([k,v])=>[k,v]));
  const hitIdsArr = [...hitIds];

  return { reputationScore, topKeywords, tallies, hitIds: hitIdsArr };
}
