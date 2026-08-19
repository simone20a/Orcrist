// =====================================================================
// Validatore semantico.
//
// Copre i vincoli che la grammatica non puo' esprimere:
//   ownership     chi puo' scrivere una locazione
//   tipi          guardie, invarianti, assegnazioni, init
//   totalita'     ogni stato attivo ha prompt e uscita (gia' in grammatica)
//   determinismo  guardie non mascherate, nessun ramo morto
//   raggiungibilita'  un solo initial, ogni stato raggiungibile, un final
//                     raggiungibile da ogni stato attivo
//   terminazione  ogni ciclo attraversa uno stato con 'limit'
// =====================================================================

import type { ValidationAcceptor, ValidationChecks } from 'langium';
import { AstUtils } from 'langium';
import type {
  Assignment,
  Expr,
  Invariant,
  Location,
  Machine,
  OrcristAstType,
  State,
  Transition,
  VisitLimit,
} from './generated/ast.js';
import { isBinary, isBoolLit, isEnumLit, isEnumType, isLocationRef, isNeg, isNot, isNumLit, isRecordType, isStringLit, isInterpolation } from './generated/ast.js';
import type { OrcristServices } from './orcrist-module.js';
import {
  assignabilityError,
  constNumber,
  fromTypeRef,
  inferType,
  resolvePath,
  stypeToString,
  typeOfRef,
  type TypeIssue,
} from './type-system.js';

export function registerValidationChecks(services: OrcristServices): void {
  const registry = services.validation.ValidationRegistry;
  const v = new OrcristValidator();
  const checks: ValidationChecks<OrcristAstType> = {
    Machine: [
      v.uniqueLocationNames,
      v.uniqueStateNames,
      v.exactlyOneInitialState,
      v.hasFinalState,
      v.allStatesReachable,
      v.finalStateReachable,
      v.cyclesAreBounded,
      v.invariantsMentionAssignableState,
    ],
    Location: [v.locationTypeWellFormed, v.locationInitWellTyped, v.locationHasWriter],
    State: [v.writesAreAgentOwned, v.promptInterpolationsValid, v.transitionsDeterministic, v.noSelfDefeatingLimit],
    Assignment: [v.assignmentTargetIsAssignable, v.assignmentWellTyped],
    Transition: [v.guardIsBool, v.guardReadsWrittenState],
    Invariant: [v.invariantIsBool],
    VisitLimit: [v.limitIsPositive],
  };
  registry.register(checks, v);
}

export class OrcristValidator {
  // ---------------------------------------------------------------- nomi

  uniqueLocationNames(machine: Machine, accept: ValidationAcceptor): void {
    const seen = new Map<string, Location>();
    for (const loc of machine.locations) {
      if (seen.has(loc.name)) {
        accept('error', `Locazione '${loc.name}' dichiarata piu' di una volta.`, {
          node: loc,
          property: 'name',
          code: 'duplicate-location',
        });
      }
      seen.set(loc.name, loc);
      // campi dei record e letterali enum unici
      const t = loc.type;
      if (isRecordType(t)) {
        const fields = new Set<string>();
        for (const f of t.fields) {
          if (fields.has(f.name)) {
            accept('error', `Campo '${f.name}' duplicato nel record '${loc.name}'.`, {
              node: f,
              property: 'name',
            });
          }
          fields.add(f.name);
        }
      }
      if (isEnumType(t)) {
        const lits = new Set<string>();
        for (const l of t.literals) {
          if (lits.has(l)) {
            accept('error', `Letterale '${l}' duplicato nell'enum '${loc.name}'.`, { node: loc });
          }
          lits.add(l);
        }
      }
    }
  }

  uniqueStateNames(machine: Machine, accept: ValidationAcceptor): void {
    const seen = new Set<string>();
    for (const s of machine.states) {
      if (seen.has(s.name)) {
        accept('error', `Stato '${s.name}' dichiarato piu' di una volta.`, {
          node: s,
          property: 'name',
          code: 'duplicate-state',
        });
      }
      seen.add(s.name);
    }
  }

  // -------------------------------------------------------- struttura FSM

