#!/usr/bin/env node
// Regenerate all diagrams.
//
//   node assets/diagrams/build.mjs
//
// Source lives in `assets/diagrams/src/*.mmd`. Output is SVGs next to this
// script, one per theme.
//
// Requires Node ≥ 18 and `beautiful-mermaid` installed locally:
//
//   npm install beautiful-mermaid
//
// (There is no `package.json` at the repo root by design — the runtime has
// zero deps. This script is a dev-only tool; install beautiful-mermaid on
// demand in a scratch dir if you want to regenerate.)

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SRC_DIR = path.join(HERE, 'src');

let beautifulMermaid;
try {
  beautifulMermaid = await import('beautiful-mermaid');
} catch (e) {
  console.error('`beautiful-mermaid` is not installed. Run:');
  console.error('  npm install beautiful-mermaid');
  console.error('...in this repo or a scratch directory, then re-run.');
  process.exit(1);
}

const { renderMermaidSVG, THEMES } = beautifulMermaid;

// The two themes we ship.
const THEME_MAP = {
  light: THEMES['github-light'],
  dark:  THEMES['github-dark'],
};

let ok = 0, fail = 0;
for (const file of fs.readdirSync(SRC_DIR)) {
  if (!file.endsWith('.mmd')) continue;
  const name = path.basename(file, '.mmd');
  const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
  for (const [theme, config] of Object.entries(THEME_MAP)) {
    try {
      const svg = renderMermaidSVG(src, config);
      const out = path.join(HERE, `${name}-${theme}.svg`);
      fs.writeFileSync(out, svg);
      console.log(`✓ ${path.relative(HERE, out)}  (${svg.length}B)`);
      ok++;
    } catch (err) {
      console.error(`✗ ${name}-${theme}: ${err.message}`);
      fail++;
    }
  }
}
console.log(`\nDone. ${ok} OK, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
