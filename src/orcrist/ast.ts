/**
 * Orcrist AST — a direct TypeScript transcription of the metamodel section of
 * `metamodel/orcrist.langium`. Cross-references (`@Location`, `@State`) are kept
 * as names here and resolved by the validator, which is enough for an
 * interpreter and keeps the AST JSON-serialisable across the IPC boundary.
 */

export type PrimitiveKind = 'Bool' | 'Nat' | 'Int' | 'Text' | 'File';

export interface PrimitiveType {
  $type: 'PrimitiveType';
  kind: PrimitiveKind;
  lower?: number;
  upper?: number;
}

export interface EnumType {
  $type: 'EnumType';
  literals: string[];
}

export interface RecordType {
  $type: 'RecordType';
  fields: Field[];
}

export type TypeRef = PrimitiveType | EnumType | RecordType;

export interface Field {
  name: string;
  type: TypeRef;
}

/**
 * Who is allowed to write a location — the three-way split the language is
 * built around.
 *
 *   agent      the LLM reports it, so a guard reading it is a self-report
 *   observed   the runtime measures it by running a command, so a guard
 *              reading it is a fact about the world
 *   assignable the runtime derives it from the store with `set`, so a guard
 *              reading it is a deterministic function of what is already known
 */
export type Ownership = 'agent' | 'observed' | 'assignable';

export interface Location {
  ownership: Ownership;
  /** kept as its own field because most of the app only asks this one question */
  agentOwned: boolean;
  name: string;
  type: TypeRef;
  init?: Expr;
  line: number;
}

export interface Invariant {
  name?: string;
  condition: Expr;
  line: number;
}

export interface PromptText {
  $type: 'PromptText';
  value: string;
}

export interface Interpolation {
  $type: 'Interpolation';
  ref: LocationRef;
}

export type PromptPart = PromptText | Interpolation;

export interface PromptTemplate {
  parts: PromptPart[];
}

export interface Assignment {
  target: LocationRef;
  value: Expr;
  line: number;
}

/**
 * A value measured by the runtime rather than claimed by the model: the command
 * is run in the workspace, and either its exit code or the first capture group
 * of `pattern` becomes the location's new value.
 */
export interface Observation {
  /** name of the Location being measured */
  target: string;
  command: string;
  /** regex source; capture group 1 is the value. Absent means "use the exit code". */
  pattern?: string;
  /** value to use when the command ran but the pattern found nothing */
  fallback?: Expr;
  line: number;
}

export interface VisitLimit {
  maxVisits: number;
  /** name of the target State */
  onExceeded: string;
  line: number;
}

export interface Transition {
  guard: Expr;
  /** name of the target State */
  target: string;
  line: number;
}

export interface Fallback {
  /** name of the target State */
  target: string;
  line: number;
}

export interface State {
  initial: boolean;
  final: boolean;
  name: string;
  /** names of Locations */
  writes: string[];
  /** names of the tools this state may use; absent means every enabled tool */
  tools?: string[];
  prompt?: PromptTemplate;
  observations: Observation[];
  assignments: Assignment[];
  limit?: VisitLimit;
  transitions: Transition[];
  fallback?: Fallback;
  line: number;
}

export interface Machine {
  name: string;
  locations: Location[];
  invariants: Invariant[];
  states: State[];
}

// --- Expressions ------------------------------------------------------

export interface Binary {
  $type: 'Binary';
  left: Expr;
  op: string;
  right: Expr;
}

export interface Not {
  $type: 'Not';
  operand: Expr;
}

export interface Neg {
  $type: 'Neg';
  operand: Expr;
}

export interface LocationRef {
  $type: 'LocationRef';
  /** name of the Location */
  location: string;
  path: string[];
  line: number;
}

export interface EnumLit {
  $type: 'EnumLit';
  value: string;
}

export interface BoolLit {
  $type: 'BoolLit';
  value: boolean;
}

export interface NumLit {
  $type: 'NumLit';
  value: number;
}

export interface StringLit {
  $type: 'StringLit';
  value: string;
}

export type Expr =
  | Binary
  | Not
  | Neg
  | LocationRef
  | EnumLit
  | BoolLit
  | NumLit
  | StringLit;

// --- Helpers ----------------------------------------------------------

export function refToString(ref: LocationRef): string {
  return [ref.location, ...ref.path].join('.');
}

/** Renders an expression back to Orcrist concrete syntax (for logs / UI). */
export function exprToString(e: Expr): string {
  switch (e.$type) {
    case 'Binary':
      return `${exprToString(e.left)} ${e.op} ${exprToString(e.right)}`;
    case 'Not':
      return `not ${exprToString(e.operand)}`;
    case 'Neg':
      return `-${exprToString(e.operand)}`;
    case 'LocationRef':
      return refToString(e);
    case 'EnumLit':
      return `#${e.value}`;
    case 'BoolLit':
      return String(e.value);
    case 'NumLit':
      return String(e.value);
    case 'StringLit':
      return JSON.stringify(e.value);
  }
}

export function typeToString(t: TypeRef): string {
  switch (t.$type) {
    case 'PrimitiveType':
      return t.lower !== undefined && t.upper !== undefined
        ? `${t.kind}[${t.lower}..${t.upper}]`
        : t.kind;
    case 'EnumType':
      return `{ ${t.literals.join(', ')} }`;
    case 'RecordType':
      return `record { ${t.fields
        .map((f) => `${f.name}: ${typeToString(f.type)}`)
        .join(', ')} }`;
  }
}

export function findLocation(m: Machine, name: string): Location | undefined {
  return m.locations.find((l) => l.name === name);
}

export function findState(m: Machine, name: string): State | undefined {
  return m.states.find((s) => s.name === name);
}

export function initialState(m: Machine): State | undefined {
  return m.states.find((s) => s.initial);
}

/** All state names a state can move to (guards, fallback, limit escape). */
export function successors(s: State): string[] {
  const out: string[] = [];
  for (const t of s.transitions) out.push(t.target);
  if (s.fallback) out.push(s.fallback.target);
  if (s.limit) out.push(s.limit.onExceeded);
  return out;
}
