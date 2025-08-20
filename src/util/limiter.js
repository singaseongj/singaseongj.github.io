export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function withRetry(fn, { retries = 2, backoff = 400 } = {}) {
  let err;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      await sleep(backoff * (i + 1));
    }
  }
  throw err;
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}
