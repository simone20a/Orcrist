/**
 * The FSM executor: walks an Orcrist machine one state at a time, asking the
 * LLM the state's prompt, letting it use tools, collecting the state's `writes`
 * through a per-state `report_state_writes` tool, applying the state's `set`
 * assignments, then evaluating guards to pick the next state — until a final
 * state is reached.
 *
 * Why `report_state_writes` rather than parsing values out of the reply: the
 * store is the thing guards are evaluated over, so it has to be filled
 * reliably. Native tool-calling with a schema derived from each location's
 * declared type gives typed, validated values; free-text parsing does not.
 */

import { exec } from 'node:child_process';
import type { Machine, Observation, State, TypeRef } from '../orcrist/ast';
import { exprToString, findLocation, findState, initialState, refToString } from '../orcrist/ast';
import {
  coerce,
  evalExpr,
  formatValue,
  guardHolds,
  initStore,
  renderPrompt,
  writeRef,
  writesSchema,
  type Store,
} from '../orcrist/evaluator';
import type { LlmMessage, LlmProvider, LlmToolDef, ToolCall } from './llm/types';
import type { AgentTool, ToolContext } from './tools';
import { ToolError } from './tools';
import { DEFAULT_SETTINGS, type RunEvent, type Settings } from './types';

export interface RunMachineOptions {
  machine: Machine;
  provider: LlmProvider;
  model: string;
  systemPrompt: string;
  task: string;
  workspace: string;
  tools: AgentTool[];
  settings?: Settings;
  emit: (e: RunEvent) => void;
  signal?: AbortSignal;
}

export interface RunMachineResult {
  finalState: string;
  store: Store;
  trace: { state: string; visit: number }[];
  stopped?: 'transition-cap' | 'aborted';
}

const REPORT_TOOL = 'report_state_writes';

const now = () => Date.now();

class Aborted extends Error {}

/**
 * Cancelling now tears down the HTTP request the provider is waiting on, so a
 * stop arrives as `fetch`'s own AbortError rather than as our checkpoint. Both
 * mean the same thing here.
 */
function isAbort(e: unknown): boolean {
  return e instanceof Aborted || (e as Error | undefined)?.name === 'AbortError';
}

