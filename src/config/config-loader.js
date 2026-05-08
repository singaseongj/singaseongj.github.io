/**
 * src/config/config-loader.js
 *
 * 설정 파일 로더
 * - JSON 파일 로드
 * - 환경변수 오버라이드
 * - 기본값 적용
 * - 안전한 조회
 */

import fs from 'fs/promises';
import path from 'path';

class ConfigLoader {
  constructor() {
    this.config = null;
    this.loaded = false;
    this.envMap = this.buildEnvMap();
  }

  /**
   * 환경변수 → 설정 경로 매핑 생성
   */
  buildEnvMap() {
    return {
      // 시장캡
      MCAP_MIN: 'marketCap.min',
      MCAP_MAX: 'marketCap.max',

      // 스코어링 - 절대값
      SIZE_ABS_WEIGHT: 'scoring.absolute.sizeWeight',
      SIZE_ABS_WEIGHT_AGGR: 'scoring.absolute.sizeWeightAggressive',
      SCALE_WEIGHT: 'scoring.absolute.scaleWeight',

      // 정규화
      BLOG_NORM: 'scoring.normalization.blogMentions',
      WIKI_NORM: 'scoring.normalization.wikiViews',

      // 가중치 - 절대값
      ABS_W_NEWS: 'weights.absolute.news',
      ABS_W_NAVPOP: 'weights.absolute.naverPopularity',
      ABS_W_BLOGS: 'weights.absolute.blogs',
      ABS_W_WIKI: 'weights.absolute.wiki',
      ABS_W_KEYPOS: 'weights.absolute.positiveKeywords',
      ABS_W_KEYNEG: 'weights.absolute.negativeKeywords',
      ABS_W_NAVER_FIN: 'weights.absolute.naverFinance',

      // 가중치 - 조기
      NEWS_WEIGHT: 'weights.early.news',
      BLOG_WEIGHT: 'weights.early.blogs',
      POPULARITY_WEIGHT: 'weights.early.popularity',
      POS_KW_WEIGHT: 'weights.early.positiveKeywords',
      NEG_KW_WEIGHT: 'weights.early.negativeKeywords',
      WIKI_WEIGHT: 'weights.early.wiki',

      // 가중치 - 호트니스
      HOT_W_NEWS: 'weights.hotness.news',
      HOT_W_TREND: 'weights.hotness.trend',
      HOT_W_TURN: 'weights.hotness.turnover',
      HOT_W_WIKI: 'weights.hotness.wiki',
      TREND_EXP: 'trends.exponential',

      // 부스트
      BURST_KICK_SCALE: 'trends.burstKick.scale',
      BURST_KICK_MAX: 'trends.burstKick.max',
      EXT_MIX: 'weights.external.mix',

      // 네이버
      NAVER_SPIKE_BOOST: 'naver.spike.boost',
      NAVER_PERSIST_BOOST: 'naver.persist.boost',
      ASVI_NEGATIVE_FLOOR: 'naver.asvi.negativeFloor',

      // 인덱스
      PRIOR_W_SP500: 'index.priors.sp500',
      PRIOR_W_N100: 'index.priors.nasdaq100',
      PRIOR_W_K200: 'index.priors.kospi200',
      PRIOR_W_KQ100: 'index.priors.kosdaq100',
      PRIOR_FLOOR: 'index.floor',
      STRUCT_FLOOR_W: 'index.structuralFloor',

      // 바닥/상한
      POP_FLOOR_W: 'floor.popularityFloor',
      POP_CAP: 'floor.popularityCap',
      SCORE_FLOOR: 'ceil.floor',
      SCORE_CEIL: 'ceil.default',
      SCORE_CEIL_SP500: 'ceil.sp500',
      SCORE_ROUND: 'ceil.roundMethod',

      // 부스트
      HOTNESS_WEIGHT: 'boosts.hotness.weight',
      LIQ_WEIGHT: 'boosts.liquidity.weight',
      EARNINGS_BOOST: 'boosts.earnings.boost',
      SECTOR_LIFT: 'boosts.sectorLift',

      // 추세
      TREND_T5: 'trends.thresholds.t5',
      TREND_T4: 'trends.thresholds.t4',
      TREND_T3: 'trends.thresholds.t3',
      TREND_T2: 'trends.thresholds.t2',
      KR_MARKET_DEDUCT_POINTS: 'trends.koreanMarketDeductPoints',

      // 뉴스
      NEWS_T5: 'news.thresholds.t5',
      NEWS_T4: 'news.thresholds.t4',
      NEWS_T3: 'news.thresholds.t3',
      NEWS_T2: 'news.thresholds.t2',

      // 태그
      TAG_EVAL_WEIGHT: 'tags.evalWeight',
      TAG_FREQ_WEIGHT: 'tags.freqWeight',
      KEYWORD_SCORE_WEIGHT: 'tags.keywordScoreWeight',

      // 커버리지
      COVERAGE_MIN: 'coverage.minimum',
      FINAL_STAGE_BUDGET_FRAC: 'coverage.finalStageBudgetFrac',

      // 성능
      GLOBAL_BUDGET_MS: 'performance.globalBudgetMs',
      MAX_CONCURRENCY: 'performance.maxConcurrency',
      CIRCUIT_MAX_ERRORS: 'performance.circuit.maxErrors',
      CIRCUIT_COOLDOWN_MS: 'performance.circuit.cooldownMs',
      REQ_TIMEOUT_MS: 'performance.timeout.requestMs',
      RETRIES: 'performance.timeout.retries',
      BACKOFF_BASE_MS: 'performance.timeout.backoffBaseMs',
      CACHE_TTL_MS: 'performance.cache.defaultTtlMs',
      COOLOFF_MS: 'performance.cache.cooloffMs',
      TTL_NEWS_RSS_MS: 'performance.cache.ttlNewsRssMs',
      TTL_WIKI_MS: 'performance.cache.ttlWikiMs',
      TTL_EARNINGS_MS: 'performance.cache.ttlEarningsMs',

      // 필터
      MIN_ADV_US: 'filters.liquidity.minAdvUsd',
      MIN_ADV_KR: 'filters.liquidity.minAdvKr',
      MIN_PRICE_USD: 'filters.price.minUsd',
      MIN_PRICE_KRW: 'filters.price.minKrw',

      // 페널티
      INELIGIBLE_PENALTY: 'penalties.ineligible',
      UNKNOWN_PENALTY: 'penalties.unknown',

      // 플래그
      VERBOSE: 'flags.verbose',
      OFFLINE: 'flags.offline',
      DRY_RUN: 'flags.dryRun',
      ABSOLUTE_SCORING: 'flags.absoluteScoring',
      DISABLE_JITTER: 'flags.disableJitter',

      // 나머지
      PREV_CARRY: 'carry.previous',
    };
  }

