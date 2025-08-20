import fs from 'fs';
import path from 'path';

const CACHE = path.resolve(process.cwd(), 'data-cache.json');

function readCache(){
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); }
  catch { return {}; }
}

function writeCache(obj){
  fs.writeFileSync(CACHE, JSON.stringify(obj, null, 2));
}

export function getCached(key, ttlMs){
  const c = readCache();
  const hit = c[key];
  if (!hit) return null;
  if (ttlMs && Date.now() - hit.t > ttlMs) return null;
  return hit.v;
}

export function setCached(key, v){
  const c = readCache();
  c[key] = { v, t: Date.now() };
  writeCache(c);
}
