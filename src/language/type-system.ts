// =====================================================================
// Sistema di tipi statico per Orcrist.
//
// Lavora sull'AST Langium. Serve al validatore per rifiutare guardie,
// invarianti, assegnazioni e inizializzatori mal tipati prima che il
// modello arrivi al runtime.
// =====================================================================

import type { Expr, Location, LocationRef, TypeRef } from './generated/ast.js';
import { isBinary, isBoolLit, isEnumLit, isEnumType, isLocationRef, isNeg, isNot, isNumLit, isPrimitiveType, isRecordType, isStringLit } from './generated/ast.js';

export type SType =
  | { k: 'Bool' }
  | { k: 'Num'; signed: boolean; lower?: number; upper?: number }
  | { k: 'Text' }
  | { k: 'File' }
  | { k: 'Enum'; literals: string[] }
  | { k: 'EnumLit'; value: string }   // letterale #foo, tipo ancora aperto
  | { k: 'Record'; fields: Array<{ name: string; type: SType }> }
  | { k: 'Error' };

export const ERR: SType = { k: 'Error' };

export function stypeToString(t: SType): string {
  switch (t.k) {
    case 'Bool':
      return 'Bool';
    case 'Num':
      return t.signed ? 'Int' : 'Nat';
    case 'Text':
      return 'Text';
    case 'File':
      return 'File';
    case 'Enum':
      return `{ ${t.literals.join(', ')} }`;
    case 'EnumLit':
      return `#${t.value}`;
    case 'Record':
      return `record { ${t.fields.map((f) => `${f.name}: ${stypeToString(f.type)}`).join(', ')} }`;
    case 'Error':
      return '<errore>';
  }
}

export function fromTypeRef(ref: TypeRef | undefined): SType {
  if (!ref) return ERR;
  if (isPrimitiveType(ref)) {
    switch (ref.kind) {
      case 'Bool':
        return { k: 'Bool' };
      case 'Text':
        return { k: 'Text' };
      case 'File':
        return { k: 'File' };
      case 'Nat':
        return { k: 'Num', signed: false, lower: ref.lower, upper: ref.upper };
      case 'Int':
        return { k: 'Num', signed: true, lower: ref.lower, upper: ref.upper };
      default:
        return ERR;
    }
  }
  if (isEnumType(ref)) return { k: 'Enum', literals: [...ref.literals] };
  if (isRecordType(ref)) {
    return {
      k: 'Record',
      fields: ref.fields.map((f) => ({ name: f.name, type: fromTypeRef(f.type) })),
    };
  }
  return ERR;
}

/** Risolve `loc.a.b` scendendo nei record. `undefined` se il path non esiste. */
export function resolvePath(base: SType, path: string[]): SType | undefined {
  let t = base;
  for (const seg of path) {
    if (t.k !== 'Record') return undefined;
    const f = t.fields.find((x) => x.name === seg);
    if (!f) return undefined;
    t = f.type;
  }
  return t;
}

export function typeOfRef(ref: LocationRef): SType {
  const loc = ref.location.ref as Location | undefined;
  if (!loc) return ERR;
  const resolved = resolvePath(fromTypeRef(loc.type), ref.path ?? []);
  return resolved ?? ERR;
}

const NUM_OPS = new Set(['+', '-', '*', '/', '%']);
const ORD_OPS = new Set(['<', '>', '<=', '>=']);
const EQ_OPS = new Set(['==', '!=']);
const BOOL_OPS = new Set(['and', 'or']);

export interface TypeIssue {
  node: Expr;
  message: string;
}

/**
 * Inferisce il tipo di un'espressione accumulando gli errori in `issues`.
 * Restituisce `Error` per propagare senza generare errori a cascata.
 */
