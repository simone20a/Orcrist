/**
 * Self-test: parses and validates every bundled example, then runs the executor
 * against a scripted mock provider so the whole loop (prompt rendering,
 * report_state_writes, assignments, guards, limits, final state) is exercised
 * without touching a real LLM.
 *
 *   npm test
 */

import { checkModel, formatDiagnostics, layoutMachine } from '../src/orcrist';
import { loadLanguageAssets } from '../src/core/paths';
import { runMachine } from '../src/core/executor';
import type { LlmProvider, LlmResponse } from '../src/core/llm/types';

let failures = 0;

function ok(label: string, detail = ''): void {
  console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`);
}
function bad(label: string, detail: string): void {
  failures++;
  console.log(`  [31mFAIL[0m ${label}\n${detail}`);
}

// --- 1. the bundled examples -------------------------------------------

console.log('\nParsing + validating bundled examples');
const assets = loadLanguageAssets(__dirname);
if (!assets) {
  bad('language assets', '    could not find metamodel/orcrist.langium above the app folder');
} else {
  console.log(`  (orcrist root: ${assets.root})`);
  for (const ex of assets.examples) {
    const r = checkModel(ex.source);
    if (r.errors.length) {
      bad(ex.name, formatDiagnostics(r.errors));
    } else {
      const l = layoutMachine(r.machine!);
      ok(
        ex.name,
        `${r.machine!.states.length} states, ${r.machine!.locations.length} locations, ` +
          `${l.edges.length} edges, ${r.warnings.length} warning(s)`,
      );
      for (const w of r.warnings) console.log(`         warn line ${w.line}: ${w.message}`);
    }
  }
}

// --- 2. models that must be rejected -----------------------------------

console.log('\nRejecting invalid models');
const mustFail: [string, string][] = [
  [
    'set on an agent location',
    `machine M { locations { agent v: Bool; }
       initial state A { prompt: "x"; set v = true; otherwise -> D; }
       final state D {} }`,
  ],
  [
    'writes on an assignable location',
    `machine M { locations { v: Bool; }
       initial state A { writes v; prompt: "x"; otherwise -> D; }
       final state D {} }`,
  ],
  [
    'unlimited loop',
    `machine M { locations { agent v: Bool; }
       initial state A { writes v; prompt: "x"; on v == true -> D; otherwise -> A; }
       final state D {} }`,
  ],
  [
    'unreachable state',
    `machine M { locations { agent v: Bool; }
       initial state A { writes v; prompt: "x"; otherwise -> D; }
       state B { prompt: "y"; otherwise -> D; }
       final state D {} }`,
  ],
  [
    'no final state',
    `machine M { locations { agent v: Bool; }
       initial state A { writes v; prompt: "x"; limit visits <= 2 else -> A; otherwise -> A; } }`,
  ],
  [
    'enum literal not in the enum',
    `machine M { locations { agent v: { a, b }; }
       initial state A { writes v; prompt: "x"; on v == #c -> D; otherwise -> D; }
       final state D {} }`,
  ],
  [
    'unknown transition target',
    `machine M { locations { agent v: Bool; }
       initial state A { writes v; prompt: "x"; otherwise -> Nowhere; }
       final state D {} }`,
  ],
  [
    'two initial states',
    `machine M { locations { agent v: Bool; }
       initial state A { writes v; prompt: "x"; otherwise -> D; }
       initial state B { prompt: "y"; otherwise -> D; }
       final state D {} }`,
  ],
  [
    'clause out of order',
    `machine M { locations { agent v: Bool; }
       initial state A { prompt: "x"; writes v; otherwise -> D; }
       final state D {} }`,
  ],
  [
    'active state without otherwise',
    `machine M { locations { agent v: Bool; }
       initial state A { writes v; prompt: "x"; }
       final state D {} }`,
  ],
  [
    'observe on an agent location',
    `machine M { locations { agent v: Bool; }
       initial state A { prompt: "x"; observe v from "true"; otherwise -> D; }
       final state D {} }`,
  ],
  [
    'writes on an observed location',
    `machine M { locations { observed v: Bool = false; }
       initial state A { writes v; prompt: "x"; observe v from "true"; otherwise -> D; }
       final state D {} }`,
  ],
  [
    'observe with an empty command',
    `machine M { locations { observed v: Bool = false; }
       initial state A { prompt: "x"; observe v from "  "; otherwise -> D; }
       final state D {} }`,
  ],
  [
    'matching pattern with no capture group',
    `machine M { locations { observed n: Nat[0..9] = 9; }
       initial state A { prompt: "x"; observe n from "echo" matching "\\\\d+"; otherwise -> D; }
       final state D {} }`,
  ],
  [
    'a Text observed from an exit code',
    `machine M { locations { observed t: Text; }
       initial state A { prompt: "x"; observe t from "echo hi"; otherwise -> D; }
       final state D {} }`,
  ],
];
for (const [label, src] of mustFail) {
  const r = checkModel(src);
  if (r.errors.length === 0) bad(label, '    expected at least one error, got none');
  else ok(label, r.errors[0].message.slice(0, 78));
}

// A 'tools' clause is only checkable against a known toolset, so it is
// checked separately, with one supplied.
{
  const src = `machine M { locations { agent v: Bool; }
     initial state A { writes v; tools run_comand; prompt: "x"; on v -> D; otherwise -> D; }
     final state D {} }`;
  const withTools = checkModel(src, { tools: ['run_command', 'read_file'] });
  const without = checkModel(src);
  if (withTools.errors.length && !without.errors.length) {
    ok('tools naming a tool that does not exist', withTools.errors[0].message.slice(0, 78));
  } else {
    bad(
      'tools naming a tool that does not exist',
      `    expected an error only when the toolset is known: with ${withTools.errors.length}, without ${without.errors.length}`,
    );
  }
}

// --- 3. executing a machine against a mock provider --------------------

console.log('\nExecuting a machine end to end (mock provider)');

const MODEL = `
machine SelfTest {
    locations {
        agent failuresRaw: Nat[0..50];
        failures: Nat[0..50] = 0;
        stats: record { rounds: Nat[0..9] };
    }

    invariant bounded: failures <= 50;

    initial state Work {
        prompt: "Do the work.";
        set stats.rounds = stats.rounds + 1;
        limit visits <= 3 else -> Escalate;
        otherwise -> Check;
    }

    state Check {
        writes failuresRaw;
        prompt: "Report failures in " <failuresRaw> " after " <stats.rounds> " round(s).";
        set failures = failuresRaw;
        on failures == 0 -> Done;
        otherwise -> Work;
    }

    final state Done {}
    final state Escalate {}
}`;

const checked = checkModel(MODEL);
if (checked.errors.length) {
  bad('self-test model parses', formatDiagnostics(checked.errors));
} else {
  ok('self-test model parses');

  // reports 2 failures, then 0 — so: Work, Check, Work, Check, Done
  const reports = [2, 0];
  let calls = 0;
  const seenPrompts: string[] = [];

  const mock: LlmProvider = {
    id: 'mock',
    async complete(req) {
      calls++;
      const last = req.messages[req.messages.length - 1];
      if (last.role === 'user') seenPrompts.push(last.content);
      const reporter = req.tools.find((t) => t.name === 'report_state_writes');
      if (reporter && last.role === 'user') {
        const value = reports.shift() ?? 0;
        const res: LlmResponse = {
          text: 'Reporting what I found.',
          toolCalls: [
            { id: `c${calls}`, name: 'report_state_writes', args: { failuresRaw: value } },
          ],
        };
        return res;
      }
      return { text: 'Done with this step.', toolCalls: [] };
    },
  };

  runMachine({
    machine: checked.machine!,
    provider: mock,
    model: 'mock-1',
    systemPrompt: 'test',
    task: 'test task',
    workspace: process.cwd(),
    tools: [],
    emit: () => {},
  })
    .then((result) => {
      const path = result.trace.map((t) => t.state).join(' -> ');
      if (result.finalState !== 'Done') {
        bad('run reaches Done', `    ended in ${result.finalState}; path: ${path}`);
      } else {
        ok('run reaches Done', path);
      }
      if (result.store.failures !== 0) {
        bad('assignment ran', `    failures = ${String(result.store.failures)}`);
      } else {
        ok('assignment ran', 'failures = 0 after the second report');
      }
      const rounds = (result.store.stats as Record<string, unknown>)?.rounds;
      if (rounds !== 2) bad('record field assignment', `    stats.rounds = ${String(rounds)}`);
      else ok('record field assignment', 'stats.rounds = 2');

      const interpolated = seenPrompts.find((p) => p.includes('Report failures in'));
      if (!interpolated || !interpolated.includes('`failuresRaw`')) {
        bad('prompt interpolation', `    got: ${interpolated ?? '(none)'}`);
      } else {
        ok('prompt interpolation', interpolated.trim());
      }

      // Every state message has to carry the boundary, and name the states it
      // must not do the work of — that naming is what a weaker model acts on.
      const work = seenPrompts.find((p) => p.startsWith('## State `Work`'));
      const check = seenPrompts.find((p) => p.startsWith('## State `Check`'));
      if (!work || !check) {
        bad('state scope note present', '    no state instruction captured');
      } else if (!work.includes('only that state') || !check.includes('only that state')) {
        bad('state scope note present', '    the boundary paragraph is missing');
      } else {
        ok('state scope note present', 'both state messages carry it');
      }

      // Work -> Check (and, over the limit, the final state Escalate).
      if (work && (!work.includes('`Check`') || work.includes('`Escalate`'))) {
        bad('scope note names the states ahead', `    ${work.split('\n').pop() ?? ''}`);
      } else if (check && (!check.includes('`Work`') || check.includes('`Done`'))) {
        bad('scope note names the states ahead', `    ${check.split('\n').pop() ?? ''}`);
      } else {
        ok('scope note names the states ahead', 'successors named, final states left out');
      }

      // A state that reports values must be told to stop after reporting.
      if (check && !check.includes('do not carry on into the next phase')) {
        bad('report-then-stop', '    the reporting instruction does not say to stop');
      } else {
        ok('report-then-stop', 'reporting ends the state');
      }

      // Writing the store is a tool call, so a model finds it whether or not
      // anything explains it. Reading the store is not — so every state
      // message has to carry the values, or a smaller model has nowhere to
      // look and invents one.
      if (!check || !check.includes('The store right now')) {
        bad('the store travels with the instruction', '    no store block in the state message');
      } else if (!check.includes('`stats`') || !check.includes('`failures`')) {
        bad('the store travels with the instruction', '    the block does not list every location');
      } else if (!check.includes('yours to report in this state')) {
        bad('the store travels with the instruction', "    the state's own targets are not marked");
      } else {
        const line = check.split('\n').find((l) => l.includes('`failures`')) ?? '';
        ok('the store travels with the instruction', line.trim());
      }

      // A value nothing has written must say so rather than arriving as an
      // empty string a model would read as an answer.
      if (!work || !work.includes('(not set yet)')) {
        bad('unset locations say they are unset', '    no "(not set yet)" in the first state message');
      } else {
        ok('unset locations say they are unset');
      }

      return openaiParamDropCheck()
        .then(openaiResponsesFallbackCheck)
        .then(cancellationCheck)
        .then(observationCheck)
        .then(toolListCheck)
        .then(networkErrorCheck);
    })
    .then(finish)
    .catch((e: unknown) => {
      bad('run completes', `    ${(e as Error).message}`);
      finish();
    });
}

// --- 4. the OpenAI adapter's unsupported-parameter retry ----------------

/**
 * Reasoning models reject any `temperature` but the default, and the authoring
 * call sets 0.2. The adapter is supposed to drop the parameter the API names
 * and retry rather than failing the run.
 */
async function openaiParamDropCheck(): Promise<void> {
  console.log('\nOpenAI adapter: dropping a rejected parameter');
  const { createServer } = await import('node:http');
  const { openaiProvider } = await import('../src/core/llm/openai');

  const seen: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body) as Record<string, unknown>;
      seen.push(j);
      if ('temperature' in j) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: "Unsupported value: 'temperature' does not support 0.2 with this model.",
              type: 'invalid_request_error',
              param: 'temperature',
              code: 'unsupported_value',
            },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      );
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  try {
    const provider = openaiProvider({ apiKey: 'k', baseUrl: `http://127.0.0.1:${port}` });
    const res = await provider.complete({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      model: 'reasoning-mock',
      temperature: 0.2,
    });
    if (res.text !== 'ok') bad('retry succeeds', `    got ${JSON.stringify(res.text)}`);
    else ok('retry succeeds', `${seen.length} request(s): temperature dropped on the second`);
    if (seen.length !== 2 || !('temperature' in seen[0]) || 'temperature' in seen[1]) {
      bad('exactly one retry, without temperature', `    ${JSON.stringify(seen.map((s) => Object.keys(s)))}`);
    } else {
      ok('exactly one retry, without temperature');
    }
  } catch (e) {
    bad('retry succeeds', `    ${(e as Error).message}`);
  } finally {
    server.close();
  }
}

function finish(): void {
  console.log('');
  if (failures) {
    console.log(`[31m${failures} check(s) failed[0m\n`);
    process.exit(1);
  }
  console.log('[32mAll checks passed[0m\n');
}

// --- 5. the OpenAI adapter's /v1/responses fallback ---------------------

/**
 * gpt-5.x refuses function tools on /v1/chat/completions and points at
 * /v1/responses. The adapter should switch endpoints, translate the message
 * history into Responses input items, read function_call items back out, and
 * stay on the new endpoint for subsequent calls.
 */
async function openaiResponsesFallbackCheck(): Promise<void> {
  console.log('\nOpenAI adapter: falling back to /v1/responses for tool use');
  const { createServer } = await import('node:http');
  const { openaiProvider } = await import('../src/core/llm/openai');

  const hits: string[] = [];
  let lastResponsesBody: any;

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push(req.url ?? '');
      const j = JSON.parse(body || '{}');
      if ((req.url ?? '').endsWith('/chat/completions')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message:
                'Function tools with reasoning_effort are not supported for mock-5 in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to \'none\'.',
              type: 'invalid_request_error',
              param: 'reasoning_effort',
              code: null,
            },
          }),
        );
        return;
      }
      lastResponsesBody = j;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'completed',
          output: [
            { type: 'reasoning', id: 'rs_1', summary: [] },
            { type: 'message', content: [{ type: 'output_text', text: 'Listing the workspace.' }] },
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_abc',
              name: 'list_directory',
              arguments: '{"path":"."}',
            },
          ],
          usage: { input_tokens: 5, output_tokens: 6 },
        }),
      );
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  try {
    const provider = openaiProvider({ apiKey: 'k', baseUrl: `http://127.0.0.1:${port}` });
    const tools = [
      { name: 'list_directory', description: 'list', inputSchema: { type: 'object', properties: {} } },
    ];

    const first = await provider.complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'have a look' }],
      tools,
      model: 'mock-5',
    });

    if (first.toolCalls.length !== 1 || first.toolCalls[0].name !== 'list_directory') {
      bad('tool call parsed from Responses output', `    ${JSON.stringify(first.toolCalls)}`);
    } else if (first.toolCalls[0].id !== 'call_abc') {
      bad('call_id is used as the tool-call id', `    got ${first.toolCalls[0].id}`);
    } else if (first.text !== 'Listing the workspace.') {
      bad('assistant text parsed', `    got ${JSON.stringify(first.text)}`);
    } else {
      ok('switched endpoint and parsed the tool call', hits.join(' then '));
    }

    // a follow-up carrying an assistant tool call and its result
    await provider.complete({
      system: 'sys',
      messages: [
        { role: 'user', content: 'have a look' },
        { role: 'assistant', content: 'Listing.', toolCalls: first.toolCalls },
        { role: 'tool', toolCallId: 'call_abc', name: 'list_directory', content: 'a.txt' },
      ],
      tools,
      model: 'mock-5',
    });

    const kinds = (lastResponsesBody.input as any[]).map((i) => i.type ?? i.role);
    const expected = ['user', 'assistant', 'function_call', 'function_call_output'];
    if (JSON.stringify(kinds) !== JSON.stringify(expected)) {
      bad('history translated to Responses items', `    ${JSON.stringify(kinds)}`);
    } else {
      ok('history translated to Responses items', kinds.join(', '));
    }
    if (lastResponsesBody.store !== false) {
      bad('store: false', '    the adapter should not leave history in the response store');
    } else {
      ok('store: false');
    }
    if (hits.filter((h) => h.endsWith('/chat/completions')).length !== 1) {
      bad('endpoint choice is sticky', `    ${hits.join(', ')}`);
    } else {
      ok('endpoint choice is sticky', 'chat/completions tried once, not again');
    }
  } catch (e) {
    bad('responses fallback', `    ${(e as Error).message}`);
  } finally {
    server.close();
  }
}

