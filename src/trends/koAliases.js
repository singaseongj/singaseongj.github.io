import fs from 'fs';

export const KO_ALIASES = JSON.parse(
  fs.readFileSync(new URL('./koAliases.json', import.meta.url), 'utf8')
);
