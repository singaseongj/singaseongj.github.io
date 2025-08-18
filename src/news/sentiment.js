const POS_EN = ['up','gain','rise','beat','surge','positive','growth'];
const NEG_EN = ['down','fall','miss','drop','loss','negative','decline'];
const POS_KR = ['상승','호실적','수주'];
const NEG_KR = ['급락','적자','리콜'];

export function headlineSentiment(text, lang='en'){
  const t = String(text||'').toLowerCase();
  const posWords = lang==='kr'?POS_KR:POS_EN;
  const negWords = lang==='kr'?NEG_KR:NEG_EN;
  let pos=0, neg=0;
  for (const w of posWords){ if (t.includes(w)) pos++; }
  for (const w of negWords){ if (t.includes(w)) neg++; }
  if (pos+neg === 0) return null;
  return pos/(pos+neg);
}

export function aggregate(headlines=[], lang='en'){
  const uniq = Array.from(new Set(headlines.filter(Boolean)));
  if (!uniq.length) return { sentiment:null, top:null };
  const scores = uniq.map(h=>headlineSentiment(h,lang)).filter(s=>s!=null);
  const sentiment = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : null;
  return { sentiment, top: uniq[0] };
}
