/**
 * Runtime semantics for Orcrist: the store, expression evaluation, prompt
 * rendering and coercion of LLM-reported values into declared types.
 *
 * Enum values live in the store as their bare literal name, so `#allow` and a
 * reported "allow" compare equal without a wrapper type.
 */

import type {
  Expr,
  Location,
  LocationRef,
  Machine,
  PromptTemplate,
  State,
  TypeRef,
} from './ast';
import { findLocation, refToString, typeToString } from './ast';

export type Value = boolean | number | string | RecordValue | undefined;
export interface RecordValue {
  [field: string]: Value;
}
export type Store = Record<string, Value>;

/** Initial store: declared initialisers, plus a zero value for records so that
 *  `set stats.reviewRounds = stats.reviewRounds + 1` has something to read. */
export function initStore(machine: Machine): Store {
  const store: Store = {};
  for (const l of machine.locations) {
    store[l.name] = l.init !== undefined ? evalExpr(machine, l.init, store) : defaultValue(l.type);
  }
  return store;
}

function defaultValue(t: TypeRef): Value {
  switch (t.$type) {
    case 'PrimitiveType':
      // Only records get a structural default; scalars start unset on purpose,
      // so a guard over a location nobody has written yet is simply false
      // rather than silently true.
      return undefined;
    case 'EnumType':
      return undefined;
    case 'RecordType':
      // Records are the exception: `set stats.rounds = stats.rounds + 1` has to
      // have something to read on the first visit, so their leaves start at a
      // zero value rather than unset.
      return zeroFill(t);
  }
}

/** Records need every numeric leaf to exist before arithmetic touches it. */
export function zeroFill(t: TypeRef): Value {
  switch (t.$type) {
    case 'PrimitiveType':
      switch (t.kind) {
        case 'Bool':
          return false;
        case 'Nat':
          return t.lower ?? 0;
        case 'Int':
          return t.lower !== undefined && t.lower > 0 ? t.lower : 0;
        default:
          return '';
      }
    case 'EnumType':
      return t.literals[0];
    case 'RecordType': {
      const rec: RecordValue = {};
      for (const f of t.fields) rec[f.name] = zeroFill(f.type);
      return rec;
    }
  }
}

export function readRef(machine: Machine, ref: LocationRef, store: Store): Value {
  let cur: Value = store[ref.location];
  for (const seg of ref.path) {
    if (cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as RecordValue)[seg];
  }
  return cur;
}

export function writeRef(
  machine: Machine,
  ref: LocationRef,
  value: Value,
  store: Store,
): void {
  if (ref.path.length === 0) {
    store[ref.location] = value;
    return;
  }
  const loc = findLocation(machine, ref.location);
  let cur = store[ref.location];
  if (cur === undefined || typeof cur !== 'object') {
    cur = loc ? zeroFill(loc.type) : {};
    store[ref.location] = cur;
  }
  let obj = cur as RecordValue;
  for (let i = 0; i < ref.path.length - 1; i++) {
    let nxt = obj[ref.path[i]];
    if (nxt === undefined || typeof nxt !== 'object') {
      nxt = {};
      obj[ref.path[i]] = nxt;
    }
    obj = nxt as RecordValue;
  }
  obj[ref.path[ref.path.length - 1]] = value;
}

export function evalExpr(machine: Machine, e: Expr, store: Store): Value {
  switch (e.$type) {
    case 'BoolLit':
      return e.value;
    case 'NumLit':
      return e.value;
    case 'StringLit':
      return e.value;
    case 'EnumLit':
      return e.value;
    case 'LocationRef':
      return readRef(machine, e, store);
    case 'Not': {
      const v = evalExpr(machine, e.operand, store);
      return v === undefined ? undefined : !truthy(v);
    }
    case 'Neg': {
      const v = evalExpr(machine, e.operand, store);
      return typeof v === 'number' ? -v : undefined;
    }
    case 'Binary': {
      const l = evalExpr(machine, e.left, store);
      // short-circuit, matching the usual reading of and/or
      if (e.op === 'and' && l === false) return false;
      if (e.op === 'or' && l === true) return true;
      const r = evalExpr(machine, e.right, store);
      switch (e.op) {
        case 'and':
          return l === undefined || r === undefined ? undefined : truthy(l) && truthy(r);
        case 'or':
          return l === undefined || r === undefined ? undefined : truthy(l) || truthy(r);
        case '==':
          return eq(l, r);
        case '!=': {
          const v = eq(l, r);
          return v === undefined ? undefined : !v;
        }
        case '<':
        case '<=':
        case '>':
        case '>=': {
          if (typeof l !== 'number' || typeof r !== 'number') return undefined;
          return e.op === '<' ? l < r : e.op === '<=' ? l <= r : e.op === '>' ? l > r : l >= r;
        }
        case '+':
        case '-':
        case '*':
        case '/':
        case '%': {
          if (typeof l !== 'number' || typeof r !== 'number') return undefined;
          switch (e.op) {
            case '+':
              return l + r;
            case '-':
              return l - r;
            case '*':
              return l * r;
            case '/':
              return r === 0 ? undefined : Math.trunc(l / r);
            case '%':
              return r === 0 ? undefined : l % r;
          }
        }
      }
      return undefined;
    }
  }
}

function truthy(v: Value): boolean {
  return v === true;
}

function eq(l: Value, r: Value): boolean | undefined {
  if (l === undefined || r === undefined) return undefined;
  if (typeof l === 'object' || typeof r === 'object') return JSON.stringify(l) === JSON.stringify(r);
  return l === r;
}

/** A guard only fires when it evaluates to exactly true; unknown is not true. */
export function guardHolds(machine: Machine, e: Expr, store: Store): boolean {
  return evalExpr(machine, e, store) === true;
}