// --- 6. cancelling a run that is waiting on the model -------------------

/**
 * Stop has to reach the request in flight. Without the signal reaching the
 * provider, a cancel only lands at the executor's next checkpoint — which is
 * after the reply the model is composing, and against a real model that is the
 * difference between "immediately" and "a minute from now".
 */
async function cancellationCheck(): Promise<void> {
  console.log('\nCancelling a run mid-request');

  const checked = checkModel(MODEL);
  const controller = new AbortController();
  let sawSignal = false;

  // A model that never answers on its own: the only way out is the signal.
  const hanging: LlmProvider = {
    id: 'hanging',
    complete(req) {
      sawSignal = Boolean(req.signal);
      return new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => {
          const e = new Error('The operation was aborted.');
          e.name = 'AbortError';
          reject(e);
        });
      });
    },
  };

  const started = Date.now();
  setTimeout(() => controller.abort(), 50);

  const result = await runMachine({
    machine: checked.machine!,
    provider: hanging,
    model: 'mock-1',
    systemPrompt: 'test',
    task: 'test task',
    workspace: process.cwd(),
    tools: [],
    emit: () => {},
    signal: controller.signal,
  });
  const elapsed = Date.now() - started;

  if (!sawSignal) bad('the signal reaches the provider', '    complete() got no signal');
  else ok('the signal reaches the provider');

  if (result.stopped !== 'aborted') {
    bad('cancelling ends the run', `    stopped = ${String(result.stopped)}`);
  } else if (elapsed > 2000) {
    bad('cancelling ends the run', `    took ${elapsed}ms`);
  } else {
    ok('cancelling ends the run', `${elapsed}ms, with the model still thinking`);
  }
}