export async function runMachine(opts: RunMachineOptions): Promise<RunMachineResult> {
  const settings = opts.settings ?? DEFAULT_SETTINGS;
  const { machine, emit } = opts;
  const ctx: ToolContext = { workspace: opts.workspace, settings };

  const store = initStore(machine);
  const visits = new Map<string, number>();
  const trace: { state: string; visit: number }[] = [];
  const messages: LlmMessage[] = [];

  const start = initialState(machine);
  if (!start) throw new Error('The machine has no initial state.');

  let current: State = start;
  let transitions = 0;
  let stopped: RunMachineResult['stopped'];

  const check = () => {
    if (opts.signal?.aborted) throw new Aborted();
  };

  const goto = (
    to: string,
    via: 'guard' | 'otherwise' | 'limit',
    label: string,
  ): State | undefined => {
    emit({ t: now(), kind: 'transition', from: current.name, to, via, label });
    transitions++;
    return findState(machine, to);
  };

  try {
    // The task itself frames the whole run; each state then adds its prompt.
    messages.push({
      role: 'user',
      content:
        `The task you are working on:\n\n${opts.task}\n\n` +
        `This run is structured as the Orcrist state machine \`${machine.name}\`. ` +
        `You will be given one state's instructions at a time. Do only what the current state asks.`,
    });

    for (;;) {
      check();

      if (current.final) {
        emit({ t: now(), kind: 'final', state: current.name });
        return { finalState: current.name, store, trace, stopped };
      }

      if (transitions >= settings.maxStateTransitions) {
        emit({
          t: now(),
          kind: 'error',
          text: `Stopped after ${transitions} state transitions (safety cap). The machine had not reached a final state.`,
        });
        return { finalState: current.name, store, trace, stopped: 'transition-cap' };
      }

      const visit = (visits.get(current.name) ?? 0) + 1;
      visits.set(current.name, visit);

      // 'limit visits <= N else -> S' — fuel, checked on entry
      if (current.limit && visit > current.limit.maxVisits) {
        const next = goto(
          current.limit.onExceeded,
          'limit',
          `visit ${visit} exceeds limit ${current.limit.maxVisits}`,
        );
        if (!next) throw new Error(`Unknown state '${current.limit.onExceeded}'.`);
        current = next;
        continue;
      }

      trace.push({ state: current.name, visit });
      const prompt = current.prompt
        ? renderPrompt(machine, current.prompt, current, store)
        : '(this state has no prompt)';
      emit({ t: now(), kind: 'state-enter', state: current.name, visit, prompt });

      const reported = await executeState(current, prompt, {
        ...opts,
        settings,
        ctx,
        messages,
        store,
      });

      // 1. agent-owned writes
      if (Object.keys(reported).length) {
        emit({ t: now(), kind: 'writes', state: current.name, values: reported });
        for (const [name, raw] of Object.entries(reported)) {
          const loc = findLocation(machine, name);
          if (!loc) continue;
          const c = coerce(loc.type, raw);
          if (c.ok) {
            store[name] = c.value;
          } else {
            emit({
              t: now(),
              kind: 'error',
              text: `Reported value for '${name}' rejected: ${c.error}. The location keeps its previous value.`,
            });
          }
        }
      }

      // 2. observations — the runtime measuring the world for itself
      for (const o of current.observations) {
        check();
        const loc = findLocation(machine, o.target);
        const result = await observe(o, loc?.type, opts.workspace, settings);
        const measured = result.noMatch ? evalExpr(machine, o.fallback!, store) : result.value;
        if (result.error) {
          // A measurement that could not be taken must not leave the previous
          // round's number standing: a guard would then read a stale fact as
          // if it were current. The declared 'else' is exactly the value the
          // author chose for "this could not be established", so it applies
          // here too.
          let detail = result.error;
          if (o.fallback !== undefined && loc) {
            const f = coerce(loc.type, evalExpr(machine, o.fallback, store));
            if (f.ok) {
              store[o.target] = f.value;
              detail = `${result.error}; fell back to ${formatValue(f.value)}`;
            }
          }
          emit({
            t: now(),
            kind: 'observe',
            state: current.name,
            target: o.target,
            command: o.command,
            ok: false,
            detail,
          });
          continue;
        }
        const c = loc ? coerce(loc.type, measured) : { ok: false as const, error: 'unknown location' };
        if (c.ok) {
          store[o.target] = c.value;
          emit({
            t: now(),
            kind: 'observe',
            state: current.name,
            target: o.target,
            command: o.command,
            ok: true,
            detail: result.noMatch ? `${formatValue(c.value)} (no match; the 'else' value)` : formatValue(c.value),
          });
        } else {
          emit({
            t: now(),
            kind: 'observe',
            state: current.name,
            target: o.target,
            command: o.command,
            ok: false,
            detail: `measured ${JSON.stringify(measured)} but ${c.error}`,
          });
        }
      }

      // 3. assignments, in order
      for (const a of current.assignments) {
        const value = evalExpr(machine, a.value, store);
        writeRef(machine, a.target, value, store);
        emit({
          t: now(),
          kind: 'assignment',
          state: current.name,
          target: refToString(a.target),
          expr: exprToString(a.value),
          value: formatValue(value),
        });
      }

      // 4. invariants
      for (const inv of machine.invariants) {
        const holds = evalExpr(machine, inv.condition, store) === true;
        if (!holds) {
          emit({
            t: now(),
            kind: 'invariant',
            name: inv.name ?? exprToString(inv.condition),
            holds: false,
          });
        }
      }

      emit({ t: now(), kind: 'store', store: JSON.parse(JSON.stringify(store)) as Store });

      // 5. transition
      let next: State | undefined;
      let taken = false;
      for (const t of current.transitions) {
        if (guardHolds(machine, t.guard, store)) {
          next = goto(t.target, 'guard', exprToString(t.guard));
          taken = true;
          break;
        }
      }
      if (!taken) {
        if (!current.fallback) throw new Error(`State '${current.name}' has no 'otherwise'.`);
        next = goto(current.fallback.target, 'otherwise', 'otherwise');
      }
      if (!next) throw new Error(`Transition from '${current.name}' targets an unknown state.`);
      current = next;
    }
  } catch (e) {
    if (isAbort(e)) {
      emit({ t: now(), kind: 'error', text: 'Run cancelled.' });
      return { finalState: current.name, store, trace, stopped: 'aborted' };
    }
    throw e;
  }
}

interface StateExecOptions extends RunMachineOptions {
  settings: Settings;
  ctx: ToolContext;
  messages: LlmMessage[];
  store: Store;
}

