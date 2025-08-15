import fs from 'fs/promises';
import { existsSync } from 'fs';

export async function loadJSON(p, fallback = {}) {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
}

export async function saveJSON(p, data) {
  await fs.writeFile(p, JSON.stringify(data, null, 2));
}

export async function writeAtomically(dest, data) {
  const tmp = `${dest}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, dest);
}

export async function tryPullRemote() {
  return null;
}

export async function tryPushRemote() {
  return null;
}