  exactlyOneInitialState(machine: Machine, accept: ValidationAcceptor): void {
    const initials = machine.states.filter((s) => s.initial);
    if (initials.length === 0) {
      accept('error', `La macchina '${machine.name}' non ha uno stato iniziale: marca uno stato con 'initial'.`, {
        node: machine,
        property: 'name',
        code: 'no-initial',
      });
    } else if (initials.length > 1) {
      for (const s of initials.slice(1)) {
        accept('error', `Piu' di uno stato iniziale: '${initials[0].name}' e' gia' marcato 'initial'.`, {
          node: s,
          property: 'name',
          code: 'many-initial',
        });
      }
    }
  }

  hasFinalState(machine: Machine, accept: ValidationAcceptor): void {
    if (!machine.states.some((s) => s.final)) {
      accept('error', `La macchina '${machine.name}' non ha stati finali: l'esecuzione non potrebbe terminare.`, {
        node: machine,
        property: 'name',
        code: 'no-final',
      });
    }
  }

  allStatesReachable(machine: Machine, accept: ValidationAcceptor): void {
    const initial = machine.states.find((s) => s.initial);
    if (!initial) return;
    const reached = forwardClosure(machine, initial);
    for (const s of machine.states) {
      if (!reached.has(s.name)) {
        accept('warning', `Lo stato '${s.name}' non e' raggiungibile da '${initial.name}'.`, {
          node: s,
          property: 'name',
          code: 'unreachable-state',
        });
      }
    }
  }

  finalStateReachable(machine: Machine, accept: ValidationAcceptor): void {
    for (const s of machine.states) {
      if (s.final) continue;
      const reached = forwardClosure(machine, s);
      const canFinish = [...reached].some((n) => machine.states.find((x) => x.name === n)?.final);
      if (!canFinish) {
        accept('error', `Da '${s.name}' nessuno stato finale e' raggiungibile: l'esecuzione resterebbe intrappolata.`, {
          node: s,
          property: 'name',
          code: 'trapped-state',
        });
      }
    }
  }

  /**
   * Terminazione strutturale: ogni componente fortemente connessa non
   * banale deve contenere almeno uno stato con 'limit', altrimenti il
   * ciclo puo' girare per sempre.
   */
  cyclesAreBounded(machine: Machine, accept: ValidationAcceptor): void {
    for (const comp of stronglyConnectedComponents(machine)) {
      if (comp.length === 1) {
        const only = machine.states.find((s) => s.name === comp[0]);
        const selfLoop = only && successors(only).includes(only.name);
        if (!selfLoop) continue;
      }
      const states = comp
        .map((n) => machine.states.find((s) => s.name === n))
        .filter((s): s is State => !!s);
      if (states.some((s) => s.limit)) continue;
      for (const s of states) {
        accept(
          'warning',
          `Il ciclo ${comp.join(' -> ')} non ha nessun 'limit visits': l'esecuzione puo' non terminare.`,
          { node: s, property: 'name', code: 'unbounded-cycle' },
        );
      }
    }
  }

  invariantsMentionAssignableState(machine: Machine, accept: ValidationAcceptor): void {
    for (const inv of machine.invariants) {
      const refs = [...AstUtils.streamAst(inv.condition)].filter(isLocationRef);
      if (refs.length === 0) {
        accept('warning', `Invariante costante: non legge nessuna locazione.`, {
          node: inv,
          code: 'constant-invariant',
        });
      }
    }
  }

  // ------------------------------------------------------------ locazioni

  locationTypeWellFormed(loc: Location, accept: ValidationAcceptor): void {
    const t = loc.type;
    if (t.$type === 'PrimitiveType') {
      const p = t as { kind: string; lower?: number; upper?: number };
      if (p.lower !== undefined && p.upper !== undefined) {
        if (p.lower > p.upper) {
          accept('error', `Intervallo vuoto: [${p.lower}..${p.upper}].`, { node: loc, property: 'type' });
        }
        if (p.kind === 'Nat' && p.lower < 0) {
          accept('error', `Un Nat non puo' avere estremo inferiore negativo (${p.lower}).`, {
            node: loc,
            property: 'type',
          });
        }
        if (p.kind !== 'Nat' && p.kind !== 'Int') {
          accept('error', `I bound si applicano solo a Nat e Int, non a ${p.kind}.`, {
            node: loc,
            property: 'type',
          });
        }
      }
    }
    if (isEnumType(t) && t.literals.length === 0) {
      accept('error', `Enum vuoto: '${loc.name}' non potrebbe assumere nessun valore.`, {
        node: loc,
        property: 'type',
      });
    }
  }

