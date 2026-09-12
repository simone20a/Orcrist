/**
 * A small type system over the Orcrist metamodel: enough to catch the mistakes
 * section 9 of the authoring guide warns about (guards comparing incompatible
 * things, enum literals that aren't in the enum, field paths that don't exist,
 * writes to assignable locations) without pretending to be a full checker.
 */

import type {
  Expr,
  Field,
  LocationRef,
  Machine,
  RecordType,
  TypeRef,
} from './ast';
import { findLocation, refToString, typeToString } from './ast';

export type Inferred =
  | { k: 'bool' }
  | { k: 'num'; lower?: number; upper?: number }
  | { k: 'text' }
  | { k: 'file' }
  | { k: 'enum'; literals: string[] }
  | { k: 'enumlit'; value: string }
  | { k: 'record'; fields: Field[] }
  | { k: 'unknown' };

export function fromTypeRef(t: TypeRef): Inferred {
  switch (t.$type) {
    case 'PrimitiveType':
      switch (t.kind) {
        case 'Bool':
          return { k: 'bool' };
        case 'Nat':
        case 'Int':
          return { k: 'num', lower: t.lower, upper: t.upper };
        case 'Text':
          return { k: 'text' };
        case 'File':
          return { k: 'file' };
      }
      break;
    case 'EnumType':
      return { k: 'enum', literals: t.literals };
    case 'RecordType':
      return { k: 'record', fields: t.fields };
  }
  return { k: 'unknown' };
}

export function describe(t: Inferred): string {
  switch (t.k) {
    case 'bool':
      return 'Bool';
    case 'num':
      return t.lower !== undefined ? `Nat/Int[${t.lower}..${t.upper}]` : 'Nat/Int';
    case 'text':
      return 'Text';
    case 'file':
      return 'File';
    case 'enum':
      return `{ ${t.literals.join(', ')} }`;
    case 'enumlit':
      return `#${t.value}`;
    case 'record':
      return 'record';
    case 'unknown':
      return 'unknown';
  }
}

/** Resolves `a.b.c` against the machine's declared locations. */
export function resolveRefType(
  machine: Machine,
  ref: LocationRef,
): { type?: TypeRef; error?: string } {
  const loc = findLocation(machine, ref.location);
  if (!loc) return { error: `unknown location '${ref.location}'` };
  let cur: TypeRef = loc.type;
  for (const seg of ref.path) {
    if (cur.$type !== 'RecordType') {
      return {
        error: `'${refToString(ref)}': '${seg}' is a field access but the value has type ${typeToString(cur)}`,
      };
    }
    const field: Field | undefined = (cur as RecordType).fields.find((f) => f.name === seg);
    if (!field) {
      return {
        error: `'${refToString(ref)}': record has no field '${seg}' (has ${(cur as RecordType).fields
          .map((f) => f.name)
          .join(', ')})`,
      };
    }
    cur = field.type;
  }
  return { type: cur };
}

const NUMERIC_OPS = new Set(['+', '-', '*', '/', '%']);
const ORDER_OPS = new Set(['<', '<=', '>', '>=']);
const EQ_OPS = new Set(['==', '!=']);
const BOOL_OPS = new Set(['and', 'or']);

/** Are two inferred types comparable with == / != ? */
export function comparable(a: Inferred, b: Inferred): boolean {
  if (a.k === 'unknown' || b.k === 'unknown') return true;
  if (a.k === 'enumlit' && b.k === 'enum') return b.literals.includes(a.value);
  if (b.k === 'enumlit' && a.k === 'enum') return a.literals.includes(b.value);
  if (a.k === 'enumlit' && b.k === 'enumlit') return true;
  if (a.k === 'file' && b.k === 'text') return true;
  if (a.k === 'text' && b.k === 'file') return true;
  return a.k === b.k;
}

/** Can a value of type `value` be stored into a location of type `target`? */
export function assignable(target: Inferred, value: Inferred): boolean {
  if (target.k === 'unknown' || value.k === 'unknown') return true;
  if (target.k === 'enum' && value.k === 'enumlit') return target.literals.includes(value.value);
  if (target.k === 'file' && value.k === 'text') return true;
  if (target.k === 'text' && value.k === 'file') return true;
  return target.k === value.k;
}

export function inferExpr(
  machine: Machine,
  e: Expr,
  report: (msg: string, line: number) => void,
  line: number,
): Inferred {
  switch (e.$type) {
    case 'BoolLit':
      return { k: 'bool' };
    case 'NumLit':
      return { k: 'num' };
    case 'StringLit':
      return { k: 'text' };
    case 'EnumLit':
      return { k: 'enumlit', value: e.value };
    case 'LocationRef': {
      const r = resolveRefType(machine, e);
      if (r.error) {
        report(r.error, e.line);
        return { k: 'unknown' };
      }
      return fromTypeRef(r.type!);
    }
    case 'Not': {
      const t = inferExpr(machine, e.operand, report, line);
      if (t.k !== 'bool' && t.k !== 'unknown') {
        report(`'not' applied to a ${describe(t)} value; it needs a Bool`, line);
      }
      return { k: 'bool' };
    }
    case 'Neg': {
      const t = inferExpr(machine, e.operand, report, line);
      if (t.k !== 'num' && t.k !== 'unknown') {
        report(`unary '-' applied to a ${describe(t)} value; it needs a number`, line);
      }
      return { k: 'num' };
    }
    case 'Binary': {
      const l = inferExpr(machine, e.left, report, line);
      const r = inferExpr(machine, e.right, report, line);
      if (BOOL_OPS.has(e.op)) {
        for (const [side, t] of [
          ['left', l],
          ['right', r],
        ] as const) {
          if (t.k !== 'bool' && t.k !== 'unknown') {
            report(`'${e.op}' needs Bool operands, but the ${side} side is ${describe(t)}`, line);
          }
        }
        return { k: 'bool' };
      }
      if (EQ_OPS.has(e.op)) {
        if (!comparable(l, r)) {
          report(
            `'${e.op}' compares ${describe(l)} with ${describe(r)}, which can never be equal`,
            line,
          );
        }
        return { k: 'bool' };
      }
      if (ORDER_OPS.has(e.op)) {
        for (const [side, t] of [
          ['left', l],
          ['right', r],
        ] as const) {
          if (t.k !== 'num' && t.k !== 'unknown') {
            report(`'${e.op}' needs numeric operands, but the ${side} side is ${describe(t)}`, line);
          }
        }
        return { k: 'bool' };
      }
      if (NUMERIC_OPS.has(e.op)) {
        for (const [side, t] of [
          ['left', l],
          ['right', r],
        ] as const) {
          if (t.k !== 'num' && t.k !== 'unknown') {
            report(`'${e.op}' needs numeric operands, but the ${side} side is ${describe(t)}`, line);
          }
        }
        return { k: 'num' };
      }
      return { k: 'unknown' };
    }
  }
}
