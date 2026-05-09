export class ScoreAuditor {
  constructor(symbol, name, level='standard'){ this.symbol=symbol; this.name=name; this.level=level; this.steps=[]; }
  recordStep(step, score, details={}){ this.steps.push({ step, score, details, ts: new Date().toISOString() }); }
  getSummary(){ return { symbol:this.symbol, steps:this.steps.length }; }
  getAudit(){ return { symbol:this.symbol, name:this.name, steps:this.steps }; }
  getDetailedReport(){ return this.getAudit(); }
}