// --- 7. a measurement outranking a claim -------------------------------

/**
 * The point of `observed` locations: a model that says the work is finished
 * cannot make it so. Here the mock always reports success, the runtime
 * measures the world instead, and the guard follows the measurement — first
 * back to the repair state, then out.
 *
 * The same run checks that `tools` is a restriction and not a request: the
 * checking state is handed nothing at all.
 */
async function observationCheck(): Promise<void> {
  console.log('\nMeasuring the world instead of believing the model');

  const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const dir = await mkdtemp(join(tmpdir(), 'orcrist-obs-'));
  // The world starts broken. The 'Fix' state is the only thing that mends it,
  // and it does so by running a command the mock never mentions.
  await writeFile(join(dir, 'failures'), '3\n');

  const src = `machine Measured {
      locations {
          agent claimed: Bool;
          observed failures: Nat[0..99] = 99;
      }

      initial state Check {
          writes claimed;
          tools none;
          prompt: "Say whether the suite passes; report it in " <claimed> ".";
          observe failures from "cat failures" matching "(\\\\d+)" else 99;
          on failures == 0 -> Done;
          otherwise -> Fix;
      }

      state Fix {
          prompt: "Repair it.";
          observe failures from "printf 0 > failures; echo 0" matching "(\\\\d+)" else 99;
          limit visits <= 3 else -> Abandoned;
          otherwise -> Check;
      }

      final state Done {}
      final state Abandoned {}
  }`;

  const checked = checkModel(src, { tools: ['run_command', 'read_file'] });
  if (checked.errors.length) {
    bad('measured model parses', formatDiagnostics(checked.errors));
    await rm(dir, { recursive: true, force: true });
    return;
  }

  const offered: string[][] = [];
  const optimist: LlmProvider = {
    id: 'optimist',
    async complete(req) {
      offered.push(req.tools.map((t) => t.name));
      const reporter = req.tools.find((t) => t.name === 'report_state_writes');
      const last = req.messages[req.messages.length - 1];
      if (reporter && last.role === 'user') {
        return {
          text: 'All green.',
          toolCalls: [{ id: 'c1', name: 'report_state_writes', args: { claimed: true } }],
        };
      }
      return { text: 'Everything passes.', toolCalls: [] };
    },
  };

  const result = await runMachine({
    machine: checked.machine!,
    provider: optimist,
    model: 'mock-1',
    systemPrompt: 'test',
    task: 'test task',
    workspace: dir,
    tools: [],
    emit: () => {},
  });
  await rm(dir, { recursive: true, force: true });

  const path = result.trace.map((t) => t.state).join(' -> ');

  if (result.store.claimed !== true) {
    bad('the claim is recorded', `    claimed = ${String(result.store.claimed)}`);
  } else {
    ok('the claim is recorded', 'the model said it passed');
  }

  if (path !== 'Check -> Fix -> Check') {
    bad('the measurement decides the branch', `    path: ${path}`);
  } else {
    ok('the measurement decides the branch', `the claim said Done; the run went ${path}`);
  }

  if (result.finalState !== 'Done' || result.store.failures !== 0) {
    bad('the run ends on a measured zero', `    ${result.finalState}, failures = ${String(result.store.failures)}`);
  } else {
    ok('the run ends on a measured zero', 'failures = 0, measured');
  }

  // 'tools none' still leaves the reporting tool, which is not a tool the
  // model can act on the world with — it is how the state answers.
  const first = offered[0] ?? [];
  if (first.some((n) => n !== 'report_state_writes')) {
    bad("'tools none' hands over nothing", `    offered: ${first.join(', ')}`);
  } else {
    ok("'tools none' hands over nothing", `offered: ${first.join(', ') || '(none)'}`);
  }
}

