export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function nowKSTISO() {
  return new Date().toLocaleString('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).replace(' ', 'T') + '+09:00';
}

export function seededRandom(seed) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => (
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909),
    (h >>> 0) / 2 ** 32
  );
}

export function pickDeterministic(arr, k, seed) {
  const rnd = seededRandom(seed), a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(k, a.length));
}

export function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function withTimeout(promise, ms, onTimeout) {
  let id;
  const t = new Promise((_, reject) => {
    id = setTimeout(() => {
      try { onTimeout?.(); } catch {}
      reject(new Error('RUN_TIMEOUT'));
    }, ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(id));
}
