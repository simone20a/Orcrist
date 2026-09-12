/**
 * Orcrist validator — the constraints the grammar deliberately leaves out,
 * listed in the trailing comment of orcrist.langium and elaborated in
 * authoring-guide.md sections 2, 3, 5, 6, 7 and 9:
 *
 *   ownership     — 'writes' only on agent locations, 'set' only on assignable ones
 *   typing        — guards, assignments and initialisers type-check; bounds respected
 *   totality      — every active state has prompt + otherwise (parser), refs resolve
 *   determinism   — outgoing guards from one state should not overlap (heuristic)
 *   reachability  — every state reachable from initial, every state can reach a final
 *   termination   — every state on a cycle carries a 'limit'
 */

import type { Expr, Machine, State } from './ast';
import {
  exprToString,
  findLocation,
  findState,
  refToString,
  successors,
  typeToString,
} from './ast';
import type { Diagnostic } from './parser';
import { assignable, describe, fromTypeRef, inferExpr, resolveRefType } from './typing';

export interface ValidationResult {
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

export interface ValidateOptions {
  /**
   * The tool names available to the executing agent in this configuration.
   * When given, a `tools` clause naming anything else is an authoring-time
   * error rather than a state that quietly runs with fewer tools than its
   * prompt assumes. Omit it to skip the check (a machine can be checked
   * outside a running app, where the toolset is not known).
   */
  tools?: string[];
}

export function validate(machine: Machine, options: ValidateOptions = {}): ValidationResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const err = (message: string, line: number) =>
    errors.push({ severity: 'error', message, line });
  const warn = (message: string, line: number) =>
    warnings.push({ severity: 'warning', message, line });

  // --- names ----------------------------------------------------------
  const seenLoc = new Set<string>();
  for (const l of machine.locations) {
    if (l.ownership === 'observed' && !machine.states.some((s) => s.observations.some((o) => o.target === l.name))) {
      warn(
        `location '${l.name}' is declared 'observed' but no state observes it, so it can only ever hold its initial value (guide §2)`,
        l.line,
      );
    }
    if (seenLoc.has(l.name)) err(`duplicate location '${l.name}'`, l.line);
    seenLoc.add(l.name);
    if (l.type.$type === 'PrimitiveType') {
      const { kind, lower, upper } = l.type;
      if (lower !== undefined && upper !== undefined) {
        if (lower > upper) err(`location '${l.name}': bound [${lower}..${upper}] is empty`, l.line);
        if (kind === 'Nat' && lower < 0) {
          err(`location '${l.name}': a Nat cannot have a negative lower bound`, l.line);
        }
        if (kind !== 'Nat' && kind !== 'Int') {
          err(`location '${l.name}': only Nat and Int can carry a [lower..upper] bound`, l.line);
        }
      } else if (kind === 'Nat' || kind === 'Int') {
        warn(
          `location '${l.name}' is an unbounded ${kind}; bounding it keeps the model finite (guide §3)`,
          l.line,
        );
      }
    }
    if (l.type.$type === 'EnumType') {
      const seenLit = new Set<string>();
      for (const lit of l.type.literals) {
        if (seenLit.has(lit)) err(`location '${l.name}': duplicate enum literal '${lit}'`, l.line);
        seenLit.add(lit);
      }
    }
    if (l.type.$type === 'RecordType') {
      const seenField = new Set<string>();
      for (const f of l.type.fields) {
        if (seenField.has(f.name)) err(`location '${l.name}': duplicate field '${f.name}'`, l.line);
        seenField.add(f.name);
      }
    }
  }

  const seenState = new Set<string>();
  for (const s of machine.states) {
    if (seenState.has(s.name)) err(`duplicate state '${s.name}'`, s.line);
    seenState.add(s.name);
  }

