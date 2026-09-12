export * from './ast';
export * from './lexer';
export * from './parser';
export * from './typing';
export * from './validator';
export * from './evaluator';
export * from './layout';

import type { Machine } from './ast';
import { parse, type Diagnostic } from './parser';
import { validate, type ValidateOptions } from './validator';

export interface CheckResult {
  machine?: Machine;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

/** Parse then validate — the single entry point the app uses. */
export function checkModel(source: string, options: ValidateOptions = {}): CheckResult {
  const p = parse(source);
  if (!p.machine) return { errors: p.errors, warnings: [] };
  const v = validate(p.machine, options);
  return { machine: v.errors.length ? undefined : p.machine, errors: v.errors, warnings: v.warnings };
}
