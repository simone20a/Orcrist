// =====================================================================
// Compila ogni esempio in examples/ e riporta le diagnostiche.
// Esce con codice 1 se un esempio non compila: usabile in CI.
// =====================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compileModel } from '../src/language/compile.js';

const dir = resolve(process.argv[2] ?? join(import.meta.dirname, '..', 'examples'));
const files = readdirSync(dir).filter((f) => f.endsWith('.orc')).sort();

let failed = 0;

for (const f of files) {
  const text = readFileSync(join(dir, f), 'utf8');
  const res = await compileModel(text);
  const errors = res.diagnostics.filter((d) => d.severity === 'error');
  const warnings = res.diagnostics.filter((d) => d.severity === 'warning');

  const badge = res.ok ? '\x1b[32mOK\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(
    `${badge}  ${f.padEnd(28)} ${res.machine ? `${res.machine.states.length} stati, ${res.machine.locations.length} locazioni` : ''}`,
  );
  for (const d of errors) console.log(`      \x1b[31merror\x1b[0m   ${d.line + 1}:${d.column + 1}  ${d.message}`);
  for (const d of warnings) console.log(`      \x1b[33mwarning\x1b[0m ${d.line + 1}:${d.column + 1}  ${d.message}`);
  if (!res.ok) failed++;
}

console.log(`\n${files.length - failed}/${files.length} esempi compilano.`);
process.exit(failed > 0 ? 1 : 0);