/** One state: prompt the model, service its tool calls, collect its writes. */
async function executeState(
  state: State,
  prompt: string,
  o: StateExecOptions,
): Promise<Record<string, unknown>> {
  const { machine, emit, messages } = o;

  // A state may narrow the tools it is given. This is the boundary made
  // mechanical rather than instructed: a model can ignore "do not run the
  // tests", but it cannot call a tool it was never handed.
  const allowed = state.tools
    ? o.tools.filter((t) => state.tools!.includes(t.def.name))
    : o.tools;
  if (state.tools) {
    const unknown = state.tools.filter((n) => !o.tools.some((t) => t.def.name === n));
    if (unknown.length) {
      emit({
        t: now(),
        kind: 'error',
        text: `State '${state.name}' asks for ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not an available tool' : 'are not available tools'}. It runs without ${unknown.length === 1 ? 'it' : 'them'}.`,
      });
    }
  }
  const toolDefs: LlmToolDef[] = allowed.map((t) => t.def);
  const wantsWrites = state.writes.length > 0;
  if (wantsWrites) {
    toolDefs.push({
      name: REPORT_TOOL,
      description:
        `Record the values this state is responsible for producing: ${state.writes.join(', ')}. ` +
        'Call this exactly once, as the LAST thing you do in this state, after any other tool use. ' +
        'The values you pass here go into the machine store and decide which state runs next, so report what you actually observed, not what you hoped for.',
      inputSchema: writesSchema(machine, state) as unknown as Record<string, unknown>,
    });
  }

  const instruction =
    `## State \`${state.name}\`\n\n${prompt}\n\n` +
    `${scopeNote(machine, state)}\n\n` +
    (wantsWrites
      ? `When you are done, call \`${REPORT_TOOL}\` once with: ${state.writes.join(', ')}. Then stop — do not carry on into the next phase.`
      : 'This state records no values: carry out the instruction above, say what you did, and stop.') +
    storeNote(machine, state, o.store);

  messages.push({ role: 'user', content: instruction });

  let reported: Record<string, unknown> = {};
  let sawReport = false;

  for (let round = 0; round < o.settings.maxToolRoundsPerState; round++) {
    if (o.signal?.aborted) throw new Aborted();

    const res = await o.provider.complete({
      system: o.systemPrompt,
      messages,
      tools: toolDefs,
      model: o.model,
      signal: o.signal,
    });

    if (res.text.trim()) {
      emit({ t: now(), kind: 'assistant', state: state.name, text: res.text.trim() });
    }

    if (!res.toolCalls.length) {
      messages.push({ role: 'assistant', content: res.text || '(no output)' });
      if (wantsWrites && !sawReport) {
        // nudge once, then give up on this state's writes
        if (round < o.settings.maxToolRoundsPerState - 1) {
          messages.push({
            role: 'user',
            content: `You have not called \`${REPORT_TOOL}\` yet. Call it now with ${state.writes.join(', ')}.`,
          });
          continue;
        }
      }
      break;
    }

    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });

    for (const call of res.toolCalls) {
      emit({
        t: now(),
        kind: 'tool-call',
        state: state.name,
        id: call.id,
        name: call.name,
        args: call.args,
      });
      const { content, isError } = await dispatch(call, { ...o, tools: allowed }, state);
      emit({
        t: now(),
        kind: 'tool-result',
        state: state.name,
        id: call.id,
        name: call.name,
        result: content,
        isError,
      });
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content,
        isError,
      });
      if (call.name === REPORT_TOOL && !isError) {
        reported = call.args;
        sawReport = true;
      }
    }

    if (sawReport) break;
  }

  if (wantsWrites && !sawReport) {
    emit({
      t: now(),
      kind: 'error',
      text: `State '${state.name}' finished without reporting ${state.writes.join(', ')}; those locations keep their previous values.`,
    });
  }

  return reported;
}

/**
 * Runs one observation: the runtime measures the world instead of asking the
 * model what it saw.
 *
 * This is the point of the construct. A guard over a reported value is a guard
 * over a claim, and a model that is weak, hurried or simply optimistic makes
 * that claim wrong — after which the machine takes a wrong branch with complete
 * confidence. A guard over an observed value is a guard over what a command
 * actually printed, and no amount of optimism changes it.
 *
 * With no pattern the measurement is the exit code, which suits a Bool
 * ("did it succeed") or a Nat. With a pattern it is capture group 1 of the
 * first match.
 */