  const initials = machine.states.filter((s) => s.initial);
  if (initials.length === 0) {
    err(`machine '${machine.name}' has no 'initial' state`, 1);
  } else if (initials.length > 1) {
    err(
      `machine '${machine.name}' has ${initials.length} initial states (${initials
        .map((s) => s.name)
        .join(', ')}); exactly one is allowed`,
      initials[1].line,
    );
  }
  if (!machine.states.some((s) => s.final)) {
    err(`machine '${machine.name}' has no final state, so no run can ever end`, 1);
  }

  // --- initialisers ---------------------------------------------------
  for (const l of machine.locations) {
    if (!l.init) continue;
    const t = inferExpr(machine, l.init, (m, line) => err(m, line), l.line);
    const target = fromTypeRef(l.type);
    if (!assignable(target, t)) {
      err(
        `location '${l.name}' is ${typeToString(l.type)} but its initial value is ${describe(t)}`,
        l.line,
      );
    }
    if (l.agentOwned) {
      warn(
        `location '${l.name}' is agent-owned and also initialised; the initial value is only a placeholder until the LLM writes it`,
        l.line,
      );
    }
    checkNumericBounds(machine, l.name, l.init, l.line, err);
  }

  // --- invariants -----------------------------------------------------
  for (const inv of machine.invariants) {
    const t = inferExpr(machine, inv.condition, (m, line) => err(m, line), inv.line);
    if (t.k !== 'bool' && t.k !== 'unknown') {
      err(`invariant ${inv.name ? `'${inv.name}' ` : ''}is not a Bool expression`, inv.line);
    }
    for (const name of referencedLocations(inv.condition)) {
      const loc = findLocation(machine, name);
      if (loc?.agentOwned) {
        warn(
          `invariant ${inv.name ? `'${inv.name}' ` : ''}reads agent-owned '${name}', so it states what the LLM claims, not a fact about the world (guide §7)`,
          inv.line,
        );
      }
    }
  }

