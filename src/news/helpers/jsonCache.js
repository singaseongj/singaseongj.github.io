import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const CACHE_DIR = path.join('cache', '.news-requests');
const AUTH_PARAMS = new Set([
  'apikey', 'token', 'accesstoken', 'authtoken', 'servicekey',
  'clientid', 'clientsecret', 'authorization', 'password',
]);

export function newsCacheFilename(url) {
  const identity = new URL(url);
  identity.username = '';
  identity.password = '';
  identity.hash = '';
  for (const key of [...identity.searchParams.keys()]) {
    if (AUTH_PARAMS.has(key.toLowerCase().replace(/[-_]/g, ''))) {
      identity.searchParams.delete(key);
    }
  }
  identity.searchParams.sort();
  const digest = createHash('sha256').update(identity.href).digest('hex');
  return `news-v2-${digest}.json`;
}

export async function cachedNewsJson(url, fetcher, { ttlMs, allowStale, cacheDir = CACHE_DIR }) {
  const file = path.join(cacheDir, newsCacheFilename(url));
  let cached;
  try {
    const { mtimeMs } = await fs.stat(file);
    cached = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Date.now() - mtimeMs < ttlMs) return cached;
  } catch {}

  let data;
  try {
    data = await fetcher(url);
  } catch (error) {
    if (allowStale && cached !== undefined) return cached;
    throw error;
  }

  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(data));
  } catch {}
  return data;
}
