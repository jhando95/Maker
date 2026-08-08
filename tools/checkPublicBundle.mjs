/**
 * Prove the public build does not contain the developer tools.
 *
 * The gate on the dev panel is that the code is *not in the output*, and the
 * difference between that and a runtime flag is the whole point — so it has to
 * be checked against the artefact rather than argued from the source. A build
 * that shipped `src/dev/` because a bundler stopped folding a constant one day
 * would look completely normal until somebody pressed F8.
 *
 *   npm run build && npm run check:public
 *
 * Greps for the panel's own marker string, which exists for exactly this and is
 * deliberately long and dull so nothing else can produce it by accident.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const MARKER = 'MAKER_DEV_PANEL_PRESENT';
/** Anything else that would give it away. */
const TELLS = [MARKER, 'mk-dev-group', 'Tuning — F8'];

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(path));
    else if (/\.(js|css|html)$/.test(entry.name)) out.push(path);
  }
  return out;
}

if (!existsSync(DIST)) {
  console.error(`[check:public] no ${DIST}/ — run the build first`);
  process.exit(1);
}

const found = [];
for (const path of files(DIST)) {
  const text = readFileSync(path, 'utf8');
  for (const tell of TELLS) if (text.includes(tell)) found.push(`${path}: ${tell}`);
}

if (found.length > 0) {
  console.error('[check:public] the developer tools are in the public build:');
  for (const hit of found) console.error(`  ${hit}`);
  console.error('[check:public] build with `npm run build`, not `npm run build:tools`');
  process.exit(1);
}

console.log(`[check:public] clean — none of ${TELLS.length} tells in ${files(DIST).length} files`);