  // --- states ---------------------------------------------------------
  for (const s of machine.states) {
    if (s.final) continue;

    // writes: must name declared, agent-owned locations
    const seenWrite = new Set<string>();
    for (const w of s.writes) {
      const loc = findLocation(machine, w);
      if (!loc) {
        err(`state '${s.name}': 'writes' names unknown location '${w}'`, s.line);
        continue;
      }
      if (loc.ownership !== 'agent') {
        err(
          `state '${s.name}': 'writes ${w}' — only 'agent' locations can be written by a prompt; '${w}' is ${loc.ownership === 'observed' ? "observed and must be written with 'observe'" : "assignable and must be written with 'set'"} (guide §2)`,
          s.line,
        );
      }
      if (seenWrite.has(w)) err(`state '${s.name}': '${w}' listed twice in 'writes'`, s.line);
      seenWrite.add(w);
    }

    // tools: a state may narrow what its turn is handed, but only to tools
    // that exist. A typo here is silent at runtime — the state simply gets
    // less than its prompt assumes — so it is caught while authoring.
    if (s.tools) {
      const seenTool = new Set<string>();
      for (const t of s.tools) {
        if (seenTool.has(t)) warn(`state '${s.name}': '${t}' listed twice in 'tools'`, s.line);
        seenTool.add(t);
        if (options.tools && !options.tools.includes(t)) {
          err(
            `state '${s.name}': 'tools ${t}' names no available tool. The tools are: ${options.tools.join(', ')} (guide §2.1)`,
            s.line,
          );
        }
      }
      if (s.tools.length === 0 && s.writes.length === 0 && s.observations.length === 0) {
        warn(
          `state '${s.name}': 'tools none' and nothing written or observed, so this state's turn can change nothing and tell the machine nothing`,
          s.line,
        );
      }
    }

    // prompt interpolations
    if (s.prompt) {
      for (const part of s.prompt.parts) {
        if (part.$type !== 'Interpolation') continue;
        const r = resolveRefType(machine, part.ref);
        if (r.error) err(`state '${s.name}': prompt interpolation ${r.error}`, s.line);
      }
      const hasText = s.prompt.parts.some(
        (p) => p.$type === 'PromptText' && p.value.trim().length > 0,
      );
      if (!hasText) err(`state '${s.name}': prompt has no text`, s.line);
    }

    // observations — the runtime measuring the world rather than the LLM
    // reporting on it
    for (const o of s.observations) {
      const loc = findLocation(machine, o.target);
      if (!loc) {
        err(`state '${s.name}': 'observe' targets unknown location '${o.target}'`, o.line);
        continue;
      }
      if (loc.ownership !== 'observed') {
        err(
          `state '${s.name}': cannot 'observe ${o.target}' — it is ${loc.ownership}-owned; declare it 'observed' if the runtime is to measure it (guide §2)`,
          o.line,
        );
      }
      if (!o.command.trim()) {
        err(`state '${s.name}': 'observe ${o.target}' has an empty command`, o.line);
      }
      if (o.pattern !== undefined) {
        try {
          const re = new RegExp(o.pattern);
          if (!/\((?!\?)/.test(re.source)) {
            err(
              `state '${s.name}': the pattern for '${o.target}' has no capture group — the value is group 1 of the first match`,
              o.line,
            );
          }
        } catch {
          err(`state '${s.name}': the pattern for '${o.target}' is not a valid regular expression`, o.line);
        }
      } else if (loc.type.$type === 'PrimitiveType' && loc.type.kind === 'Text') {
        err(
          `state '${s.name}': 'observe ${o.target}' has no 'matching' pattern, so it would take the command's exit code — which cannot be a Text`,
          o.line,
        );
      }
    }

    // assignments
    for (const a of s.assignments) {
      const loc = findLocation(machine, a.target.location);
      if (!loc) {
        err(`state '${s.name}': 'set' targets unknown location '${a.target.location}'`, a.line);
        continue;
      }
      if (loc.ownership !== 'assignable') {
        err(
          `state '${s.name}': cannot 'set ${refToString(a.target)}' — it is ${loc.ownership}-owned, so only ${loc.ownership === 'agent' ? 'the prompt' : "an 'observe' clause"} may write it (guide §2)`,
          a.line,
        );
      }
      const r = resolveRefType(machine, a.target);
      if (r.error) {
        err(`state '${s.name}': ${r.error}`, a.line);
        continue;
      }
      const vt = inferExpr(machine, a.value, (m, line) => err(`state '${s.name}': ${m}`, line), a.line);
      if (!assignable(fromTypeRef(r.type!), vt)) {
        err(
          `state '${s.name}': cannot assign ${describe(vt)} to '${refToString(a.target)}' of type ${typeToString(r.type!)}`,
          a.line,
        );
      }
    }

    // limit
    if (s.limit) {
      if (s.limit.maxVisits < 1) {
        err(`state '${s.name}': 'limit visits <= ${s.limit.maxVisits}' must allow at least one visit`, s.limit.line);
      }
      const target = findState(machine, s.limit.onExceeded);
      if (!target) {
        err(`state '${s.name}': 'limit ... else -> ${s.limit.onExceeded}' names an unknown state`, s.limit.line);
      } else if (target.name === s.name) {
        err(`state '${s.name}': 'limit ... else' points back at the same state, so the budget never releases`, s.limit.line);
      }
    }

    // transitions
    const guardTexts = new Map<string, number>();
    for (const t of s.transitions) {
      const gt = inferExpr(machine, t.guard, (m, line) => err(`state '${s.name}': ${m}`, line), t.line);
      if (gt.k !== 'bool' && gt.k !== 'unknown') {
        err(`state '${s.name}': guard '${exprToString(t.guard)}' is ${describe(gt)}, not a Bool`, t.line);
      }
      if (!findState(machine, t.target)) {
        err(`state '${s.name}': transition targets unknown state '${t.target}'`, t.line);
      }
      const key = exprToString(t.guard);
      if (guardTexts.has(key)) {
        err(
          `state '${s.name}': two outgoing transitions share the guard '${key}', so the machine is non-deterministic here (guide §5)`,
          t.line,
        );
      }
      guardTexts.set(key, t.line);
      if (key === 'true' && s.transitions.indexOf(t) < s.transitions.length - 1) {
        warn(
          `state '${s.name}': guard 'true' fires unconditionally, so the transitions after it are dead`,
          t.line,
        );
      }
      for (const name of referencedLocations(t.guard)) {
        const loc = findLocation(machine, name);
        if (loc?.agentOwned) {
          warn(
            `state '${s.name}': guard '${key}' reads agent-owned '${name}' — it tests what the LLM claimed, not a checked fact (guide §5)`,
            t.line,
          );
        }
      }
    }

    if (s.fallback && !findState(machine, s.fallback.target)) {
      err(`state '${s.name}': 'otherwise' targets unknown state '${s.fallback.target}'`, s.fallback.line);
    }

    // A prompt may freely READ a location it does not write. What it must not
    // do is interpolate a location nothing in the machine can ever fill.
    for (const name of promptInterpolations(s)) {
      const loc = findLocation(machine, name);
      if (!loc || loc.init !== undefined) continue;
      const everWritten =
        machine.states.some((x) => x.writes.includes(name)) ||
        machine.states.some((x) => x.observations.some((o) => o.target === name)) ||
        machine.states.some((x) => x.assignments.some((a) => a.target.location === name));
      if (!everWritten) {
        warn(
          `state '${s.name}': the prompt interpolates '${name}', but no state writes it and it has no initial value, so it can only ever render as unset (guide §4)`,
          s.line,
        );
      }
    }
  }

  // --- graph properties ------------------------------------------------
  if (errors.length === 0 && initials.length === 1) {
    graphChecks(machine, initials[0], err, warn);
  }

  return { errors, warnings };
}

function graphChecks(
  machine: Machine,
  start: State,
  err: (m: string, line: number) => void,
  warn: (m: string, line: number) => void,
): void {
  // reachability from initial
  const reached = new Set<string>();
  const stack = [start.name];
  while (stack.length) {
    const n = stack.pop()!;
    if (reached.has(n)) continue;
    reached.add(n);
    const s = findState(machine, n);
    if (s) for (const t of successors(s)) stack.push(t);
  }
  for (const s of machine.states) {
    if (!reached.has(s.name)) {
      err(`state '${s.name}' is unreachable from '${start.name}' (guide §6)`, s.line);
    }
  }

  // can every state reach a final state?
  const canFinish = new Set<string>(machine.states.filter((s) => s.final).map((s) => s.name));
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of machine.states) {
      if (canFinish.has(s.name)) continue;
      if (successors(s).some((t) => canFinish.has(t))) {
        canFinish.add(s.name);
        changed = true;
      }
    }
  }
  for (const s of machine.states) {
    if (!canFinish.has(s.name)) {
      err(`no path from state '${s.name}' reaches a final state (guide §6)`, s.line);
    }
  }

  // Termination (guide §5): every loop must be bounded. The unit is the loop,
  // not the state — `examples/ciclo-sviluppo.orc` bounds its Implement/Test
  // cycle with a single `limit` on Implement, and that is enough, because the
  // budget on any one state on the cycle caps how many times the cycle runs.
  for (const scc of stronglyConnectedComponents(machine)) {
    if (!scc.some((name) => findState(machine, name)?.limit)) {
      const line = findState(machine, scc[0])?.line ?? 1;
      err(
        scc.length === 1
          ? `state '${scc[0]}' loops back to itself with no 'limit visits <= N else -> …', so termination is left to the LLM (guide §5)`
          : `the loop ${scc.join(' -> ')} -> ${scc[0]} has no 'limit visits <= N else -> …' on any of its states, so termination is left to the LLM (guide §5)`,
        line,
      );
    }
  }

  // a limit escape that leads straight back into the same loop
  for (const s of machine.states) {
    if (!s.limit) continue;
    const escape = findState(machine, s.limit.onExceeded);
    if (escape && !escape.final && reachesState(machine, escape.name, s.name)) {
      warn(
        `state '${s.name}': the 'limit' escape '${escape.name}' can lead back to '${s.name}'; choose an escalation that leaves the loop (guide §5)`,
        s.limit.line,
      );
    }
  }
}

