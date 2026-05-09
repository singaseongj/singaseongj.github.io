export class TechnicalIndicators {
  constructor(prices = []) { this.prices = prices.map(Number).filter(Number.isFinite); }
  getTechnicalScore(){
    if (this.prices.length < 20) return { score: 0.5, confidence: 0.2, note: 'Insufficient price history' };
    const p=this.prices; const last=p[p.length-1]; const sma20=p.slice(-20).reduce((a,b)=>a+b,0)/20;
    const mom=(last-sma20)/Math.max(1e-6,sma20); const score=Math.max(0,Math.min(1,0.5+mom));
    return { score, confidence: 0.7, note: 'SMA20 momentum' };
  }
}