export function inferType(expr: Expr | undefined, issues: TypeIssue[]): SType {
  if (!expr) return ERR;

  if (isBoolLit(expr)) return { k: 'Bool' };
  if (isNumLit(expr)) return { k: 'Num', signed: false };
  if (isStringLit(expr)) return { k: 'Text' };
  if (isEnumLit(expr)) return { k: 'EnumLit', value: expr.value };

  if (isLocationRef(expr)) {
    const loc = expr.location.ref;
    if (!loc) return ERR; // il linker ha gia' segnalato
    const t = resolvePath(fromTypeRef(loc.type), expr.path ?? []);
    if (!t) {
      issues.push({
        node: expr,
        message: `'${[loc.name, ...(expr.path ?? [])].join('.')}' non e' un campo valido di '${loc.name}'.`,
      });
      return ERR;
    }
    return t;
  }

  if (isNeg(expr)) {
    const t = inferType(expr.operand, issues);
    if (t.k !== 'Error' && t.k !== 'Num') {
      issues.push({ node: expr, message: `Il meno unario richiede un numero, trovato ${stypeToString(t)}.` });
    }
    // Il risultato e' sempre con segno: '-x' puo' uscire dai Nat.
    return { k: 'Num', signed: true };
  }

  if (isNot(expr)) {
    const t = inferType(expr.operand, issues);
    if (t.k !== 'Error' && t.k !== 'Bool') {
      issues.push({ node: expr, message: `'not' richiede un Bool, trovato ${stypeToString(t)}.` });
    }
    return { k: 'Bool' };
  }

  if (isBinary(expr)) {
    const l = inferType(expr.left, issues);
    const r = inferType(expr.right, issues);
    const op = expr.op;

    if (BOOL_OPS.has(op)) {
      for (const [t, side] of [[l, 'sinistro'], [r, 'destro']] as const) {
        if (t.k !== 'Error' && t.k !== 'Bool') {
          issues.push({
            node: expr,
            message: `L'operando ${side} di '${op}' deve essere Bool, trovato ${stypeToString(t)}.`,
          });
        }
      }
      return { k: 'Bool' };
    }

    if (NUM_OPS.has(op)) {
      for (const [t, side] of [[l, 'sinistro'], [r, 'destro']] as const) {
        if (t.k !== 'Error' && t.k !== 'Num') {
          issues.push({
            node: expr,
            message: `L'operando ${side} di '${op}' deve essere numerico, trovato ${stypeToString(t)}.`,
          });
        }
      }
      const signed = (l.k === 'Num' && l.signed) || (r.k === 'Num' && r.signed) || op === '-';
      return { k: 'Num', signed };
    }

    if (ORD_OPS.has(op)) {
      for (const [t, side] of [[l, 'sinistro'], [r, 'destro']] as const) {
        if (t.k !== 'Error' && t.k !== 'Num') {
          issues.push({
            node: expr,
            message: `'${op}' confronta solo numeri, operando ${side} di tipo ${stypeToString(t)}.`,
          });
        }
      }
      return { k: 'Bool' };
    }

    if (EQ_OPS.has(op)) {
      const problem = comparabilityError(l, r);
      if (problem) issues.push({ node: expr, message: problem });
      return { k: 'Bool' };
    }

    issues.push({ node: expr, message: `Operatore sconosciuto '${op}'.` });
    return ERR;
  }

  return ERR;
}

/** `undefined` se i due tipi si possono confrontare con == / != . */
export function comparabilityError(l: SType, r: SType): string | undefined {
  if (l.k === 'Error' || r.k === 'Error') return undefined;

  // Letterale enum contro tipo enum: il letterale deve appartenere al dominio.
  const pairs: Array<[SType, SType]> = [
    [l, r],
    [r, l],
  ];
  for (const [a, b] of pairs) {
    if (a.k === 'EnumLit' && b.k === 'Enum') {
      return b.literals.includes(a.value)
        ? undefined
        : `Il letterale '#${a.value}' non appartiene al dominio ${stypeToString(b)}.`;
    }
  }
  if (l.k === 'EnumLit' && r.k === 'EnumLit') {
    return l.value === r.value ? undefined : undefined; // confronto costante, inutile ma legale
  }
  if (l.k === 'EnumLit' || r.k === 'EnumLit') {
    const other = l.k === 'EnumLit' ? r : l;
    return `Un letterale enum si confronta solo con una locazione enum, non con ${stypeToString(other)}.`;
  }

  if (l.k === 'Record' || r.k === 'Record') {
    return `I record non si confrontano direttamente: usa un campo (${stypeToString(l)} == ${stypeToString(r)}).`;
  }

  const textual = (t: SType) => t.k === 'Text' || t.k === 'File';
  if (textual(l) && textual(r)) return undefined;
  if (l.k === r.k) return undefined;

  return `Confronto fra tipi incompatibili: ${stypeToString(l)} e ${stypeToString(r)}.`;
}

/** `undefined` se un valore di tipo `value` puo' essere scritto in `target`. */
export function assignabilityError(target: SType, value: SType): string | undefined {
  if (target.k === 'Error' || value.k === 'Error') return undefined;

  if (target.k === 'Enum') {
    if (value.k === 'EnumLit') {
      return target.literals.includes(value.value)
        ? undefined
        : `'#${value.value}' non appartiene al dominio ${stypeToString(target)}.`;
    }
    if (value.k === 'Enum') return undefined;
    return `Attesa una costante enum di ${stypeToString(target)}, trovato ${stypeToString(value)}.`;
  }

  if (target.k === 'Num') {
    if (value.k !== 'Num') return `Atteso ${stypeToString(target)}, trovato ${stypeToString(value)}.`;
    if (!target.signed && value.signed) {
      return `Un valore Int puo' diventare negativo: la destinazione e' Nat.`;
    }
    return undefined;
  }

  if (target.k === 'Text' || target.k === 'File') {
    return value.k === 'Text' || value.k === 'File'
      ? undefined
      : `Atteso ${stypeToString(target)}, trovato ${stypeToString(value)}.`;
  }

  if (target.k === 'Bool') {
    return value.k === 'Bool' ? undefined : `Atteso Bool, trovato ${stypeToString(value)}.`;
  }

  if (target.k === 'Record') {
    return `Non si assegna un record intero: assegna i singoli campi.`;
  }

  return undefined;
}

/** Costante numerica, se l'espressione lo e'. Serve al controllo dei bound. */
export function constNumber(expr: Expr | undefined): number | undefined {
  if (!expr) return undefined;
  if (isNumLit(expr)) return expr.value;
  if (isNeg(expr)) {
    const inner = constNumber(expr.operand);
    return inner === undefined ? undefined : -inner;
  }
  if (isBinary(expr)) {
    const l = constNumber(expr.left);
    const r = constNumber(expr.right);
    if (l === undefined || r === undefined) return undefined;
    switch (expr.op) {
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
      default:
        return undefined;
    }
  }
  return undefined;
}