  locationInitWellTyped(loc: Location, accept: ValidationAcceptor): void {
    if (!loc.init) return;
    const issues: TypeIssue[] = [];
    const valueType = inferType(loc.init, issues);
    reportIssues(issues, accept);

    const targetType = fromTypeRef(loc.type);
    const err = assignabilityError(targetType, valueType);
    if (err) {
      accept('error', `Inizializzatore di '${loc.name}': ${err}`, { node: loc, property: 'init' });
      return;
    }
    if (targetType.k === 'Num') {
      const c = constNumber(loc.init);
      if (c !== undefined) {
        if (targetType.lower !== undefined && c < targetType.lower) {
          accept('error', `Inizializzatore ${c} sotto l'estremo inferiore ${targetType.lower}.`, {
            node: loc,
            property: 'init',
          });
        }
        if (targetType.upper !== undefined && c > targetType.upper) {
          accept('error', `Inizializzatore ${c} sopra l'estremo superiore ${targetType.upper}.`, {
            node: loc,
            property: 'init',
          });
        }
        if (!targetType.signed && c < 0) {
          accept('error', `Un Nat non puo' essere inizializzato a ${c}.`, { node: loc, property: 'init' });
        }
      }
    }
    // riferimenti ad altre locazioni negli init: l'ordine di valutazione
    // non e' definito, quindi si accettano solo costanti.
    for (const node of AstUtils.streamAst(loc.init)) {
      if (isLocationRef(node)) {
        accept('error', `L'inizializzatore di '${loc.name}' deve essere costante: non puo' leggere altre locazioni.`, {
          node: loc,
          property: 'init',
          code: 'non-constant-init',
        });
        break;
      }
    }
  }

  /**
   * Una locazione non 'agent' che non compare come bersaglio di nessun
   * 'set' resta per sempre al suo valore iniziale: quasi certamente un
   * refuso, perche' la si e' dichiarata assegnabile per scriverla.
   */
  locationHasWriter(loc: Location, accept: ValidationAcceptor): void {
    if (loc.agentOwned) return;
    const machine = loc.$container;
    const written = machine.states.some((s) =>
      s.assignments.some((a) => a.target.location.ref === loc),
    );
    if (!written) {
      accept('warning', `'${loc.name}' e' assegnabile ma nessuno stato la scrive: resta costante.`, {
        node: loc,
        property: 'name',
        code: 'never-written',
      });
    }
  }

  // ---------------------------------------------------------------- stati

  writesAreAgentOwned(state: State, accept: ValidationAcceptor): void {
    for (let i = 0; i < state.writes.length; i++) {
      const loc = state.writes[i].ref;
      if (!loc) continue;
      if (!loc.agentOwned) {
        accept(
          'error',
          `'${loc.name}' non e' marcata 'agent': puo' essere scritta solo da 'set', non dal prompt.`,
          { node: state, property: 'writes', index: i, code: 'writes-non-agent' },
        );
      }
    }
    const seen = new Set<string>();
    for (let i = 0; i < state.writes.length; i++) {
      const n = state.writes[i].ref?.name;
      if (!n) continue;
      if (seen.has(n)) {
        accept('warning', `'${n}' ripetuta nella clausola 'writes'.`, {
          node: state,
          property: 'writes',
          index: i,
        });
      }
      seen.add(n);
    }
  }

  promptInterpolationsValid(state: State, accept: ValidationAcceptor): void {
    if (!state.prompt) return;
    for (const part of state.prompt.parts) {
      if (!isInterpolation(part)) continue;
      const loc = part.ref.location.ref;
      if (!loc) continue;
      const t = resolvePath(fromTypeRef(loc.type), part.ref.path ?? []);
      if (!t) {
        accept(
          'error',
          `'${[loc.name, ...(part.ref.path ?? [])].join('.')}' non e' un campo valido di '${loc.name}'.`,
          { node: part, code: 'bad-interpolation' },
        );
        continue;
      }
      // Interpolare una locazione che questo stesso stato sta per scrivere
      // significa mostrare all'LLM il valore vecchio: quasi sempre un errore.
      if (state.writes.some((w) => w.ref === loc)) {
        accept(
          'warning',
          `Il prompt interpola '${loc.name}', che questo stato dichiara di scrivere: verra' mostrato il valore precedente.`,
          { node: part, code: 'interpolates-own-write' },
        );
      }
    }
  }

