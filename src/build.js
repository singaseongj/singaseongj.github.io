// src/build.js
import fs from 'fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'src', 'template.html');
const OUT_HTML = path.join(ROOT, 'stocks.html');

function log(...a){ console.log('[build]', ...a); }
function fail(msg, err){
  console.error('[build:error]', msg);
  if (err) console.error(err.stack || err.message || err);
  process.exit(1);
}

async function main(){
  log('Start build');

  const tpl = await fs.readFile(TEMPLATE, 'utf8').catch(e=>fail(`Cannot read template: ${TEMPLATE}`, e));

  const dateStr = new Date().toLocaleDateString('ko-KR', { year:'numeric', month:'long', day:'numeric' });
  const html = tpl.replace('{{CURRENT_DATE}}', dateStr);

  await fs.writeFile(OUT_HTML, html, 'utf8').catch(e=>fail(`Cannot write ${OUT_HTML}`, e));

  log('Build complete →', OUT_HTML);
}

main().catch(e=>fail('Unhandled error in build', e));