// --- 8. the tools, named in prose --------------------------------------

/**
 * A tool's schema reaches the model through the API, but a list it can read is
 * what a smaller model plans against — and the list is the only place that can
 * say what there is NO tool for, which is the half a schema cannot express.
 */
async function toolListCheck(): Promise<void> {
  console.log('\nThe execution prompt names the tools, and what has no tool');

  const { executionSystemPrompt } = await import('../src/core/prompts');
  const { buildTools } = await import('../src/core/tools');
  const { DEFAULT_SETTINGS } = await import('../src/core/types');

  const tools = buildTools(DEFAULT_SETTINGS);
  const checked = checkModel(MODEL);
  const sys = executionSystemPrompt({
    workspace: '/tmp/ws',
    machine: checked.machine!,
    task: 't',
    tools: tools.map((t) => ({ name: t.def.name, description: t.def.description })),
  });

  const missing = tools.map((t) => t.def.name).filter((n) => !sys.includes(`\`${n}\``));
  if (missing.length) bad('every tool is listed', `    missing: ${missing.join(', ')}`);
  else ok('every tool is listed', `${tools.length} tools`);

  if (!sys.includes('`report_state_writes`')) {
    bad('the store-writing tool is listed', '    report_state_writes is not named');
  } else {
    ok('the store-writing tool is listed');
  }

  if (!/nothing for reading the machine's store/.test(sys)) {
    bad('what has no tool is stated', '    the prompt never says the store cannot be fetched');
  } else {
    ok('what has no tool is stated', 'no state-moving tool, no store-reading tool');
  }

  // Without a machine there is no store to explain, and no per-state tool.
  const bare = executionSystemPrompt({
    workspace: '/tmp/ws',
    task: 't',
    tools: tools.map((t) => ({ name: t.def.name, description: t.def.description })),
  });
  if (bare.includes('report_state_writes')) {
    bad('a run with no machine says nothing about the store', '    report_state_writes leaked in');
  } else {
    ok('a run with no machine says nothing about the store');
  }
}