  /**
   * Determinismo pratico: le guardie sono valutate in ordine e vince la
   * prima vera. Si segnala il codice morto — guardie duplicate e rami
   * dopo una guardia costantemente vera.
   */
  transitionsDeterministic(state: State, accept: ValidationAcceptor): void {
    const seen = new Map<string, number>();
    let alwaysTrueAt: number | undefined;

    state.transitions.forEach((t, i) => {
      const key = canonical(t.guard);
      if (seen.has(key)) {
        accept('warning', `Guardia gia' presente al ramo ${seen.get(key)! + 1}: questo ramo non sara' mai preso.`, {
          node: t,
          property: 'guard',
          code: 'shadowed-guard',
        });
      } else {
        seen.set(key, i);
      }

      if (alwaysTrueAt !== undefined) {
        accept('warning', `Irraggiungibile: il ramo ${alwaysTrueAt + 1} ha guardia sempre vera.`, {
          node: t,
          code: 'dead-branch',
        });
      } else if (isBoolLit(t.guard) && t.guard.value === true) {
        alwaysTrueAt = i;
      }
    });

    if (alwaysTrueAt !== undefined && state.fallback) {
      accept('warning', `'otherwise' irraggiungibile: il ramo ${alwaysTrueAt + 1} ha guardia sempre vera.`, {
        node: state.fallback,
        code: 'dead-otherwise',
      });
    }
  }

  noSelfDefeatingLimit(state: State, accept: ValidationAcceptor): void {
    if (!state.limit) return;
    if (state.limit.onExceeded.ref === state) {
      accept('error', `Il 'limit' di '${state.name}' rimanda a se' stesso: il fuel non servirebbe a niente.`, {
        node: state.limit,
        property: 'onExceeded',
        code: 'self-limit',
      });
    }
  }

  // ---------------------------------------------------------- assegnazioni

  assignmentTargetIsAssignable(a: Assignment, accept: ValidationAcceptor): void {
    const loc = a.target.location.ref;
    if (!loc) return;
    if (loc.agentOwned) {
      accept(
        'error',
        `'${loc.name}' e' marcata 'agent': la scrive il prompt, non 'set'. Togli 'agent' oppure usa 'writes'.`,
        { node: a, property: 'target', code: 'set-on-agent' },
      );
    }
  }

  assignmentWellTyped(a: Assignment, accept: ValidationAcceptor): void {
    const issues: TypeIssue[] = [];
    const valueType = inferType(a.value, issues);
    reportIssues(issues, accept);

    const targetType = typeOfRef(a.target);
    if (targetType.k === 'Error') return;

    const err = assignabilityError(targetType, valueType);
    if (err) {
      accept('error', `Assegnazione a '${refName(a)}': ${err}`, { node: a, property: 'value' });
      return;
    }
    if (targetType.k === 'Num') {
      const c = constNumber(a.value);
      if (c !== undefined) {
        if (targetType.lower !== undefined && c < targetType.lower) {
          accept('error', `${c} e' sotto l'estremo inferiore di '${refName(a)}' (${targetType.lower}).`, {
            node: a,
            property: 'value',
          });
        }
        if (targetType.upper !== undefined && c > targetType.upper) {
          accept('error', `${c} e' sopra l'estremo superiore di '${refName(a)}' (${targetType.upper}).`, {
            node: a,
            property: 'value',
          });
        }
      }
    }
  }

  // -------------------------------------------------- guardie e invarianti

  guardIsBool(t: Transition, accept: ValidationAcceptor): void {
    const issues: TypeIssue[] = [];
    const type = inferType(t.guard, issues);
    reportIssues(issues, accept);
    if (type.k !== 'Bool' && type.k !== 'Error') {
      accept('error', `Una guardia deve essere Bool, trovato ${stypeToString(type)}.`, {
        node: t,
        property: 'guard',
        code: 'guard-not-bool',
      });
    }
  }