function reachesState(machine: Machine, from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === target && n !== from) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    const s = findState(machine, n);
    if (!s) continue;
    for (const t of successors(s)) {
      if (t === target) return true;
      stack.push(t);
    }
  }
  return false;
}

/**
 * Tarjan's algorithm, restricted to components that actually loop: a component
 * of more than one state, or a single state with an edge to itself. Each of
 * these is a loop the model can go round, and each one needs a bound.
 */
function stronglyConnectedComponents(machine: Machine): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;

  const strongConnect = (name: string): void => {
    index.set(name, counter);
    low.set(name, counter);
    counter++;
    stack.push(name);
    onStack.add(name);

    const s = findState(machine, name);
    for (const next of s ? successors(s) : []) {
      if (!findState(machine, next)) continue;
      if (!index.has(next)) {
        strongConnect(next);
        low.set(name, Math.min(low.get(name)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(name, Math.min(low.get(name)!, index.get(next)!));
      }
    }

    if (low.get(name) === index.get(name)) {
      const component: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
        if (w === name) break;
      }
      const selfLoop =
        component.length === 1 &&
        (findState(machine, component[0])?.transitions.some((t) => t.target === component[0]) ||
          findState(machine, component[0])?.fallback?.target === component[0] ||
          findState(machine, component[0])?.limit?.onExceeded === component[0]);
      if (component.length > 1 || selfLoop) out.push(component.reverse());
    }
  };

  for (const s of machine.states) {
    if (!index.has(s.name)) strongConnect(s.name);
  }
  return out;
}

