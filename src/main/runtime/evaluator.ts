// =====================================================================
// Valutazione di espressioni e store a runtime.
//
// Il validatore ha gia' scartato i modelli mal tipati, quindi qui si
// puo' assumere buona forma; resta la difesa contro i valori che
// arrivano dall'LLM, che possono essere qualunque cosa.
//
// Quando un valore va corretto per rientrare nel tipo — un numero
// fuori dai bound, un letterale enum inventato — la correzione non
// avviene in silenzio: viene raccolta e riportata a chi guarda.
// =====================================================================

import type { IRExpr, IRLocation, IRType, IRValue, Store } from '../../shared/ir.js';
import { defaultValue, findType } from '../../shared/ir.js';

/** Una correzione applicata a un valore per farlo rientrare nel tipo. */
export type CoerceIssue =
  | { kind: 'clamped'; path: string; from: number; to: number }
  | { kind: 'enum'; path: string; got: string; used: string; domain: string[] };

export function initialStore(locations: IRLocation[]): Store {
  const store: Store = {};
  for (const loc of locations) {
    store[loc.name] = loc.init ? evalExpr(loc.init, store) : defaultValue(loc.type);
  }
  return store;
}

export function readPath(store: Store, location: string, path: string[]): IRValue {
  let cur: IRValue | undefined = store[location];
  for (const seg of path) {
    if (cur === undefined || cur === null || typeof cur !== 'object') return '';
    cur = (cur as Record<string, IRValue>)[seg];
  }
  return cur ?? '';
}

export interface WriteOutcome {
  issues: CoerceIssue[];
}

export function writePath(
  store: Store,
  locations: IRLocation[],
  location: string,
  path: string[],
  value: IRValue,
): WriteOutcome {
  const loc = locations.find((l) => l.name === location);
  const type = loc ? findType(loc, path) : undefined;
  const issues: CoerceIssue[] = [];
  const label = [location, ...path].join('.');
  const final = type ? coerce(value, type, label, issues) : value;

  if (path.length === 0) {
    store[location] = final;
    return { issues };
  }

  let cur = store[location];
  if (typeof cur !== 'object' || cur === null) {
    cur = {};
    store[location] = cur;
  }
  let node = cur as Record<string, IRValue>;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    const next = node[seg];
    if (typeof next !== 'object' || next === null) node[seg] = {};
    node = node[seg] as Record<string, IRValue>;
  }
  node[path[path.length - 1]] = final;
  return { issues };
}

/**
 * Riporta un valore arbitrario nel dominio del tipo dichiarato.
 *
 * Ricorsiva sui record: i bound di un campo valgono quanto quelli di
 * una locazione di primo livello, altrimenti 'record { n: Nat[0..5] }'
 * sarebbe un limite solo sulla carta.
 */
export function coerce(value: unknown, type: IRType, path = '', issues: CoerceIssue[] = []): IRValue {
  switch (type.kind) {
    case 'Bool':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') return value.toLowerCase() === 'true';
      if (typeof value === 'number') return value !== 0;
      return false;

    case 'Nat':
    case 'Int': {
      const raw = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(raw)) return type.lower ?? 0;
      const before = Math.trunc(raw);
      let n = before;
      if (type.lower !== undefined && n < type.lower) n = type.lower;
      if (type.upper !== undefined && n > type.upper) n = type.upper;
      if (type.kind === 'Nat' && n < 0) n = 0;
      if (n !== before) issues.push({ kind: 'clamped', path, from: before, to: n });
      return n;
    }

    case 'Text':
    case 'File':
      if (typeof value === 'string') return value;
      if (value === undefined || value === null) return '';
      return typeof value === 'object' ? JSON.stringify(value) : String(value);

    case 'Enum': {
      const got = typeof value === 'string' ? value.replace(/^#/, '') : String(value ?? '');
      if (type.literals.includes(got)) return got;
      const used = type.literals[0] ?? '';
      issues.push({ kind: 'enum', path, got, used, domain: [...type.literals] });
      return used;
    }

    case 'Record': {
      const out: Record<string, IRValue> = {};
      const src = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
      for (const f of type.fields) {
        const child = path ? `${path}.${f.name}` : f.name;
        out[f.name] = f.name in src ? coerce(src[f.name], f.type, child, issues) : defaultValue(f.type);
      }
      return out;
    }
  }
}

/** Segnalazioni prodotte durante la valutazione di un'espressione. */
export type EvalReporter = (message: string) => void;

export function evalExpr(e: IRExpr, store: Store, report?: EvalReporter): IRValue {
  switch (e.k) {
    case 'bool':
    case 'num':
    case 'str':
      return e.value;
    case 'enum':
      return e.value;
    case 'ref':
      return readPath(store, e.location, e.path);
    case 'not':
      return !truthy(evalExpr(e.operand, store, report));
    case 'neg':
      return -num(evalExpr(e.operand, store, report));
    case 'bin': {
      // corto circuito: importa quando un ramo legge un campo assente
      if (e.op === 'and') {
        return truthy(evalExpr(e.left, store, report)) && truthy(evalExpr(e.right, store, report));
      }
      if (e.op === 'or') {
        return truthy(evalExpr(e.left, store, report)) || truthy(evalExpr(e.right, store, report));
      }

      const l = evalExpr(e.left, store, report);
      const r = evalExpr(e.right, store, report);

      switch (e.op) {
        case '==':
          return equals(l, r);
        case '!=':
          return !equals(l, r);
        case '<':
          return num(l) < num(r);
        case '>':
          return num(l) > num(r);
        case '<=':
          return num(l) <= num(r);
        case '>=':
          return num(l) >= num(r);
        case '+':
          return num(l) + num(r);
        case '-':
          return num(l) - num(r);
        case '*':
          return num(l) * num(r);
        // Il DSL non ha un valore indefinito: dividere per zero deve
        // pur restituire qualcosa, ma passarlo sotto silenzio
        // nasconderebbe un modello sbagliato.
        case '/':
          if (num(r) === 0) {
            report?.('Divisione per zero: il risultato vale 0.');
            return 0;
          }
          return Math.trunc(num(l) / num(r));
        case '%':
          if (num(r) === 0) {
            report?.('Divisione per zero nel modulo: il risultato vale 0.');
            return 0;
          }
          return num(l) % num(r);
        default:
          return false;
      }
    }
  }
}

export function truthy(v: IRValue): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  return v !== null && v !== undefined;
}

function num(v: IRValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function equals(a: IRValue, b: IRValue): boolean {
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  if (typeof a === 'number' || typeof b === 'number') {
    // il confronto fra un numero e la sua forma testuale non deve fallire
    if (typeof a === 'string' || typeof b === 'string') return String(a) === String(b);
  }
  return a === b;
}

/** Rende un valore leggibile dentro un prompt. */
export function renderValue(v: IRValue): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v, null, 2);
}

/**
 * Tutti i percorsi di tipo File dentro un valore, con la stringa che
 * contengono. Serve a controllare che un File sia davvero un percorso
 * del workspace e non un testo qualunque.
 */
export function collectFilePaths(
  type: IRType,
  value: IRValue,
  prefix: string,
  out: Array<{ path: string; value: string }> = [],
): Array<{ path: string; value: string }> {
  if (type.kind === 'File') {
    if (typeof value === 'string' && value.trim()) out.push({ path: prefix, value: value.trim() });
    return out;
  }
  if (type.kind === 'Record' && typeof value === 'object' && value !== null) {
    for (const f of type.fields) {
      collectFilePaths(f.type, (value as Record<string, IRValue>)[f.name] ?? '', `${prefix}.${f.name}`, out);
    }
  }
  return out;
}