  /**
   * Una guardia che legge una locazione 'agent' mai scritta prima di
   * arrivare qui sta leggendo un valore di default: vale la pena dirlo.
   */
  guardReadsWrittenState(t: Transition, accept: ValidationAcceptor): void {
    const state = t.$container;
    const machine = state.$container;
    for (const node of AstUtils.streamAst(t.guard)) {
      if (!isLocationRef(node)) continue;
      const loc = node.location.ref;
      if (!loc || !loc.agentOwned) continue;
      const everWritten = machine.states.some((s) => s.writes.some((w) => w.ref === loc));
      if (!everWritten) {
        accept(
          'warning',
          `La guardia legge '${loc.name}', locazione 'agent' che nessuno stato dichiara in 'writes': vale sempre il default.`,
          { node: t, property: 'guard', code: 'guard-reads-unwritten' },
        );
      }
    }
  }

  invariantIsBool(inv: Invariant, accept: ValidationAcceptor): void {
    const issues: TypeIssue[] = [];
    const type = inferType(inv.condition, issues);
    reportIssues(issues, accept);
    if (type.k !== 'Bool' && type.k !== 'Error') {
      accept('error', `Un'invariante deve essere Bool, trovato ${stypeToString(type)}.`, {
        node: inv,
        property: 'condition',
      });
    }
  }

  limitIsPositive(l: VisitLimit, accept: ValidationAcceptor): void {
    if (l.maxVisits < 1) {
      accept('error', `'limit visits' deve essere almeno 1, trovato ${l.maxVisits}.`, {
        node: l,
        property: 'maxVisits',
      });
    }
  }
}

// ===================================================================
// Supporto
// ===================================================================

function reportIssues(issues: TypeIssue[], accept: ValidationAcceptor): void {
  for (const i of issues) accept('error', i.message, { node: i.node });
}

function refName(a: Assignment): string {
  const loc = a.target.location.ref?.name ?? '?';
  return [loc, ...(a.target.path ?? [])].join('.');
}

export function successors(s: State): string[] {
  const out: string[] = [];
  for (const t of s.transitions) if (t.target.ref) out.push(t.target.ref.name);
  if (s.limit?.onExceeded.ref) out.push(s.limit.onExceeded.ref.name);
  if (s.fallback?.target.ref) out.push(s.fallback.target.ref.name);
  return out;
}

function forwardClosure(machine: Machine, from: State): Set<string> {
  const byName = new Map(machine.states.map((s) => [s.name, s]));
  const seen = new Set<string>([from.name]);
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const n of successors(cur)) {
      if (seen.has(n)) continue;
      seen.add(n);
      const next = byName.get(n);
      if (next) stack.push(next);
    }
  }
  return seen;
}

/** Tarjan, per trovare i cicli senza esplodere sui grafi grandi. */
function stronglyConnectedComponents(machine: Machine): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const byName = new Map(machine.states.map((s) => [s.name, s]));
  let counter = 0;

  const strongConnect = (name: string): void => {
    index.set(name, counter);
    low.set(name, counter);
    counter++;
    stack.push(name);
    onStack.add(name);

    const node = byName.get(name);
    for (const next of node ? successors(node) : []) {
      if (!byName.has(next)) continue;
      if (!index.has(next)) {
        strongConnect(next);
        low.set(name, Math.min(low.get(name)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(name, Math.min(low.get(name)!, index.get(next)!));
      }
    }

    if (low.get(name) === index.get(name)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== name);
      out.push(comp.reverse());
    }
  };

  for (const s of machine.states) if (!index.has(s.name)) strongConnect(s.name);
  return out;
}

/** Forma canonica di un'espressione, per riconoscere guardie identiche. */
function canonical(e: Expr | undefined): string {
  if (!e) return '?';
  if (isBinary(e)) {
    const l = canonical(e.left);
    const r = canonical(e.right);
    // gli operatori commutativi si normalizzano ordinando gli operandi
    if (e.op === 'and' || e.op === 'or' || e.op === '==' || e.op === '!=' || e.op === '+' || e.op === '*') {
      const [a, b] = [l, r].sort();
      return `(${a} ${e.op} ${b})`;
    }
    return `(${l} ${e.op} ${r})`;
  }
  if (isNot(e)) return `!(${canonical(e.operand)})`;
  if (isNeg(e)) return `-(${canonical(e.operand)})`;
  if (isLocationRef(e)) return [e.location.ref?.name ?? e.location.$refText, ...(e.path ?? [])].join('.');
  if (isEnumLit(e)) return `#${e.value}`;
  if (isBoolLit(e)) return String(e.value);
  if (isNumLit(e)) return String(e.value);
  if (isStringLit(e)) return JSON.stringify(e.value);
  return '?';
}
