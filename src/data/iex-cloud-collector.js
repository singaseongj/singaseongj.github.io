export class IEXCloudCollector { constructor(apiKey){ this.apiKey=apiKey; } async getCompanySignal(){ return { score: 0.5, confidence: 0.3 }; } }