  /**
   * 설정 파일 로드
   * @param {string} configPath - 설정 파일 경로
   * @param {object} env - 환경변수 (process.env 또는 테스트용 객체)
   * @returns {Promise<object>} 통합 설정
   */
  async load(configPath = 'config/pools-config.json', env = process.env) {
    try {
      // 1. JSON 파일 로드
      const fullPath = this.resolvePath(configPath);
      const fileContent = await fs.readFile(fullPath, 'utf8');
      let config = JSON.parse(fileContent);

      // 2. 환경변수 오버라이드 적용
      config = this.applyEnvOverrides(config, env);

      // 3. 타입 검증 (간단한 검증)
      config = this.validateTypes(config);

      this.config = config;
      this.loaded = true;

      return config;
    } catch (error) {
      console.error(`Failed to load config from ${configPath}:`, error.message);
      throw error;
    }
  }

  /**
   * 환경변수로 설정 오버라이드
   */
  applyEnvOverrides(config, env) {
    const result = JSON.parse(JSON.stringify(config)); // 깊은 복사

    for (const [envKey, configPath] of Object.entries(this.envMap)) {
      if (envKey in env && env[envKey] != null && env[envKey] !== '') {
        const value = this.coerceType(env[envKey]);
        this.setNested(result, configPath, value);
      }
    }

    return result;
  }