function checkNumericBounds(
  machine: Machine,
  locName: string,
  e: Expr,
  line: number,
  err: (m: string, line: number) => void,
): void {
  const loc = findLocation(machine, locName);
  if (!loc || loc.type.$type !== 'PrimitiveType') return;
  const { lower, upper } = loc.type;
  if (lower === undefined || upper === undefined) return;
  if (e.$type === 'NumLit' && (e.value < lower || e.value > upper)) {
    err(`location '${locName}': initial value ${e.value} is outside [${lower}..${upper}]`, line);
  }
  if (e.$type === 'Neg' && e.operand.$type === 'NumLit') {
    const v = -e.operand.value;
    if (v < lower || v > upper) {
      err(`location '${locName}': initial value ${v} is outside [${lower}..${upper}]`, line);
    }
  }
}

export function referencedLocations(e: Expr): string[] {
  const out: string[] = [];
  const walk = (x: Expr): void => {
    switch (x.$type) {
      case 'Binary':
        walk(x.left);
        walk(x.right);
        break;
      case 'Not':
      case 'Neg':
        walk(x.operand);
        break;
      case 'LocationRef':
        out.push(x.location);
        break;
      default:
        break;
    }
  };
  walk(e);
  return out;
}

function promptInterpolations(s: State): string[] {
  if (!s.prompt) return [];
  return s.prompt.parts
    .filter((p): p is { $type: 'Interpolation'; ref: any } => p.$type === 'Interpolation')
    .map((p) => p.ref.location);
}

/** Parse + validate in one step, the way the authoring loop uses it. */
export function formatDiagnostics(ds: Diagnostic[]): string {
  return ds.map((d) => `  [${d.severity}] line ${d.line}: ${d.message}`).join('\n');
}