// --- 9. what a failed request says -------------------------------------

/**
 * "fetch failed" is what Node says when a request never left the machine, and
 * on its own it cannot tell an unplugged Ollama from a typo in a base URL. The
 * cause has to reach the transcript, and cancelling has to stay distinguishable
 * from a fault.
 */
async function networkErrorCheck(): Promise<void> {
  console.log('\nA request that cannot be made says why');

  const { anthropicProvider } = await import('../src/core/llm/anthropic');
  const { openaiProvider } = await import('../src/core/llm/openai');
  const { ollamaProvider } = await import('../src/core/llm/ollama');

  const req = { model: 'm', system: 's', messages: [{ role: 'user' as const, content: 'hi' }], tools: [] };
  const closed = 'http://127.0.0.1:59997';

  const cases: [string, () => Promise<unknown>][] = [
    ['Anthropic', () => anthropicProvider({ apiKey: 'k', baseUrl: closed }).complete(req)],
    ['OpenAI', () => openaiProvider({ apiKey: 'k', baseUrl: `${closed}/v1` }).complete(req)],
    ['Ollama', () => ollamaProvider({ baseUrl: closed }).complete(req)],
  ];

  for (const [name, run] of cases) {
    try {
      await run();
      bad(`${name}: unreachable host reported`, '    the call did not fail at all');
    } catch (e) {
      const msg = (e as Error).message;
      if (/^fetch failed$/i.test(msg)) {
        bad(`${name}: unreachable host reported`, '    still the bare "fetch failed"');
      } else if (!msg.includes(name) || !msg.includes('127.0.0.1')) {
        bad(`${name}: unreachable host reported`, `    does not name the provider and the address: ${msg}`);
      } else if (!msg.includes('ECONNREFUSED')) {
        bad(`${name}: unreachable host reported`, `    does not carry the cause: ${msg}`);
      } else {
        ok(`${name}: unreachable host reported`, msg.slice(0, 72));
      }
    }
  }

  // The same failure through a tool, which is the other place it surfaces —
  // and there the reader is the model, deciding whether to try another way.
  const { buildTools } = await import('../src/core/tools');
  const { DEFAULT_SETTINGS } = await import('../src/core/types');
  const settings = { ...DEFAULT_SETTINGS, enableWeb: true };
  const webFetch = buildTools(settings).find((t) => t.def.name === 'web_fetch');
  if (!webFetch) {
    bad('web_fetch: unreachable host reported', '    the tool is not in the toolset');
  } else {
    try {
      await webFetch.run(
        { url: `${closed}/page` },
        { workspace: '/tmp', settings } as unknown as Parameters<typeof webFetch.run>[1],
      );
      bad('web_fetch: unreachable host reported', '    the call did not fail at all');
    } catch (e) {
      const msg = (e as Error).message;
      if (/fetch failed/i.test(msg)) {
        bad('web_fetch: unreachable host reported', '    still the bare "fetch failed"');
      } else if (!msg.includes('ECONNREFUSED') || !msg.includes('127.0.0.1')) {
        bad('web_fetch: unreachable host reported', `    ${msg}`);
      } else {
        ok('web_fetch: unreachable host reported', msg.slice(0, 72));
      }
    }
  }

  // Stop must not be rewritten into a network fault: the run ends cancelled,
  // and that distinction is what keeps the log honest.
  const c = new AbortController();
  c.abort();
  try {
    await ollamaProvider({ baseUrl: closed }).complete({ ...req, signal: c.signal });
    bad('cancelling stays an abort', '    the aborted call did not throw');
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') ok('cancelling stays an abort', 'AbortError, not a transport error');
    else bad('cancelling stays an abort', `    got ${err.name}: ${err.message}`);
  }
}