  /**
   * 중첩된 객체 경로에 값 설정
   */
  setNested(obj, path, value) {
    const keys = path.split('.');
    let current = obj;

    // 경로 생성
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current)) {
        current[key] = {};
      }
      current = current[key];
    }

    // 값 설정
    const lastKey = keys[keys.length - 1];
    current[lastKey] = value;
  }

  /**
   * 환경변수 문자열을 타입 강제 변환
   */
  coerceType(value) {
    const str = String(value).trim();

    // Boolean
    if (str === 'true') return true;
    if (str === 'false') return false;

    // Number
    if (/^\d+(\.\d+)?$/.test(str)) {
      const num = parseFloat(str);
      if (Number.isFinite(num)) return num;
    }

    // String
    return str;
  }

  /**
   * 기본 타입 검증
   */
  validateTypes(config) {
    const validators = {
      'scoring.absolute.sizeWeight': 'number',
      'scoring.absolute.sizeWeightAggressive': 'number',
      'weights.absolute.news': 'number',
      'performance.globalBudgetMs': 'number',
      'performance.maxConcurrency': 'number',
      'flags.verbose': 'boolean',
      'flags.offline': 'boolean',
    };

    for (const [path, expectedType] of Object.entries(validators)) {
      const value = this.getNested(config, path);
      if (value != null && typeof value !== expectedType) {
        console.warn(
          `Type mismatch at ${path}: expected ${expectedType}, got ${typeof value}`,
        );
      }
    }

    return config;
  }

  /**
   * 중첩된 객체 경로에서 값 가져오기 (내부용)
   */
  getNested(obj, path) {
    const keys = path.split('.');
    let current = obj;

    for (const key of keys) {
      if (current == null || !(key in current)) {
        return null;
      }
      current = current[key];
    }

    return current;
  }

  /**
   * 설정값 안전하게 조회
   * @param {string} path - "scoring.absolute.sizeWeight" 형식
   * @param {*} defaultValue - 기본값
   * @returns {*} 설정값 또는 기본값
   */
  get(path, defaultValue = null) {
    if (!this.loaded) {
      throw new Error('Config not loaded. Call load() first.');
    }

    const value = this.getNested(this.config, path);
    return value ?? defaultValue;
  }

  /**
   * 전체 설정 객체 반환
   */
  getAll() {
    if (!this.loaded) {
      throw new Error('Config not loaded. Call load() first.');
    }
    return this.config;
  }

  /**
   * 설정 경로 검증 (존재하는가?)
   */
  has(path) {
    return this.getNested(this.config, path) != null;
  }

  /**
   * 경로 해석 (상대 → 절대)
   */
  resolvePath(filePath) {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    return path.resolve(process.cwd(), filePath);
  }

  /**
   * 설정 프로필 로드 (dev/prod)
   */
  async loadProfile(profile = 'development') {
    const profilePath = `config/pools-config.${profile}.json`;
    return this.load(profilePath);
  }

  /**
   * 설정 비교 (디버깅용)
   */
  compareWithEnv() {
    const report = {
      matched: [],
      mismatch: [],
      onlyInConfig: [],
      onlyInEnv: [],
    };

    // 매핑된 모든 환경변수 확인
    for (const [envKey, configPath] of Object.entries(this.envMap)) {
      const envValue = process.env[envKey];
      const configValue = this.get(configPath);

      if (envValue != null) {
        const coerced = this.coerceType(envValue);
        if (coerced === configValue) {
          report.matched.push({ env: envKey, path: configPath, value: configValue });
        } else {
          report.mismatch.push({
            env: envKey,
            path: configPath,
            envValue: coerced,
            configValue,
          });
        }
      }
    }

    return report;
  }
}

export { ConfigLoader };