async function observe(
  o: Observation,
  type: TypeRef | undefined,
  workspace: string,
  settings: Settings,
): Promise<{ value?: unknown; error?: string; noMatch?: true }> {
  const blocked = settings.blockedCommands
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
    .find((b) => o.command.includes(b));
  if (blocked) return { error: `refused: the command matches the blocked pattern '${blocked}'` };

  const run = await new Promise<{ code: number; out: string }>((resolve) => {
    exec(
      o.command,
      { cwd: workspace, timeout: 600_000, maxBuffer: 8 * 1024 * 1024, shell: '/bin/bash' },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: number }).code === 'number'
            ? (error as { code?: number }).code!
            : error
              ? 1
              : 0;
        resolve({ code, out: `${stdout}\n${stderr}` });
      },
    );
  });

  if (o.pattern === undefined) {
    // A shell reports success as 0, and a Bool reports it as true. Without this
    // the two conventions are exactly inverted, which is the kind of bug that
    // looks like the machine working until the day something fails.
    const isBool = type?.$type === 'PrimitiveType' && type.kind === 'Bool';
    return { value: isBool ? run.code === 0 : run.code };
  }

  let re: RegExp;
  try {
    re = new RegExp(o.pattern, 'm');
  } catch {
    return { error: `the pattern is not a valid regular expression` };
  }
  const m = re.exec(run.out);
  if (m && m[1] !== undefined) return { value: m[1] };
  // No match is not automatically a failure — "0 failed" often prints nothing
  // at all — but which it is has to be the model author's decision, declared
  // in an 'else', not a guess the runtime makes.
  if (o.fallback !== undefined) return { noMatch: true };
  return {
    error: `the command ran (exit ${run.code}) but the pattern matched nothing, and no 'else' value was given`,
  };
}

/**
 * The state boundary, restated in the message the model is actually reading.
 *
 * The system prompt argues the rule at length, but it sits at the top of a turn
 * that a few tool calls push a long way up the context, and a weaker model
 * reading a bare instruction defaults to finishing the job it can see. This
 * paragraph arrives directly under the instruction, every time, and it names
 * the neighbouring states: a model that will not generalise "stay inside your
 * state" will still act on "do not run the tests, `Test` is a separate state".
 *
 * Guards are deliberately not shown. Naming where the machine can go is what
 * makes the boundary concrete; naming what sends it there would invite the
 * model to report the value that gets it to the state it wanted.
 */
function scopeNote(machine: Machine, state: State): string {
  const targets = [
    ...state.transitions.map((t) => t.target),
    ...(state.fallback ? [state.fallback.target] : []),
    ...(state.limit ? [state.limit.onExceeded] : []),
  ];

  const ahead = [...new Set(targets)]
    .filter((n) => n !== state.name)
    .map((n) => findState(machine, n))
    .filter((s): s is State => s !== undefined && !s.final);

  const note = [
    `**Scope.** You are in state \`${state.name}\`, and only that state. Do what the instruction above asks, then stop: say what you did and what you found, and leave it there. You cannot move yourself to another state — the runtime reads the store, evaluates the guards and sends you the next instruction itself.`,
  ];

  if (ahead.length) {
    const names = ahead.map((s) => `\`${s.name}\``).join(', ');
    note.push(
      ahead.length === 1
        ? `After this state the machine may go to ${names}. That state's work is not yours to do here — not even the part of it you could finish in one command. It gets its own turn, with its own instruction.`
        : `After this state the machine may go to any of: ${names}. Their work is not yours to do here — not even the parts of it you could finish in one command. Each gets its own turn, with its own instruction.`,
    );
  }

  return note.join('\n\n');
}

/**
 * The store, printed at the foot of every state message.
 *
 * Writing to the store is a tool call, which a model discovers from the tool
 * list whether or not anything explains it. Reading it is not: the values
 * reach the model only where the machine's author thought to interpolate one,
 * and a smaller model that wants a value nobody interpolated has nowhere to
 * go — there is no read tool to find, so it guesses, or it asks the user, or
 * it invents. So the store comes with the instruction, every time, at the
 * bottom where it does not interrupt the reading of the work order.
 *
 * Values are clipped: a Text location can hold a whole specification, and the
 * point here is to show what is set and what is not.
 */
