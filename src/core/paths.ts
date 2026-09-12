/**
 * Locating the Orcrist language assets. `metamodel/` and `examples/` live at
 * the root of this repo, beside the app, and the grammar and the authoring
 * guide are read *live* from there — so editing the language changes what the
 * authoring step is grounded in without rebuilding the app.
 *
 * The search starts at the folder it is given and walks up, which is what lets
 * the same code work from `dist/main/...` at runtime, from `scripts/` in the
 * self-test, and from a checkout nested inside a larger tree.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface LanguageAssets {
  root: string;
  grammar: string;
  guide: string;
  examples: { name: string; source: string }[];
}

const GRAMMAR_REL = join('metamodel', 'orcrist.langium');
const GUIDE_REL = join('metamodel', 'authoring-guide.md');

/** Walks up from `start` looking for a folder that holds metamodel/orcrist.langium. */
export function findOrcristRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, GRAMMAR_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function loadLanguageAssets(start: string): LanguageAssets | undefined {
  const root = findOrcristRoot(start);
  if (!root) return undefined;
  const grammar = readFileSync(join(root, GRAMMAR_REL), 'utf8');
  const guide = existsSync(join(root, GUIDE_REL))
    ? readFileSync(join(root, GUIDE_REL), 'utf8')
    : '';
  const examples: { name: string; source: string }[] = [];
  const exDir = join(root, 'examples');
  if (existsSync(exDir)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    for (const f of readdirSync(exDir).sort()) {
      if (f.endsWith('.orc')) {
        examples.push({ name: f, source: readFileSync(join(exDir, f), 'utf8') });
      }
    }
  }
  return { root, grammar, guide, examples };
}
