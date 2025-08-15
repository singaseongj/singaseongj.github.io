import { CONFIG } from './config.js';
import { sleep } from './util.js';

let deadline = Infinity;
export function setDeadline(ms) {
  deadline = Date.now() + ms;
}

export function noteStatus() {}

export function nextDelay() {
  return 1000;
}

export async function fetchWithTimeout(url, options = {}, ms = CONFIG.REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

export async function fetchWithRetry(url, options = {}, { retries = 1, timeoutMs = CONFIG.REQUEST_TIMEOUT_MS } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) break;
    await sleep(500);
  }
  throw lastErr;
}

export async function testConnectivity() {
  return true;
}
