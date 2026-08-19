// =====================================================================
// Prova a secco del runtime, senza Electron e senza rete.
//
// Un provider finto risponde al posto dell'LLM: usa un tool di file e
// poi chiama 'report' con valori decisi da uno scenario. Serve a
// verificare che la macchina cammini davvero — guardie, fuel,
// invarianti, sandbox — prima di spendere una sola chiamata vera.
// =====================================================================

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileModel } from '../src/language/compile.js';
import { Engine } from '../src/main/runtime/engine.js';
import { Sandbox, SandboxViolation } from '../src/main/runtime/sandbox.js';
import type { ChatRequest, ChatResponse, LlmProvider } from '../src/main/llm/types.js';
import { TavilyClient } from '../src/main/web/tavily.js';
import { layoutMachine, NODE_H, NODE_W } from '../src/renderer/graph/layout.js';
import { DEFAULT_RUNTIME, emptySnapshot } from '../src/shared/protocol.js';
import { applyEvent } from '../src/shared/reduce.js';
import type { RunEvent } from '../src/shared/protocol.js';

let failures = 0;
function check(label: string, condition: boolean | (() => boolean), detail = ''): void {
  const ok = typeof condition === 'function' ? condition() : condition;
  console.log(`${ok ? '\x1b[32m  ok\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// --- provider finto ---------------------------------------------------

/** Restituisce i valori di 'report' in base allo stato in corso. */
type Script = (state: string, visit: number) => Record<string, unknown>;

function fakeProvider(script: Script, opts: { useTools?: boolean } = {}): LlmProvider {
  const visits = new Map<string, number>();
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const state = /stato '([^']+)'/.exec(req.system)?.[1] ?? '?';
      const alreadyCalledTool = req.messages.some((m) => m.role === 'tool');
      const reportSpec = req.tools.find((t) => t.name === 'report');

      if (opts.useTools && !alreadyCalledTool && req.tools.some((t) => t.name === 'list_dir')) {
        return {
          text: `Guardo cosa c'e' nel workspace (stato ${state}).`,
          toolCalls: [{ id: `c${Math.random().toString(36).slice(2)}`, name: 'list_dir', input: { path: '.' } }],
          stopReason: 'tool_use',
        };
      }

      if (!reportSpec) return { text: `Fatto in ${state}.`, toolCalls: [], stopReason: 'end_turn' };

      const visit = (visits.get(state) ?? 0) + 1;
      visits.set(state, visit);
      return {
        text: `Chiudo lo stato ${state}.`,
        toolCalls: [
          { id: `r${Math.random().toString(36).slice(2)}`, name: 'report', input: script(state, visit) },
        ],
        stopReason: 'tool_use',
      };
    },
  };
}

/**
 * Provider finto che chiama un tool preciso e poi chiude lo stato:
 * serve a esercitare i tool web senza toccare la rete.
 */
function toolCallingProvider(tool: string, input: Record<string, unknown>, script: Script): LlmProvider {
  const done = new Set<string>();
  return {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const state = /stato '([^']+)'/.exec(req.system)?.[1] ?? '?';
      if (!done.has(state) && req.tools.some((t) => t.name === tool)) {
        done.add(state);
        return { text: '', toolCalls: [{ id: 'c1', name: tool, input }], stopReason: 'tool_use' };
      }
      const reportSpec = req.tools.find((t) => t.name === 'report');
      if (!reportSpec) return { text: 'fatto', toolCalls: [], stopReason: 'end_turn' };
      return { text: '', toolCalls: [{ id: 'r1', name: 'report', input: script(state, 1) }], stopReason: 'tool_use' };
    },
  };
}

async function runMachine(
  source: string,
  script: Script,
  overrides: Partial<typeof DEFAULT_RUNTIME> = {},
  useTools = false,
): Promise<{ events: RunEvent[]; workspace: string }> {
  const compiled = await compileModel(source);
  if (!compiled.machine) throw new Error(`Il modello non compila: ${compiled.diagnostics[0]?.message}`);

  const workspace = mkdtempSync(path.join(tmpdir(), 'orcrist-'));
  writeFileSync(path.join(workspace, 'README.md'), '# progetto di prova\n');
  mkdirSync(path.join(workspace, 'src'));
  writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export const x = 1;\n');

  const events: RunEvent[] = [];
  const engine = new Engine({
    machine: compiled.machine,
    sandbox: new Sandbox(workspace),
    config: { ...DEFAULT_RUNTIME, maxSteps: 60, ...overrides },
    credentials: { baseUrl: '' },
    provider: fakeProvider(script, { useTools }),
    emit: (e) => events.push(e),
  });
  await engine.run('test');
  return { events, workspace };
}

const path_ = (events: RunEvent[]): string[] =>
  events.filter((e): e is Extract<RunEvent, { type: 'state-entered' }> => e.type === 'state-entered').map((e) => e.state);

const finish = (events: RunEvent[]) =>
  events.find((e): e is Extract<RunEvent, { type: 'run-finished' }> => e.type === 'run-finished');

// =====================================================================

console.log('\n\x1b[1m1. Percorso felice: le guardie decidono il cammino\x1b[0m');
{
  const src = `
machine Felice {
    locations {
        agent esito: { ok, ko };
        agent nota: Text;
        tentativi: Nat[0..5] = 0;
    }
    invariant limitato: tentativi <= 5;

    initial state Lavora {
        writes esito, nota;
        prompt: "Fai il lavoro.";
        set tentativi = tentativi + 1;
        limit visits <= 3 else -> Resa;
        on esito == #ok -> Fatto;
        otherwise       -> Lavora;
    }
    state Resa { prompt: "Mi arrendo."; otherwise -> Fatto; }
    final state Fatto {}
}`;
  const { events } = await runMachine(src, (_s, visit) => ({
    esito: visit >= 2 ? 'ok' : 'ko',
    nota: `giro ${visit}`,
  }));
  const trail = path_(events);
  check('percorre Lavora -> Lavora -> Fatto', JSON.stringify(trail) === JSON.stringify(['Lavora', 'Lavora', 'Fatto']), trail.join(' -> '));
  check('termina nello stato finale', finish(events)?.reason === 'final');
  const store = events.filter((e) => e.type === 'store-changed').pop();
  check('il contatore assegnabile e\' arrivato a 2', store?.type === 'store-changed' && store.store.tentativi === 2);
  check('nessuna invariante violata', !events.some((e) => e.type === 'invariant-violated'));
}

console.log('\n\x1b[1m2. Il fuel scatta e devia senza interrogare il modello\x1b[0m');
{
  const src = `
machine Fuel {
    locations { agent esito: { ok, ko }; }
    initial state Prova {
        writes esito;
        prompt: "Prova.";
        limit visits <= 2 else -> Resa;
        on esito == #ok -> Fatto;
        otherwise       -> Prova;
    }
    state Resa { prompt: "Basta."; otherwise -> Fatto; }
    final state Fatto {}
}`;
  const { events } = await runMachine(src, () => ({ esito: 'ko' }));
  const trail = path_(events);
  check('devia dopo due visite', JSON.stringify(trail) === JSON.stringify(['Prova', 'Prova', 'Prova', 'Resa', 'Fatto']), trail.join(' -> '));
  const limitHop = events.find((e) => e.type === 'transition' && e.reason === 'limit');
  check('la transizione e\' marcata come limit', !!limitHop);
  const prompts = events.filter((e) => e.type === 'prompt-built' && e.state === 'Prova');
  check("alla terza visita non si interroga l'LLM", prompts.length === 2, `${prompts.length} prompt`);
}

console.log('\n\x1b[1m3. Interpolazione, bound e invarianti\x1b[0m');
{
  const src = `
machine Bound {
    locations {
        agent quanti: Nat[0..3];
        agent eco: Text;
        totale: Nat[0..3] = 0;
        chiuso: Bool = false;
    }
    invariant coerenza: not chiuso or totale > 0;

    initial state Conta {
        writes quanti;
        prompt: "Quanti ne vedi?";
        set totale = totale + 3;
        otherwise -> Ripeti;
    }
    state Ripeti {
        writes eco;
        prompt: "Il totale e' " <totale> " e ne hai contati " <quanti> ".";
        set chiuso = true;
        otherwise -> Fine;
    }
    final state Fine {}
}`;
  const { events } = await runMachine(src, (s) => (s === 'Conta' ? { quanti: 99 } : { eco: 'ok' }));
  const store = events.filter((e) => e.type === 'store-changed').pop();
  check('il valore fuori bound viene riportato nel dominio', store?.type === 'store-changed' && store.store.quanti === 3);
  check('lo scavalcamento viene segnalato', events.some((e) => e.type === 'bounds-clamped'));
  const prompt = events.find((e) => e.type === 'prompt-built' && e.state === 'Ripeti');
  check(
    "l'interpolazione usa i valori correnti",
    prompt?.type === 'prompt-built' && prompt.prompt === "Il totale e' 3 e ne hai contati 3.",
    prompt?.type === 'prompt-built' ? prompt.prompt : '',
  );
  check('nessuna invariante violata', !events.some((e) => e.type === 'invariant-violated'));
}

console.log('\n\x1b[1m4. Invariante violata: si segnala, la corsa prosegue\x1b[0m');
{
  const src = `
machine Rotta {
    locations {
        agent inviato: Bool;
        escalato: Bool = false;
    }
    invariant esclusivi: not (inviato and escalato);

    initial state Invia {
        writes inviato;
        prompt: "Invia.";
        set escalato = true;
        otherwise -> Fine;
    }
    final state Fine {}
}`;
  const { events } = await runMachine(src, () => ({ inviato: true }));
  const violation = events.find((e) => e.type === 'invariant-violated');
  check("l'invariante viene rilevata", violation?.type === 'invariant-violated' && violation.name === 'esclusivi');
  check('la corsa arriva comunque in fondo', finish(events)?.reason === 'final');
}

console.log('\n\x1b[1m5. I tool girano dentro il workspace\x1b[0m');
{
  const src = `
machine ConTool {
    locations { agent visto: Text; }
    initial state Guarda {
        writes visto;
        prompt: "Guarda il workspace.";
        otherwise -> Fine;
    }
    final state Fine {}
}`;
  const { events, workspace } = await runMachine(src, () => ({ visto: 'fatto' }), {}, true);
  const call = events.find((e) => e.type === 'tool-call' && e.tool === 'list_dir');
  const result = events.find((e) => e.type === 'tool-result' && e.tool === 'list_dir');
  check('il tool viene invocato', !!call);
  check('il tool riesce', result?.type === 'tool-result' && result.ok);
  check(
    'il risultato elenca i file veri',
    result?.type === 'tool-result' && result.summary.includes('src/'),
    result?.type === 'tool-result' ? result.summary : '',
  );
  rmSync(workspace, { recursive: true, force: true });
}

console.log('\n\x1b[1m6. La sandbox non si lascia scavalcare\x1b[0m');
{
  const root = mkdtempSync(path.join(tmpdir(), 'orcrist-jail-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'orcrist-out-'));
  writeFileSync(path.join(outside, 'segreto.txt'), 'non si deve leggere');
  mkdirSync(path.join(root, 'dentro'));
  writeFileSync(path.join(root, 'dentro', 'ok.txt'), 'va bene');
  symlinkSync(outside, path.join(root, 'fuga'));

  const s = new Sandbox(root);

  const attempts: Array<[string, string]> = [
    ['percorso relativo che risale', '../segreto.txt'],
    ['risalita annidata', 'dentro/../../segreto.txt'],
    ['percorso assoluto esterno', path.join(outside, 'segreto.txt')],
    ['symlink verso l\'esterno', 'fuga/segreto.txt'],
    ['scrittura oltre il link', 'fuga/nuovo.txt'],
    ['radice del sistema', '/etc/hosts'],
  ];

  for (const [label, target] of attempts) {
    let blocked = false;
    try {
      await s.resolve(target);
    } catch (err) {
      blocked = err instanceof SandboxViolation;
    }
    check(`respinge: ${label}`, blocked, target);
  }

  const inside = await s.readFile('dentro/ok.txt').then(
    (t) => t.trim() === 'va bene',
    () => false,
  );
  check('legge i file legittimi', inside);

  const created = await s.writeFile('nuovo/annidato.txt', 'ciao').then(
    (r) => r.created,
    () => false,
  );
  check('crea file nuovi dentro il workspace', created);

  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

console.log('\n\x1b[1m7. Salvagente sui passi\x1b[0m');
{
  const src = `
machine Infinita {
    locations { agent x: Text; }
    initial state Gira {
        writes x;
        prompt: "Gira.";
        limit visits <= 100 else -> Mai;
        otherwise -> Gira;
    }
    final state Mai {}
}`;
  const { events } = await runMachine(src, () => ({ x: 'ancora' }), { maxSteps: 7 });
  const end = finish(events);
  check('si ferma al tetto di passi', end?.reason === 'max-steps', end?.error ?? '');
  check('non ha superato il tetto', path_(events).length === 7, String(path_(events).length));
}

// =====================================================================
// Tool web — Tavily con un fetch finto, nessuna rete toccata
// =====================================================================

const WEB_MACHINE = `
machine ConWeb {
    locations { agent trovato: Text; }
    initial state Cerca {
        writes trovato;
        prompt: "Cerca qualcosa sul web.";
        otherwise -> Fine;
    }
    final state Fine {}
}`;

/** Registra le richieste e risponde con un corpo fissato. */
function fakeTavily(body: unknown, status = 200): { client: TavilyClient; calls: Array<{ url: string; body: any }> } {
  const calls: Array<{ url: string; body: any }> = [];
  const client = new TavilyClient('tvly-finta', 'https://api.tavily.com', async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { client, calls };
}

async function runWithWeb(
  provider: LlmProvider,
  web: TavilyClient,
): Promise<RunEvent[]> {
  const compiled = await compileModel(WEB_MACHINE);
  const workspace = mkdtempSync(path.join(tmpdir(), 'orcrist-web-'));
  const events: RunEvent[] = [];
  const engine = new Engine({
    machine: compiled.machine!,
    sandbox: new Sandbox(workspace),
    config: { ...DEFAULT_RUNTIME, maxSteps: 10 },
    credentials: { baseUrl: '' },
    provider,
    web,
    emit: (e) => events.push(e),
  });
  await engine.run('web');
  rmSync(workspace, { recursive: true, force: true });
  return events;
}

console.log('\n\x1b[1m8. Ricerca web\x1b[0m');
{
  const { client, calls } = fakeTavily({
    query: 'langium',
    answer: 'Langium e\' un framework per DSL su Node.',
    results: [
      { title: 'Langium', url: 'https://langium.org', content: 'Framework   per\n linguaggi.', score: 0.9 },
      { title: 'GitHub', url: 'https://github.com/eclipse-langium/langium', content: 'Sorgenti.', score: 0.8 },
    ],
  });

  const events = await runWithWeb(
    toolCallingProvider('web_search', { query: 'langium', max_results: 2, topic: 'general' }, () => ({
      trovato: 'ok',
    })),
    client,
  );

  const call = events.find((e) => e.type === 'tool-call' && e.tool === 'web_search');
  const result = events.find((e) => e.type === 'tool-result' && e.tool === 'web_search');
  check('il tool web_search viene invocato', !!call);
  check('la chiamata riesce', result?.type === 'tool-result' && result.ok);
  check('colpisce /search', calls[0]?.url.endsWith('/search'), calls[0]?.url ?? '');
  check('inoltra i parametri del modello', calls[0]?.body.query === 'langium' && calls[0]?.body.max_results === 2);
  check('chiede la sintesi', calls[0]?.body.include_answer === true);
  check(
    'il riassunto mostra il primo risultato',
    result?.type === 'tool-result' && result.summary.startsWith('Sintesi:'),
    result?.type === 'tool-result' ? result.summary.slice(0, 60) : '',
  );
  check('la corsa si chiude regolarmente', finish(events)?.reason === 'final');
}

console.log('\n\x1b[1m9. Lettura di una pagina\x1b[0m');
{
  const long = 'riga di contenuto\n'.repeat(4000); // ~68k caratteri
  const { client, calls } = fakeTavily({
    results: [{ url: 'https://langium.org/docs', raw_content: long }],
    failed_results: [],
  });

  const events = await runWithWeb(
    toolCallingProvider('fetch_url', { url: 'https://langium.org/docs' }, () => ({ trovato: 'ok' })),
    client,
  );
  const result = events.find((e) => e.type === 'tool-result' && e.tool === 'fetch_url');
  check('colpisce /extract', calls[0]?.url.endsWith('/extract'), calls[0]?.url ?? '');
  check('chiede il markdown', calls[0]?.body.format === 'markdown');
  check('passa un solo URL', Array.isArray(calls[0]?.body.urls) && calls[0].body.urls.length === 1);
  check('la lettura riesce', result?.type === 'tool-result' && result.ok);
}

console.log('\n\x1b[1m10. I tool web restano nascosti senza chiave\x1b[0m');
{
  const compiled = await compileModel(WEB_MACHINE);
  const workspace = mkdtempSync(path.join(tmpdir(), 'orcrist-noweb-'));
  let offered: string[] = [];
  const engine = new Engine({
    machine: compiled.machine!,
    sandbox: new Sandbox(workspace),
    config: { ...DEFAULT_RUNTIME, maxSteps: 10 },
    credentials: { baseUrl: '' },
    // nessun `web`: l'elenco dei tool non deve contenerli
    provider: {
      async chat(req: ChatRequest): Promise<ChatResponse> {
        offered = req.tools.map((t) => t.name);
        return { text: '', toolCalls: [{ id: 'r', name: 'report', input: { trovato: 'ok' } }], stopReason: 'tool_use' };
      },
    },
    emit: () => undefined,
  });
  await engine.run('noweb');
  rmSync(workspace, { recursive: true, force: true });

  check("web_search non viene offerto", !offered.includes('web_search'), offered.join(', '));
  check('fetch_url non viene offerto', !offered.includes('fetch_url'));
  check('i tool sui file ci sono comunque', offered.includes('read_file') && offered.includes('write_file'));
}

console.log('\n\x1b[1m11. Errore di Tavily riportato senza fermare la corsa\x1b[0m');
{
  const { client } = fakeTavily({ detail: { error: 'Unauthorized: missing or invalid API key.' } }, 401);
  const events = await runWithWeb(
    toolCallingProvider('web_search', { query: 'x' }, () => ({ trovato: 'ok' })),
    client,
  );
  const result = events.find((e) => e.type === 'tool-result' && e.tool === 'web_search');
  check('il tool fallisce', result?.type === 'tool-result' && !result.ok);
  check(
    'il messaggio spiega la causa',
    result?.type === 'tool-result' && result.summary.includes('chiave assente o non valida'),
    result?.type === 'tool-result' ? result.summary : '',
  );
  check('la macchina prosegue fino al finale', finish(events)?.reason === 'final');
}

// =====================================================================
// Layout — nodi trascinabili
// =====================================================================

console.log('\n\x1b[1m12. Nodi trascinabili\x1b[0m');
{
  const compiled = await compileModel(readFileSync('../examples/triage-assistenza.orc', 'utf8'));
  const machine = compiled.machine!;

  const auto = layoutMachine(machine);
  check('senza sovrascritture nessun nodo risulta spostato', auto.nodes.every((n) => !n.moved));

  const target = auto.nodes.find((n) => n.name === 'Draft')!;
  const moved = layoutMachine(machine, { Draft: { x: 900, y: 40 } });
  const draft = moved.nodes.find((n) => n.name === 'Draft')!;

  check('la posizione sovrascritta viene rispettata', draft.x === 900 && draft.y === 40);
  check('e viene marcata come spostata', draft.moved);
  check('gli altri nodi non si muovono', moved.nodes.every((n) => n.name === 'Draft' || n.x === auto.nodes.find((a) => a.name === n.name)!.x));
  check('la posizione automatica era diversa', target.x !== 900);

  check(
    'la tela si allarga per contenerlo',
    moved.width >= 900 + NODE_W,
    `${Math.round(auto.width)} -> ${Math.round(moved.width)}`,
  );

  const before = auto.edges.find((e) => e.from === 'Classify' && e.to === 'Draft')!;
  const after = moved.edges.find((e) => e.from === 'Classify' && e.to === 'Draft')!;
  check("l'arco entrante viene ridisegnato", before.path !== after.path);
  check('nessun path degenere', moved.edges.every((e) => e.path && !e.path.includes('NaN')));

  // Un nodo portato sopra al suo predecessore trasforma l'arco in
  // un ritorno: e' il caso che il vecchio instradamento per rango
  // sbagliava, perche' il rango non cambia trascinando.
  const above = layoutMachine(machine, { Draft: { x: 160, y: 0 } });
  const edge = above.edges.find((e) => e.from === 'Classify' && e.to === 'Draft')!;
  const classify = above.nodes.find((n) => n.name === 'Classify')!;
  const drafted = above.nodes.find((n) => n.name === 'Draft')!;
  check('Draft ora sta sopra Classify', drafted.y + NODE_H < classify.y);
  check(
    "l'arco parte dal fianco, non dal fondo",
    !edge.path.startsWith(`M ${classify.x + NODE_W / 2}`),
    edge.path.slice(0, 24),
  );

  const reset = layoutMachine(machine, {});
  check('svuotare le sovrascritture ripristina il layout', reset.nodes.every((n) => !n.moved));
}

// =====================================================================
// Perimetro di scrittura e registro dell'attività
// =====================================================================

console.log('\n\x1b[1m13. Il modello puo\' scrivere solo le locazioni agent\x1b[0m');
{
  const src = `
machine Perimetro {
    locations {
        agent esito: Text;
        agent fiducia: Nat[0..100];
        contatore: Nat[0..9] = 0;
        chiuso: Bool = false;
    }
    initial state Lavora {
        writes esito;
        prompt: "Fai il lavoro.";
        set contatore = contatore + 1;
        otherwise -> Fine;
    }
    final state Fine {}
}`;

  // Il modello prova a scrivere: la locazione dichiarata (lecita), una
  // locazione assegnabile (vietata), una locazione agent non dichiarata
  // in 'writes' (vietata in questo stato) e un nome inventato.
  const { events } = await runMachine(src, () => ({
    esito: 'riuscito',
    contatore: 7,
    fiducia: 90,
    inventata: 'x',
  }));

  const store = events.filter((e) => e.type === 'store-changed').pop();
  const s = store?.type === 'store-changed' ? store.store : {};
  const rejections = events.filter(
    (e): e is Extract<RunEvent, { type: 'write-rejected' }> => e.type === 'write-rejected',
  );

  check('la locazione dichiarata viene scritta', s.esito === 'riuscito');
  check(
    "la locazione assegnabile resta al valore dei 'set'",
    s.contatore === 1,
    `contatore = ${String(s.contatore)}`,
  );
  check('la locazione agent non dichiarata non cambia', s.fiducia === 0, `fiducia = ${String(s.fiducia)}`);
  check('il nome inventato non entra nello store', !('inventata' in s));
  check('vengono segnalati tre rifiuti', rejections.length === 3, rejections.map((r) => r.location).join(', '));
  check(
    "il rifiuto su 'contatore' spiega che serve un set",
    rejections.find((r) => r.location === 'contatore')?.reason.includes("solo un 'set'") ?? false,
    rejections.find((r) => r.location === 'contatore')?.reason ?? '',
  );
  check('la corsa arriva in fondo lo stesso', finish(events)?.reason === 'final');
}

console.log('\n\x1b[1m14. Registro dell\'attività\x1b[0m');
{
  const src = `
machine Registro {
    locations {
        agent nota: Text;
        passi: Nat[0..9] = 0;
    }
    initial state Guarda {
        writes nota;
        prompt: "Guarda.";
        set passi = passi + 1;
        otherwise -> Fine;
    }
    final state Fine {}
}`;
  const { events, workspace } = await runMachine(src, () => ({ nota: 'visto' }), {}, true);
  rmSync(workspace, { recursive: true, force: true });

  // Si ricostruisce lo snapshot come fa la GUI, e si guarda il registro.
  const snap = emptySnapshot();
  for (const e of events) applyEvent(snap, e);
  const visit = snap.traces['Guarda']?.visits[0];

  check('la visita esiste', !!visit);
  const activity = visit?.activity ?? [];
  const kinds = activity.map((a) => a.kind).join(',');

  check('il registro non e\' vuoto', activity.length > 0, kinds);

  const tool = activity.find((a) => a.kind === 'tool');
  check('contiene la chiamata al tool', tool?.kind === 'tool' && tool.tool === 'list_dir');
  check("l'esito del tool si attacca alla stessa voce", tool?.kind === 'tool' && tool.ok === true);
  check(
    'la chiamata compare una volta sola',
    activity.filter((a) => a.kind === 'tool').length === 1,
    kinds,
  );

  const agentWrite = activity.find((a) => a.kind === 'write' && a.by === 'agent');
  check(
    "la scrittura dell'agente e' registrata",
    agentWrite?.kind === 'write' && agentWrite.location === 'nota' && agentWrite.value === 'visto',
  );

  const setWrite = activity.find((a) => a.kind === 'write' && a.by === 'set');
  check(
    "l'assegnazione e' registrata come 'set'",
    setWrite?.kind === 'write' && setWrite.location === 'passi' && setWrite.value === 1,
  );
  check(
    "l'assegnazione conserva il sorgente",
    setWrite?.kind === 'write' && setWrite.source === 'passi = passi + 1',
    setWrite?.kind === 'write' ? (setWrite.source ?? '') : '',
  );

  const order = activity.map((a) => (a.kind === 'write' ? `w:${a.by}` : a.kind));
  check(
    'i tool precedono le scritture, e agent precede set',
    order.join(' ') === 'tool w:agent w:set',
    order.join(' '),
  );
}

console.log('\n\x1b[1m15. Il prompt di sistema dichiara il perimetro\x1b[0m');
{
  const src = `
machine Istruzioni {
    locations {
        agent scrivibile: Text;
        soloLettura: Nat[0..5] = 2;
    }
    initial state Uno {
        writes scrivibile;
        prompt: "Fai.";
        set soloLettura = 3;
        otherwise -> Fine;
    }
    final state Fine {}
}`;
  const compiled = await compileModel(src);
  const workspace = mkdtempSync(path.join(tmpdir(), 'orcrist-sys-'));
  let system = '';
  const engine = new Engine({
    machine: compiled.machine!,
    sandbox: new Sandbox(workspace),
    config: { ...DEFAULT_RUNTIME, maxSteps: 5 },
    credentials: { baseUrl: '' },
    provider: {
      async chat(req: ChatRequest): Promise<ChatResponse> {
        system = req.system;
        return {
          text: '',
          toolCalls: [{ id: 'r', name: 'report', input: { scrivibile: 'ok' } }],
          stopReason: 'tool_use',
        };
      },
    },
    emit: () => undefined,
  });
  await engine.run('sys');
  rmSync(workspace, { recursive: true, force: true });

  check('elenca le locazioni scrivibili', system.includes('Puoi anche SCRIVERE queste 1'));
  check('elenca quelle in sola lettura', system.includes('Queste 1 le puoi leggere ma non scrivere'));
  check("nomina 'report' come unico canale", system.includes("chiamando il tool 'report'"));
  check(
    'avverte che i tentativi vengono rifiutati',
    system.includes('viene rifiutato e registrato'),
  );
  check('mette la locazione giusta nella colonna giusta', () => {
    const cut = system.indexOf('le puoi leggere ma non scrivere');
    const writable = system.slice(system.indexOf('Puoi anche SCRIVERE'), cut);
    const readonly = system.slice(cut);
    return writable.includes('scrivibile:') && !writable.includes('soloLettura:') && readonly.includes('soloLettura:');
  });
  check('dice che la lettura non ha eccezioni', system.includes('Puoi LEGGERE tutte e 2 le locazioni'));
}

console.log('\n\x1b[1m16. Lettura dello stato globale\x1b[0m');
{
  // 'diario' e' assegnabile, quindi il modello non potra' mai
  // scriverla — ma deve poterla leggere per intero.
  const lungo = 'contenuto della locazione. '.repeat(80); // ~2100 caratteri
  const src = `
machine Lettura {
    locations {
        agent esito: Text;
        agent scheda: record { titolo: Text, corpo: Text };
        diario: Text = "${lungo}";
        giri: Nat[0..9] = 0;
    }
    initial state Leggi {
        writes esito;
        prompt: "Leggi lo stato.";
        set giri = giri + 1;
        otherwise -> Fine;
    }
    final state Fine {}
}`;

  const compiled = await compileModel(src);
  if (!compiled.machine) {
    check('il modello di prova compila', false, compiled.diagnostics[0]?.message ?? '');
  } else {
    const workspace = mkdtempSync(path.join(tmpdir(), 'orcrist-read-'));
    const events: RunEvent[] = [];
    let system = '';
    let offered: string[] = [];
    const seen: string[] = [];

    // Il modello legge una locazione che non potrebbe mai scrivere,
    // poi un campo di record, poi chiude.
    const queue = [
      { location: 'diario' },
      { location: 'scheda', path: 'corpo' },
      { location: 'inesistente' },
    ];

    const engine = new Engine({
      machine: compiled.machine,
      sandbox: new Sandbox(workspace),
      config: { ...DEFAULT_RUNTIME, maxSteps: 5 },
      credentials: { baseUrl: '' },
      provider: {
        async chat(req: ChatRequest): Promise<ChatResponse> {
          system = req.system;
          offered = req.tools.map((t) => t.name);
          // La conversazione riporta ogni volta tutti i risultati
          // precedenti: si rilegge da capo invece di accumulare doppioni.
          seen.length = 0;
          for (const m of req.messages) {
            if (m.role === 'tool' && m.name === 'read_location') seen.push(m.content);
          }
          const next = queue.shift();
          if (next) {
            return {
              text: '',
              toolCalls: [{ id: `r${seen.length}`, name: 'read_location', input: next }],
              stopReason: 'tool_use',
            };
          }
          return {
            text: '',
            toolCalls: [{ id: 'fin', name: 'report', input: { esito: 'letto' } }],
            stopReason: 'tool_use',
          };
        },
      },
      emit: (e) => events.push(e),
    });
    await engine.run('read');
    rmSync(workspace, { recursive: true, force: true });

    check("il tool read_location viene offerto", offered.includes('read_location'), offered.join(', '));

    const results = events.filter(
      (e): e is Extract<RunEvent, { type: 'tool-result' }> => e.type === 'tool-result' && e.tool === 'read_location',
    );
    check('sono state fatte tre letture', results.length === 3, String(results.length));
    check('la lettura di una locazione in sola lettura riesce', results[0]?.ok === true, results[0]?.summary ?? '');
    check('la lettura di un campo di record riesce', results[1]?.ok === true, results[1]?.summary ?? '');
    check('una locazione inesistente viene respinta', results[2]?.ok === false, results[2]?.summary ?? '');

    const diario = seen[0] ?? '';
    check(
      'il valore torna per intero, non abbreviato',
      diario.length > 2000 && diario.includes(lungo.trim().slice(-40)),
      `${diario.length} caratteri`,
    );
    check(
      'la risposta dichiara che e\' in sola lettura',
      diario.startsWith('diario (sola lettura)'),
      diario.slice(0, 40),
    );
    check(
      'il campo di record e\' identificato col percorso',
      (seen[1] ?? '').startsWith('scheda.corpo'),
      (seen[1] ?? '').slice(0, 40),
    );

    // Il perimetro di scrittura non si e' allargato.
    const store = events.filter((e) => e.type === 'store-changed').pop();
    const s = store?.type === 'store-changed' ? store.store : {};
    check('leggere non cambia niente: diario e\' intatto', typeof s.diario === 'string' && s.diario.length > 2000);
    check("il contatore resta quello dei 'set'", s.giri === 1);

    // E il prompt di sistema lo dice.
    check('il prompt annuncia che si legge tutto', system.includes('Puoi LEGGERE tutte e 4 le locazioni'));
    check("il prompt nomina read_location", system.includes('read_location'));
    check(
      'il prompt segnala il valore abbreviato',
      system.includes('usa read_location per leggerla intera'),
    );
  }
}

console.log('\n\x1b[1m17. Leggere tutto non significa poter scrivere tutto\x1b[0m');
{
  const src = `
machine Confine {
    locations {
        agent nota: Text;
        blindata: Nat[0..9] = 4;
    }
    initial state Uno {
        writes nota;
        prompt: "Fai.";
        set blindata = 5;
        otherwise -> Fine;
    }
    final state Fine {}
}`;
  const { events } = await runMachine(src, () => ({ nota: 'ok', blindata: 9 }));
  const store = events.filter((e) => e.type === 'store-changed').pop();
  const s = store?.type === 'store-changed' ? store.store : {};
  const rejected = events.find(
    (e): e is Extract<RunEvent, { type: 'write-rejected' }> => e.type === 'write-rejected',
  );

  check("la locazione leggibile-ma-non-scrivibile segue il 'set'", s.blindata === 5, String(s.blindata));
  check('il tentativo di scriverla viene rifiutato', rejected?.location === 'blindata');
  check('la locazione agent invece cambia', s.nota === 'ok');
}

// =====================================================================
// Anthropic — parametri di campionamento non piu' accettati
// =====================================================================

console.log("\n\x1b[1m18. Anthropic: 'temperature' rifiutata dai modelli recenti\x1b[0m");
{
  const { anthropicProvider, resetLearnedRejections } = await import('../src/main/llm/anthropic.js');
  const realFetch = globalThis.fetch;

  /** Finto endpoint: 400 se arriva 'temperature', altrimenti risponde. */
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    if ('temperature' in body) {
      return new Response(
        JSON.stringify({ detail: { error: '`temperature` is deprecated for this model' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({ content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    resetLearnedRejections();
    const notices: string[] = [];
    const ask = (temperature?: number): Promise<{ text: string }> =>
      anthropicProvider.chat(
        {
          system: 's',
          messages: [{ role: 'user', content: 'ping' }],
          tools: [],
          model: 'claude-sonnet-5',
          temperature,
          maxTokens: 16,
          onNotice: (m) => notices.push(m),
        },
        { apiKey: 'sk-ant-finta', baseUrl: 'https://api.anthropic.com' },
      );

    const first = await ask(0);
    check('la richiesta riesce nonostante il 400 iniziale', first.text === 'pong', first.text);
    check('il primo tentativo conteneva la temperatura', 'temperature' in (bodies[0] ?? {}));
    check('il secondo la ha omessa', !('temperature' in (bodies[1] ?? {})));
    check('sono bastati due tentativi', bodies.length === 2, String(bodies.length));
    check(
      "l'aggiustamento viene raccontato all'utente",
      notices.some((m) => m.includes('temperature')),
      notices.join(' | '),
    );

    bodies.length = 0;
    await ask(0);
    check(
      'la chiamata successiva parte gia\' senza temperatura, senza sprecare un tentativo',
      bodies.length === 1 && !('temperature' in (bodies[0] ?? {})),
      `${bodies.length} tentativi`,
    );

    // Senza temperatura richiesta il campo non compare mai.
    resetLearnedRejections();
    bodies.length = 0;
    await ask(undefined);
    check(
      'se la temperatura non e\' impostata, il campo non viene mandato affatto',
      bodies.length === 1 && !('temperature' in (bodies[0] ?? {})),
      `${bodies.length} tentativi`,
    );

    // Un 400 che parla d'altro non deve innescare ritentativi.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: { error: 'credit balance is too low' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    resetLearnedRejections();
    let message = '';
    try {
      await ask(0);
    } catch (err) {
      message = (err as Error).message;
    }
    check(
      'un 400 di altra natura viene propagato senza ritentare',
      message.includes('credit balance'),
      message,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// =====================================================================
// ask_user — la macchina si ferma e aspetta una persona
// =====================================================================

const ASK_MACHINE = `
machine ConDomanda {
    locations { agent scelta: Text; }
    initial state Chiedi {
        writes scelta;
        prompt: "Chiedi qualcosa.";
        otherwise -> Fine;
    }
    final state Fine {}
}`;

/**
 * Esegue una macchina in cui il modello pone una domanda.
 *
 * Il ponte e' quello vero — `createAskBridge` — non un doppio: e' li'
 * che vive la logica di sospensione e interruzione, ed e' quella che
 * va provata. `respond` riceve la richiesta e decide se e come
 * rispondere, esattamente come farebbe l'interfaccia.
 */
async function runWithAsk(
  input: Record<string, unknown>,
  respond: (
    request: import('../src/shared/protocol.js').AskRequest,
    reply: (answer: import('../src/shared/protocol.js').AskAnswer) => void,
    engine: Engine,
  ) => void,
): Promise<{ events: RunEvent[]; offered: string[]; seen: string[] }> {
  const { createAskBridge } = await import('../src/main/ask-bridge.js');
  const bridge = createAskBridge();
  const PROJECT = 'p1';

  const compiled = await compileModel(ASK_MACHINE);
  const workspace = mkdtempSync(path.join(tmpdir(), 'orcrist-ask-'));
  const events: RunEvent[] = [];
  const seen: string[] = [];
  let offered: string[] = [];
  let asked = false;

  let engine!: Engine;
  engine = new Engine({
    machine: compiled.machine!,
    sandbox: new Sandbox(workspace),
    config: { ...DEFAULT_RUNTIME, maxSteps: 8 },
    credentials: { baseUrl: '' },
    ask: (request, signal) => {
      const promise = bridge.ask(PROJECT, request, signal);
      // L'interfaccia risponde in un giro d'orologio successivo, come
      // farebbe una persona: il tool nel frattempo e' gia' sospeso.
      setTimeout(() => respond(request, (a) => bridge.answer(PROJECT, a), engine), 0);
      return promise;
    },
    provider: {
      async chat(req: ChatRequest): Promise<ChatResponse> {
        offered = req.tools.map((t) => t.name);
        for (const m of req.messages) {
          if (m.role === 'tool' && m.name === 'ask_user') seen.push(m.content);
        }
        if (!asked) {
          asked = true;
          return { text: '', toolCalls: [{ id: 'a1', name: 'ask_user', input }], stopReason: 'tool_use' };
        }
        return {
          text: '',
          toolCalls: [{ id: 'r1', name: 'report', input: { scelta: seen[0] ?? '' } }],
          stopReason: 'tool_use',
        };
      },
    },
    emit: (e) => events.push(e),
  });

  await engine.run('ask');
  rmSync(workspace, { recursive: true, force: true });
  return { events, offered, seen };
}

console.log('\n\x1b[1m19. Domanda a scelta chiusa\x1b[0m');
{
  let received: import('../src/shared/protocol.js').AskRequest | undefined;
  const { events, offered, seen } = await runWithAsk(
    {
      question: 'Quale strategia preferisci?',
      kind: 'single',
      options: ['Riscrivere da zero', 'Correggere quello che c\'e\''],
      detail: 'La prima è più pulita, la seconda più rapida.',
    },
    (request, reply) => {
      received = request;
      reply({ id: request.id, selected: ['Riscrivere da zero'] });
    },
  );

  check("il tool ask_user viene offerto", offered.includes('ask_user'), offered.join(', '));
  check('la domanda arriva alla GUI', received?.question === 'Quale strategia preferisci?');
  check("porta con se' lo stato che l'ha posta", received?.state === 'Chiedi', received?.state ?? '');
  check('le alternative sono conservate', received?.options?.length === 2, JSON.stringify(received?.options));
  check("l'id e' assegnato dal runtime", !!received?.id && received.id.startsWith('ask_'), received?.id ?? '');
  check(
    'la risposta torna al modello in chiaro',
    (seen[0] ?? '').includes('Ha scelto: Riscrivere da zero'),
    seen[0] ?? '',
  );
  check(
    "l'evento di richiesta e quello di risposta si accoppiano",
    events.some((e) => e.type === 'ask-requested') &&
      events.some((e) => e.type === 'ask-answered' && e.id === received?.id && !e.skipped),
  );
  check('la corsa prosegue fino al finale', finish(events)?.reason === 'final');

  // Lo snapshot deve tornare pulito: nessuna domanda appesa.
  const snap = emptySnapshot();
  for (const e of events) applyEvent(snap, e);
  check('nello snapshot non resta nessuna domanda in sospeso', snap.pendingAsk === undefined);
}

console.log('\n\x1b[1m20. Scelta multipla e risposta aperta\x1b[0m');
{
  const multi = await runWithAsk(
    { question: 'Quali file tocco?', kind: 'multi', options: ['a.ts', 'b.ts', 'c.ts'] },
    (r, reply) => reply({ id: r.id, selected: ['a.ts', 'c.ts'] }),
  );
  check(
    'una scelta multipla arriva al modello come elenco',
    (multi.seen[0] ?? '').includes('Ha scelto: a.ts, c.ts'),
    multi.seen[0] ?? '',
  );

  const open = await runWithAsk(
    { question: 'Come si chiama il modulo?', kind: 'open', placeholder: 'nome-modulo' },
    (r, reply) => reply({ id: r.id, text: '  parser-core  ' }),
  );
  check(
    'una risposta aperta arriva ripulita dagli spazi',
    (open.seen[0] ?? '').includes('Ha scritto: parser-core'),
    open.seen[0] ?? '',
  );
}

console.log('\n\x1b[1m21. Salta, e domande malformate\x1b[0m');
{
  const skipped = await runWithAsk({ question: 'Confermi?', kind: 'open' }, (r, reply) =>
    reply({ id: r.id, skipped: true }),
  );
  check(
    'saltare dice al modello di decidere da solo',
    (skipped.seen[0] ?? '').includes('non rispondere'),
    skipped.seen[0] ?? '',
  );
  check(
    "l'evento registra che e' stata saltata",
    skipped.events.some((e) => e.type === 'ask-answered' && e.skipped),
  );
  check('la corsa non si blocca', finish(skipped.events)?.reason === 'final');

  // Una chiusa senza alternative e' un errore del modello, non un blocco.
  const malformed = await runWithAsk(
    { question: 'Scegli', kind: 'single', options: ['solo una'] },
    (r, reply) => reply({ id: r.id, text: 'mai chiamata' }),
  );
  const result = malformed.events.find(
    (e): e is Extract<RunEvent, { type: 'tool-result' }> => e.type === 'tool-result' && e.tool === 'ask_user',
  );
  check('una scelta con una sola alternativa viene rifiutata', result?.ok === false, result?.summary ?? '');
  check(
    "l'errore suggerisce la forma giusta",
    (result?.summary ?? '').includes("kind 'open'"),
    result?.summary ?? '',
  );
  check('e nessuna domanda raggiunge la GUI', !malformed.events.some((e) => e.type === 'ask-requested'));
}

console.log('\n\x1b[1m22. Stop mentre la domanda e\' in attesa\x1b[0m');
{
  const { events } = await runWithAsk({ question: 'Aspetto', kind: 'open' }, (_r, _reply, engine) => {
    // Nessuno risponde: si preme Stop mentre il tool e' sospeso.
    engine.stop();
  });

  check('la corsa si chiude come interrotta', finish(events)?.reason === 'stopped', finish(events)?.reason ?? '');
  check(
    'la domanda viene comunque chiusa, senza restare appesa',
    events.some((e) => e.type === 'ask-answered' && e.skipped),
  );

  const snap = emptySnapshot();
  for (const e of events) applyEvent(snap, e);
  check('lo snapshot non conserva una domanda orfana', snap.pendingAsk === undefined);
}

console.log("\n\x1b[1m23. Senza interfaccia il tool non esiste\x1b[0m");
{
  const compiled = await compileModel(ASK_MACHINE);
  const workspace = mkdtempSync(path.join(tmpdir(), 'orcrist-noask-'));
  let offered: string[] = [];
  const engine = new Engine({
    machine: compiled.machine!,
    sandbox: new Sandbox(workspace),
    config: { ...DEFAULT_RUNTIME, maxSteps: 5 },
    credentials: { baseUrl: '' },
    // niente `ask`
    provider: {
      async chat(req: ChatRequest): Promise<ChatResponse> {
        offered = req.tools.map((t) => t.name);
        return { text: '', toolCalls: [{ id: 'r', name: 'report', input: { scelta: '.' } }], stopReason: 'tool_use' };
      },
    },
    emit: () => undefined,
  });
  await engine.run('noask');
  rmSync(workspace, { recursive: true, force: true });

  check(
    "ask_user non viene offerto se non c'e' nessuno a cui chiedere",
    !offered.includes('ask_user'),
    offered.join(', '),
  );
}

console.log(
  failures === 0
    ? '\n\x1b[32mTutti i controlli passano.\x1b[0m\n'
    : `\n\x1b[31m${failures} controlli falliti.\x1b[0m\n`,
);
process.exit(failures ? 1 : 0);
