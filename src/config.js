import path from 'node:path';

export const IS_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
export const IS_VERCEL = process.env.VERCEL === '1';
export const IS_RAILWAY = process.env.RAILWAY_ENVIRONMENT !== undefined;
export const IS_LOCAL = !IS_GITHUB_ACTIONS && !IS_VERCEL && !IS_RAILWAY;

export const CONFIG = {
  CACHE_DIR: process.cwd(),
  RUN_TIMEOUT_MS: 60_000,
  REQUEST_TIMEOUT_MS: 30_000,
  SKIP_NAVER: process.env.SKIP_NAVER === '1'
};

export const PATHS = {
  OUT_FILE: path.resolve(CONFIG.CACHE_DIR, 'recommendations.json'),
  CACHE_FILE: path.resolve(CONFIG.CACHE_DIR, 'ticker-cache.json'),
  METRICS_CACHE_FILE: path.resolve(CONFIG.CACHE_DIR, 'metrics-cache.json')
};

export const HEADERS_HTML = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': 'text/html'
};

export const HEADERS_JSON = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': 'application/json'
};
