// =====================================================================
// IR — rappresentazione piatta e serializzabile della macchina.
//
// L'AST Langium contiene riferimenti ciclici e oggetti non clonabili:
// non puo' attraversare il confine IPC. Il compilatore lo abbassa in
// questo IR, che e' JSON puro e viene condiviso da main e renderer.
// =====================================================================

export type IRType =
  | { kind: 'Bool' }
  | { kind: 'Nat'; lower?: number; upper?: number }
  | { kind: 'Int'; lower?: number; upper?: number }
  | { kind: 'Text' }
  | { kind: 'File' }
  | { kind: 'Enum'; literals: string[] }
  | { kind: 'Record'; fields: IRField[] };

export interface IRField {
  name: string;
  type: IRType;
}

export interface IRLocation {
  name: string;
  agentOwned: boolean;
  type: IRType;
  init?: IRExpr;
}

export type IRExpr =
  | { k: 'bin'; op: string; left: IRExpr; right: IRExpr }
  | { k: 'not'; operand: IRExpr }
  | { k: 'neg'; operand: IRExpr }
  | { k: 'ref'; location: string; path: string[] }
  | { k: 'enum'; value: string }
  | { k: 'bool'; value: boolean }
  | { k: 'num'; value: number }
  | { k: 'str'; value: string };

export interface IRInvariant {
  name?: string;
  condition: IRExpr;
  /** testo sorgente ricostruito, per i messaggi d'errore */
  source: string;
}

export type IRPromptPart =
  | { t: 'text'; value: string }
  | { t: 'ref'; location: string; path: string[] };

export interface IRAssignment {
  target: { location: string; path: string[] };
  value: IRExpr;
  source: string;
}

export interface IRTransition {
  guard: IRExpr;
  target: string;
  source: string;
}

export interface IRState {
  name: string;
  initial: boolean;
  final: boolean;
  writes: string[];
  prompt: IRPromptPart[];
  assignments: IRAssignment[];
  limit?: { maxVisits: number; onExceeded: string };
  transitions: IRTransition[];
  fallback?: string;
}

export interface IRMachine {
  name: string;
  locations: IRLocation[];
  invariants: IRInvariant[];
  states: IRState[];
}

// --- Diagnostica -----------------------------------------------------

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  code?: string;
}

export interface CompileResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  machine?: IRMachine;
}

// --- Valori a runtime -------------------------------------------------

export type IRValue = boolean | number | string | { [field: string]: IRValue };

export type Store = Record<string, IRValue>;

// --- Utilita' condivise ----------------------------------------------

export function typeToString(t: IRType): string {
  switch (t.kind) {
    case 'Bool':
    case 'Text':
    case 'File':
      return t.kind;
    case 'Nat':
    case 'Int':
      return t.lower !== undefined && t.upper !== undefined
        ? `${t.kind}[${t.lower}..${t.upper}]`
        : t.kind;
    case 'Enum':
      return `{ ${t.literals.join(', ')} }`;
    case 'Record':
      return `record { ${t.fields.map((f) => `${f.name}: ${typeToString(f.type)}`).join(', ')} }`;
  }
}

export function exprToString(e: IRExpr): string {
  switch (e.k) {
    case 'bin':
      return `${exprToString(e.left)} ${e.op} ${exprToString(e.right)}`;
    case 'not':
      return `not ${exprToString(e.operand)}`;
    case 'neg':
      return `-${exprToString(e.operand)}`;
    case 'ref':
      return [e.location, ...e.path].join('.');
    case 'enum':
      return `#${e.value}`;
    case 'bool':
      return String(e.value);
    case 'num':
      return String(e.value);
    case 'str':
      return JSON.stringify(e.value);
  }
}

/** Valore neutro di un tipo, usato quando una locazione non ha 'init'. */
export function defaultValue(t: IRType): IRValue {
  switch (t.kind) {
    case 'Bool':
      return false;
    case 'Nat':
      return t.lower ?? 0;
    case 'Int':
      return t.lower ?? 0;
    case 'Text':
    case 'File':
      return '';
    case 'Enum':
      return t.literals[0] ?? '';
    case 'Record': {
      const o: Record<string, IRValue> = {};
      for (const f of t.fields) o[f.name] = defaultValue(f.type);
      return o;
    }
  }
}

export function findType(loc: IRLocation, path: string[]): IRType | undefined {
  let t: IRType = loc.type;
  for (const seg of path) {
    if (t.kind !== 'Record') return undefined;
    const f = t.fields.find((x) => x.name === seg);
    if (!f) return undefined;
    t = f.type;
  }
  return t;
}
