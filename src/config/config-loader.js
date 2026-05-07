import fs from 'fs/promises';

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export class ConfigLoader {
  constructor() {
    this.config = null;
  }

  async load(configPath = 'config/pools-config.json', envOverrides = process.env) {
    const configFile = await fs.readFile(configPath, 'utf8');
    const fileConfig = JSON.parse(configFile);
    this.config = this.applyEnvOverrides(fileConfig, envOverrides);
    return this;
  }

  applyEnvOverrides(config, env = {}) {
    const result = deepClone(config);
    const envMap = {
      SIZE_ABS_WEIGHT: 'scoring.absolute.sizeWeight',
      SIZE_ABS_WEIGHT_AGGR: 'scoring.absolute.sizeWeightAggressive',
      ABS_W_NEWS: 'weights.absolute.news',
      ABS_W_NAVPOP: 'weights.absolute.naverPopularity',
      ABS_W_BLOGS: 'weights.absolute.blogs',
      ABS_W_WIKI: 'weights.absolute.wiki',
      ABS_W_KEYPOS: 'weights.absolute.positiveKeywords',
      ABS_W_KEYNEG: 'weights.absolute.negativeKeywords',
      HOT_W_NEWS: 'weights.hotness.news',
      HOT_W_TREND: 'weights.hotness.trend',
      HOT_W_TURN: 'weights.hotness.turnover',
      HOT_W_WIKI: 'weights.hotness.wiki',
      NAVER_SPIKE_BOOST: 'naver.spike.boost',
      NAVER_PERSIST_BOOST: 'naver.persist.boost',
      ASVI_NEGATIVE_FLOOR: 'naver.asvi.negativeFloor',
      GLOBAL_BUDGET_MS: 'performance.globalBudgetMs',
      MAX_CONCURRENCY: 'performance.maxConcurrency',
      COVERAGE_MIN: 'coverage.minimum',
      VERBOSE: 'flags.verbose',
      OFFLINE: 'flags.offline',
      DRY_RUN: 'flags.dryRun',
      ABSOLUTE_SCORING: 'flags.absoluteScoring'
    };

    for (const [envKey, configPath] of Object.entries(envMap)) {
      if (Object.hasOwn(env, envKey)) {
        this.setNested(result, configPath, this.coerceType(env[envKey]));
      }
    }
    return result;
  }

  setNested(obj, objectPath, value) {
    const keys = objectPath.split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      cur[keys[i]] ??= {};
      cur = cur[keys[i]];
    }
    cur[keys.at(-1)] = value;
  }

  coerceType(value) {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
    return value;
  }

  get(objectPath, defaultValue = null) {
    const keys = objectPath.split('.');
    let cur = this.config;
    for (const key of keys) {
      if (cur == null || !Object.hasOwn(cur, key)) return defaultValue;
      cur = cur[key];
    }
    return cur ?? defaultValue;
  }

  getAll() {
    return this.config;
  }
}
