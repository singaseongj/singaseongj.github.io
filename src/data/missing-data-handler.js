export class MissingDataHandler {
  constructor(defaults = {}) { this.defaults = defaults; }
  _score(v, d=0.5){ return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d; }
  handleNewsData(newsData){ const len = Array.isArray(newsData) ? newsData.length : 0; return { score: this._score(len/10, this.defaults.newsScore ?? 0.5), confidence: len ? 0.9 : 0.3 }; }
  handleBlogMentions(count){ const c=Number(count)||0; return { score:this._score(c/10,this.defaults.blogScore??0.3), confidence:c?0.8:0.4 }; }
  handleWikiViews(views){ const v=Number(views)||0; return { score:this._score(Math.log10(1+v)/5,this.defaults.wikiScore??0.2), confidence:v?0.8:0.3 }; }
  handleVolumeData(current, average){ const cur=Number(current)||0; const avg=Number(average)||0; const ratio=avg>0?cur/avg:0; return { score:this._score(ratio/2,this.defaults.volumeScore??0.5), confidence:avg>0?0.8:0.3 }; }
  calculateOverallConfidence(conf){ const vals=Object.values(conf).filter(Number.isFinite); return vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:0.4; }
  adjustScoreByConfidence(score, confidence){ return score * (0.7 + 0.3*Math.max(0, Math.min(1, confidence))); }
}
