function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

export async function withRetry(fn, { retries = 3, baseMs = 400, factor = 2, onError } = {}) {
  let attempt = 0, lastErr;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (onError) onError(err, attempt);
      if (attempt === retries) break;
      await sleep(baseMs * Math.pow(factor, attempt));
      attempt++;
    }
  }
  throw lastErr;
}
