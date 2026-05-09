export class SentimentAnalyzer {
  analyzeNewsSentiment(headlines = []) {
    const h = headlines.filter(Boolean).join(' ').toLowerCase();
    const pos = (h.match(/beat|surge|gain|growth|upgrade/g)||[]).length;
    const neg = (h.match(/miss|drop|decline|downgrade|risk/g)||[]).length;
    const raw = pos + neg ? (pos-neg)/(pos+neg) : 0;
    return { sentiment: raw, score: Math.max(0, Math.min(1, (raw+1)/2)), confidence: headlines.length ? 0.6 : 0.3 };
  }
}
