// =====================================================================
// Abbassamento AST Langium -> IR serializzabile.
// =====================================================================

import type {
  Assignment,
  Expr,
  Location,
  LocationRef,
  Machine,
  State,
  TypeRef,
} from './generated/ast.js';
import {
  isBinary,
  isBoolLit,
  isEnumLit,
  isEnumType,
  isInterpolation,
  isLocationRef,
  isNeg,
  isNot,
  isNumLit,
  isPrimitiveType,
  isRecordType,
  isStringLit,
} from './generated/ast.js';
import type {
  IRAssignment,
  IRExpr,
  IRLocation,
  IRMachine,
  IRPromptPart,
  IRState,
  IRType,
} from '../shared/ir.js';
import { exprToString } from '../shared/ir.js';

export function lowerMachine(m: Machine): IRMachine {
  return {
    name: m.name,
    locations: m.locations.map(lowerLocation),
    invariants: m.invariants.map((i) => {
      const condition = lowerExpr(i.condition);
      return { name: i.name, condition, source: exprToString(condition) };
    }),
    states: m.states.map(lowerState),
  };
}

function lowerLocation(l: Location): IRLocation {
  return {
    name: l.name,
    agentOwned: !!l.agentOwned,
    type: lowerType(l.type),
    init: l.init ? lowerExpr(l.init) : undefined,
  };
}

function lowerType(t: TypeRef | undefined): IRType {
  if (!t) return { kind: 'Text' };
  if (isPrimitiveType(t)) {
    switch (t.kind) {
      case 'Bool':
        return { kind: 'Bool' };
      case 'Text':
        return { kind: 'Text' };
      case 'File':
        return { kind: 'File' };
      case 'Nat':
        return { kind: 'Nat', lower: t.lower, upper: t.upper };
      case 'Int':
        return { kind: 'Int', lower: t.lower, upper: t.upper };
      default:
        return { kind: 'Text' };
    }
  }
  if (isEnumType(t)) return { kind: 'Enum', literals: [...t.literals] };
  if (isRecordType(t)) {
    return { kind: 'Record', fields: t.fields.map((f) => ({ name: f.name, type: lowerType(f.type) })) };
  }
  return { kind: 'Text' };
}

function lowerState(s: State): IRState {
  const prompt: IRPromptPart[] = [];
  for (const part of s.prompt?.parts ?? []) {
    if (isInterpolation(part)) {
      prompt.push({ t: 'ref', ...refParts(part.ref) });
    } else {
      prompt.push({ t: 'text', value: unquote(part.value) });
    }
  }

  return {
    name: s.name,
    initial: !!s.initial,
    final: !!s.final,
    writes: s.writes.map((w) => w.ref?.name ?? w.$refText).filter(Boolean),
    prompt,
    assignments: s.assignments.map(lowerAssignment),
    limit: s.limit
      ? {
          maxVisits: s.limit.maxVisits,
          onExceeded: s.limit.onExceeded.ref?.name ?? s.limit.onExceeded.$refText,
        }
      : undefined,
    transitions: s.transitions.map((t) => {
      const guard = lowerExpr(t.guard);
      return {
        guard,
        target: t.target.ref?.name ?? t.target.$refText,
        source: exprToString(guard),
      };
    }),
    fallback: s.fallback ? (s.fallback.target.ref?.name ?? s.fallback.target.$refText) : undefined,
  };
}

function lowerAssignment(a: Assignment): IRAssignment {
  const target = refParts(a.target);
  const value = lowerExpr(a.value);
  return {
    target,
    value,
    source: `${[target.location, ...target.path].join('.')} = ${exprToString(value)}`,
  };
}

function refParts(r: LocationRef): { location: string; path: string[] } {
  return {
    location: r.location.ref?.name ?? r.location.$refText,
    path: [...(r.path ?? [])],
  };
}

export function lowerExpr(e: Expr | undefined): IRExpr {
  if (!e) return { k: 'bool', value: false };
  if (isBinary(e)) return { k: 'bin', op: e.op, left: lowerExpr(e.left), right: lowerExpr(e.right) };
  if (isNot(e)) return { k: 'not', operand: lowerExpr(e.operand) };
  if (isNeg(e)) return { k: 'neg', operand: lowerExpr(e.operand) };
  if (isLocationRef(e)) return { k: 'ref', ...refParts(e) };
  if (isEnumLit(e)) return { k: 'enum', value: e.value };
  if (isBoolLit(e)) return { k: 'bool', value: !!e.value };
  if (isNumLit(e)) return { k: 'num', value: e.value };
  if (isStringLit(e)) return { k: 'str', value: unquote(e.value) };
  return { k: 'bool', value: false };
}

/**
 * Il terminale STRING conserva i delimitatori. Qui si tolgono e si
 * interpretano gli escape, cosi' che "\n" nel modello diventi davvero
 * un a capo nel prompt.
 */
function unquote(raw: string): string {
  if (raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw[raw.length - 1] === raw[0]) {
    raw = raw.slice(1, -1);
  }
  return raw.replace(/\\(["'\\nrt0]|u[0-9a-fA-F]{4})/g, (_m, esc: string) => {
    switch (esc[0]) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case '0':
        return '\0';
      case 'u':
        return String.fromCharCode(parseInt(esc.slice(1), 16));
      default:
        return esc;
    }
  });
}
