import { promises as fsp } from 'fs';
import path from 'path';

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, 'cache');
const LIMIT = Number(process.env.CACHE_LIMIT || 1000);
const DRY_RUN = process.env.DRY_RUN === '1';

async function *walk(dir) {
  const dirh = await fsp.opendir(dir);
  for await (const dirent of dirh) {
    const p = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      yield *walk(p);
    } else if (dirent.isFile()) {
      yield p;
    }
  }
}

async function prune() {
  // Collect all files under cache/
  const files = [];
  for await (const filePath of walk(CACHE_DIR)) {
    const stat = await fsp.stat(filePath);
    files.push({ filePath, mtime: stat.mtimeMs });
  }

  // Sort newest first
  files.sort((a, b) => b.mtime - a.mtime);

  if (files.length <= LIMIT) {
    console.log(`Cache has ${files.length} files (<= ${LIMIT}); nothing to prune.`);
    return;
  }

  const toRemove = files.slice(LIMIT);
  console.log(`Keeping ${LIMIT}, pruning ${toRemove.length} older files in ${CACHE_DIR}…`);

  if (DRY_RUN) {
    toRemove.slice(0, 10).forEach(f => console.log(`[dry-run] would remove ${f.filePath}`));
    if (toRemove.length > 10) console.log(`[dry-run] …and ${toRemove.length - 10} more`);
    return;
  }

  // Delete older files
  for (const f of toRemove) {
    await fsp.unlink(f.filePath);
  }
  console.log(`Done. Pruned ${toRemove.length} files.`);
}

prune().catch(err => {
  console.error('Failed to prune cache:', err);
  process.exit(1);
});