function storeNote(machine: Machine, state: State, store: Store): string {
  if (!machine.locations.length) return '';

  // The label says who last put a value there, not who may put one there now
  // — and the state's own targets are marked separately, because "reported by
  // the agent" on a location this state cannot write would read as an
  // invitation to write it.
  const own = (o: string) =>
    o === 'agent' ? 'reported in an earlier state' : o === 'observed' ? 'measured by the runtime' : 'derived by the runtime';

  const rows = machine.locations.map((l) => {
    const v = store[l.name];
    const mine = state.writes.includes(l.name);
    const value = v === undefined ? '(not set yet)' : clipValue(formatValue(v as never));
    return `- \`${l.name}\` = ${value}${mine ? ' ← yours to report in this state' : ` (${own(l.ownership)})`}`;
  });

  return `\n\n**The store right now.** These are the values the guards will be evaluated over after your turn. Read them here; there is no tool for fetching them.\n\n${rows.join('\n')}`;
}

function clipValue(s: string): string {
  const one = s.replace(/\s+/g, ' ');
  return one.length > 180 ? `${one.slice(0, 179)}… (clipped)` : one;
}

async function dispatch(
  call: ToolCall,
  o: StateExecOptions,
  state: State,
): Promise<{ content: string; isError?: boolean }> {
  if (call.name === REPORT_TOOL) {
    const missing = state.writes.filter((w) => call.args[w] === undefined);
    if (missing.length) {
      return { content: `Missing values for: ${missing.join(', ')}. Call again with all of them.`, isError: true };
    }
    const problems: string[] = [];
    for (const w of state.writes) {
      const loc = findLocation(o.machine, w);
      if (!loc) continue;
      const c = coerce(loc.type, call.args[w]);
      if (!c.ok) problems.push(`${w}: ${c.error}`);
    }
    if (problems.length) {
      return { content: `Rejected — ${problems.join('; ')}. Call again with valid values.`, isError: true };
    }
    return { content: 'Recorded. This state is complete.' };
  }

  const tool = o.tools.find((t) => t.def.name === call.name);
  if (!tool) {
    return { content: `No such tool '${call.name}'.`, isError: true };
  }
  try {
    return { content: await tool.run(call.args, o.ctx) };
  } catch (e) {
    const msg = e instanceof ToolError ? e.message : `${(e as Error).message}`;
    return { content: `Error: ${msg}`, isError: true };
  }
}

// --- freeform (no machine) ---------------------------------------------

export interface RunFreeformOptions {
  provider: LlmProvider;
  model: string;
  systemPrompt: string;
  task: string;
  workspace: string;
  tools: AgentTool[];
  settings: Settings;
  emit: (e: RunEvent) => void;
  signal?: AbortSignal;
}

/**
 * Used when the authoring step decides the task does not warrant a machine
 * (a question, a one-line fix). Same tools, same log, no state graph.
 */
export async function runFreeform(o: RunFreeformOptions): Promise<void> {
  const ctx: ToolContext = { workspace: o.workspace, settings: o.settings };
  const messages: LlmMessage[] = [{ role: 'user', content: o.task }];
  const toolDefs = o.tools.map((t) => t.def);

  for (let round = 0; round < o.settings.maxToolRoundsPerState * 3; round++) {
    if (o.signal?.aborted) {
      o.emit({ t: now(), kind: 'error', text: 'Run cancelled.' });
      return;
    }
    const res = await o.provider.complete({
      system: o.systemPrompt,
      messages,
      tools: toolDefs,
      model: o.model,
      signal: o.signal,
    });
    if (res.text.trim()) o.emit({ t: now(), kind: 'assistant', text: res.text.trim() });
    if (!res.toolCalls.length) {
      messages.push({ role: 'assistant', content: res.text });
      return;
    }
    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      o.emit({ t: now(), kind: 'tool-call', id: call.id, name: call.name, args: call.args });
      const tool = o.tools.find((t) => t.def.name === call.name);
      let content: string;
      let isError = false;
      if (!tool) {
        content = `No such tool '${call.name}'.`;
        isError = true;
      } else {
        try {
          content = await tool.run(call.args, ctx);
        } catch (e) {
          content = `Error: ${(e as Error).message}`;
          isError = true;
        }
      }
      o.emit({ t: now(), kind: 'tool-result', id: call.id, name: call.name, result: content, isError });
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content, isError });
    }
  }
  o.emit({ t: now(), kind: 'error', text: 'Stopped after the maximum number of tool rounds.' });
}
