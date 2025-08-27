const nowMs = () => Date.now();

export function tokenBucket({capacity, refillPerSec}) {
  let tokens = capacity, last = nowMs();
  return async function take() {
    while (true) {
      const t = nowMs();
      const dt = (t - last) / 1000;
      tokens = Math.min(capacity, tokens + dt * refillPerSec);
      if (tokens >= 1) { tokens -= 1; return; }
      const waitMs = Math.ceil((1 - tokens) / refillPerSec * 1000);
      await new Promise(r => setTimeout(r, Math.max(50, waitMs)));
    }
  };
}

export function circuitBreaker({cooldownMs = 15*60_000} = {}) {
  let opens = {};
  return {
    isOpen(key){ return (opens[key]||0) > nowMs(); },
    open(key){ opens[key] = nowMs() + cooldownMs; },
    close(key){ delete opens[key]; }
  };
}