/**
 * Coerce a value the LLM reported into the declared type, or explain why it
 * cannot be. Bounds are clamped rather than rejected only for numbers that are
 * off by rounding; anything outside the declared range is an error the executor
 * surfaces back to the model.
 */
export function coerce(
  type: TypeRef,
  raw: unknown,
): { ok: true; value: Value } | { ok: false; error: string } {
  switch (type.$type) {
    case 'PrimitiveType': {
      switch (type.kind) {
        case 'Bool': {
          if (typeof raw === 'boolean') return { ok: true, value: raw };
          if (raw === 'true') return { ok: true, value: true };
          if (raw === 'false') return { ok: true, value: false };
          return { ok: false, error: `expected true or false, got ${JSON.stringify(raw)}` };
        }
        case 'Nat':
        case 'Int': {
          const n = typeof raw === 'number' ? raw : Number(raw);
          if (!Number.isFinite(n)) {
            return { ok: false, error: `expected a number, got ${JSON.stringify(raw)}` };
          }
          const v = Math.trunc(n);
          if (type.kind === 'Nat' && v < 0) {
            return { ok: false, error: `expected a non-negative number, got ${v}` };
          }
          if (type.lower !== undefined && (v < type.lower || v > type.upper!)) {
            return {
              ok: false,
              error: `${v} is outside the declared range [${type.lower}..${type.upper}]`,
            };
          }
          return { ok: true, value: v };
        }
        case 'Text':
        case 'File':
          return { ok: true, value: typeof raw === 'string' ? raw : JSON.stringify(raw) };
      }
      break;
    }
    case 'EnumType': {
      const s = String(raw).replace(/^#/, '');
      if (!type.literals.includes(s)) {
        return { ok: false, error: `expected one of ${type.literals.join(', ')}, got ${JSON.stringify(raw)}` };
      }
      return { ok: true, value: s };
    }
    case 'RecordType': {
      if (typeof raw !== 'object' || raw === null) {
        return { ok: false, error: `expected an object with fields ${type.fields.map((f) => f.name).join(', ')}` };
      }
      const rec: RecordValue = {};
      for (const f of type.fields) {
        const got = (raw as Record<string, unknown>)[f.name];
        if (got === undefined) {
          return { ok: false, error: `missing field '${f.name}'` };
        }
        const r = coerce(f.type, got);
        if (!r.ok) return { ok: false, error: `field '${f.name}': ${r.error}` };
        rec[f.name] = r.value;
      }
      return { ok: true, value: rec };
    }
  }
  return { ok: false, error: `unsupported type ${typeToString(type)}` };
}

export function formatValue(v: Value): string {
  if (v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string') return v;
  return String(v);
}

/**
 * Renders a prompt template. A location the current state writes is rendered as
 * its own name (the prompt is telling the model where to put something); any
 * other location is rendered as its current value, since there the prompt is
 * feeding the model a fact it needs.
 */
export function renderPrompt(
  machine: Machine,
  template: PromptTemplate,
  state: State,
  store: Store,
): string {
  let out = '';
  for (const part of template.parts) {
    if (part.$type === 'PromptText') {
      out += part.value;
      continue;
    }
    const name = refToString(part.ref);
    const isTarget = state.writes.includes(part.ref.location);
    if (isTarget) {
      out += `\`${name}\``;
      continue;
    }
    const v = readRef(machine, part.ref, store);
    out += v === undefined ? `\`${name}\` (not set yet)` : formatValue(v);
  }
  return out;
}

/**
 * The prompt as authored, with no store to read from — interpolations stay as
 * `<name>`. This is what the approval dialog shows: the instruction the state
 * will give, before any run has filled anything in.
 */
export function promptPreview(template: PromptTemplate): string {
  return template.parts
    .map((p) => (p.$type === 'PromptText' ? p.value : `<${refToString(p.ref)}>`))
    .join('');
}

/** JSON Schema for the dynamically-built report_state_writes tool. */
export function writesSchema(machine: Machine, state: State): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
} {
  const properties: Record<string, unknown> = {};
  for (const name of state.writes) {
    const loc = findLocation(machine, name);
    if (!loc) continue;
    properties[name] = schemaFor(loc.type, loc);
  }
  return { type: 'object', properties, required: [...state.writes] };
}

function schemaFor(t: TypeRef, loc?: Location): Record<string, unknown> {
  switch (t.$type) {
    case 'PrimitiveType':
      switch (t.kind) {
        case 'Bool':
          return { type: 'boolean', description: describeLoc(loc) };
        case 'Nat':
        case 'Int': {
          const s: Record<string, unknown> = { type: 'integer', description: describeLoc(loc) };
          if (t.lower !== undefined) {
            s.minimum = t.lower;
            s.maximum = t.upper;
          } else if (t.kind === 'Nat') {
            s.minimum = 0;
          }
          return s;
        }
        case 'File':
          return {
            type: 'string',
            description: `${describeLoc(loc)} Give a path relative to the workspace root.`,
          };
        default:
          return { type: 'string', description: describeLoc(loc) };
      }
    case 'EnumType':
      return { type: 'string', enum: t.literals, description: describeLoc(loc) };
    case 'RecordType': {
      const props: Record<string, unknown> = {};
      for (const f of t.fields) props[f.name] = schemaFor(f.type);
      return {
        type: 'object',
        properties: props,
        required: t.fields.map((f) => f.name),
        description: describeLoc(loc),
      };
    }
  }
}

function describeLoc(loc?: Location): string {
  return loc ? `Value for location '${loc.name}' (${typeToString(loc.type)}).` : '';
}
