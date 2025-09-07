import fs from 'fs';
import path from 'path';

const fsp = fs.promises;

export async function readJSON(file, fallback = null) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJSONAtomic(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp.' + Math.random().toString(36).slice(2);
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fsp.rename(tmp, file);
}

export function isFresh(metaOrTs, ttlMs) {
  const ts = typeof metaOrTs === 'number'
    ? metaOrTs
    : (metaOrTs && metaOrTs.lastUpdated && Date.parse(metaOrTs.lastUpdated));
  if (!ts) return false;
  return Date.now() - Number(ts) < ttlMs;
}
