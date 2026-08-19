// =====================================================================
// Conformità del runtime al metamodello.
//
// Questa suite non prova che il programma "funzioni": prova che faccia
// esattamente quello che la grammatica dichiara. Per ogni primitiva
// del DSL c'e' una sezione, e ogni asserzione cita la regola che sta
// verificando — quando una cambia nel .langium, qui deve rompersi
// qualcosa.
//
// Riferimento: metamodel/orcrist.langium
// =====================================================================

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileModel } from '../src/language/compile.js';
import { Engine } from '../src/main/runtime/engine.js';
import { Sandbox } from '../src/main/runtime/sandbox.js';
import type { ChatRequest, ChatResponse, LlmProvider } from '../src/main/llm/types.js';
import type { IRValue, Store } from '../src/shared/ir.js';
import { DEFAULT_RUNTIME } from '../src/shared/protocol.js';
import type { RunEvent } from '../src/shared/protocol.js';

let failures = 0;
let current = '';

function section(title: string): void {
  current = title;
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function check(rule: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '\x1b[32m  ok  \x1b[0m' : '\x1b[31mFAIL  \x1b[0m'}${rule}${detail ? `\n        \x1b[2m${detail}\x1b[0m` : ''}`);
  if (!ok) failures++;
}

// --- esecuzione di un modello con risposte prestabilite ---------------

interface Outcome {
  store: Store;
  events: RunEvent[];
  trail: string[];
  prompts: string[];
  systems: string[];
  finished?: Extract<RunEvent, { type: 'run-finished' }>;
}

/** Cosa il finto modello riporta, per stato e numero di visita. */
type Script = (state: string, visit: number) => Record<string, unknown>;

async function run(
  source: string,
  script: Script = () => ({}),
  opts: { files?: Record<string, string>; config?: Partial<typeof DEFAULT_RUNTIME> } = {},
): Promise<Outcome> {
  const compiled = await compileModel(source);
  if (!compiled.machine) {
    const errs = compiled.diagnostics.filter((d) => d.severity === 'error');
    throw new Error(`[${current}] il modello non compila: ${errs.map((e) => e.message).join('; ')}`);
  }

  const workspace = mkdtempSync(path.join(tmpdir(), 'orcrist-conf-'));
  for (const [name, content] of Object.entries(opts.files ?? {})) {
    writeFileSync(path.join(workspace, name), content);
  }

  const events: RunEvent[] = [];
  const prompts: string[] = [];
  const systems: string[] = [];
  const visits = new Map<string, number>();

  const provider: LlmProvider = {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      systems.push(req.system);
      const last = req.messages[0];
      if (last?.role === 'user') prompts.push(last.content);
      const state = /stato '([^']+)'/.exec(req.system)?.[1] ?? '?';
      if (!req.tools.some((t) => t.name === 'report')) {
        return { text: '', toolCalls: [], stopReason: 'end_turn' };
      }
      const visit = (visits.get(state) ?? 0) + 1;
      visits.set(state, visit);
      return {
        text: '',
        toolCalls: [{ id: `r${visit}`, name: 'report', input: script(state, visit) }],
        stopReason: 'tool_use',
      };
    },
  };

  const engine = new Engine({
    machine: compiled.machine,
    sandbox: new Sandbox(workspace),
    config: { ...DEFAULT_RUNTIME, maxSteps: 40, ...(opts.config ?? {}) },
    credentials: { baseUrl: '' },
    provider,
    emit: (e) => events.push(e),
  });
  await engine.run('conf');
  rmSync(workspace, { recursive: true, force: true });

  const lastStore = [...events].reverse().find((e) => e.type === 'store-changed');
  const started = events.find((e) => e.type === 'run-started');

  return {
    store:
      lastStore?.type === 'store-changed'
        ? lastStore.store
        : started?.type === 'run-started'
          ? started.store
          : {},
    events,
    trail: events
      .filter((e): e is Extract<RunEvent, { type: 'state-entered' }> => e.type === 'state-entered')
      .map((e) => e.state),
    prompts,
    systems,
    finished: events.find(
      (e): e is Extract<RunEvent, { type: 'run-finished' }> => e.type === 'run-finished',
    ),
  };
}

/** Diagnostiche di compilazione, per i vincoli che stanno nel validatore. */
async function diagnose(source: string): Promise<{ errors: string[]; warnings: string[]; ok: boolean }> {
  const r = await compileModel(source);
  return {
    ok: r.ok,
    errors: r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
    warnings: r.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message),
  };
}

const has = (list: string[], fragment: string): boolean => list.some((m) => m.includes(fragment));

// =====================================================================
// machine
// =====================================================================

section("machine — 'locations' e 'invariants' facoltativi, il nome raggiunge il modello");
{
  const o = await run(`
machine Nuda {
    initial state Uno { prompt: "Ciao."; otherwise -> Fine; }
    final state Fine {}
}`);
  check("una macchina senza blocco 'locations' e senza invarianti compila ed esegue", o.finished?.reason === 'final');
  check(
    'il nome della macchina compare nel prompt di sistema',
    o.systems[0]?.includes("chiamata 'Nuda'") ?? false,
  );
}

// =====================================================================
// Location — ownership
// =====================================================================

section("Location — 'agent' e assegnabile sono mondi separati");
{
  const d = await diagnose(`
machine Ownership {
    locations { agent x: Text; }
    initial state Uno { writes x; prompt: "."; set x = "no"; otherwise -> Fine; }
    final state Fine {}
}`);
  check(
    "'set' su una locazione 'agent' e' un errore di compilazione",
    has(d.errors, "e' marcata 'agent'"),
    d.errors.join(' | '),
  );

  const d2 = await diagnose(`
machine Ownership2 {
    locations { y: Text; }
    initial state Uno { writes y; prompt: "."; otherwise -> Fine; }
    final state Fine {}
}`);
  check(
    "'writes' su una locazione non 'agent' e' un errore di compilazione",
    has(d2.errors, "non e' marcata 'agent'"),
    d2.errors.join(' | '),
  );
}

section('Location — init costante, altrimenti il valore neutro del tipo');
{
  const o = await run(`
machine Init {
    locations {
        agent segna: Text;
        conBool: Bool = true;
        conNum: Int[-5..5] = -3;
        senzaBool: Bool;
        senzaNum: Nat[0..9];
        senzaText: Text;
        senzaEnum: { rosso, verde };
        senzaRec: record { a: Nat, b: Text };
    }
    initial state Uno { writes segna; prompt: "."; set conBool = true; otherwise -> Fine; }
    final state Fine {}
}`, () => ({ segna: 'x' }));

  check("l'init esplicito viene applicato", o.store.conBool === true && o.store.conNum === -3);
  check('Bool senza init parte da false', o.store.senzaBool === false);
  check("Nat senza init parte dall'estremo inferiore", o.store.senzaNum === 0);
  check('Text senza init parte dalla stringa vuota', o.store.senzaText === '');
  check('un enum senza init parte dal primo letterale', o.store.senzaEnum === 'rosso');
  check(
    'un record senza init ha tutti i campi al valore neutro',
    JSON.stringify(o.store.senzaRec) === JSON.stringify({ a: 0, b: '' }),
    JSON.stringify(o.store.senzaRec),
  );

  const d = await diagnose(`
machine InitRef {
    locations { a: Nat = 1; b: Nat = a; }
    initial state Uno { prompt: "."; set a = 2; set b = 3; otherwise -> Fine; }
    final state Fine {}
}`);
  check(
    "un init che legge un'altra locazione e' rifiutato",
    has(d.errors, 'deve essere costante'),
    d.errors.join(' | '),
  );
}

// =====================================================================
// Tipi
// =====================================================================

section('Tipi — i bound rendono finito il dominio');
{
  const o = await run(`
machine Bound {
    locations {
        agent n: Nat[2..8];
        agent i: Int[-4..4];
        c: Nat[0..3] = 0;
    }
    initial state Uno {
        writes n, i;
        prompt: ".";
        set c = c + 10;
        otherwise -> Fine;
    }
    final state Fine {}
}`, () => ({ n: 99, i: -99 }));

  check("un valore sopra l'estremo superiore viene riportato dentro", o.store.n === 8, String(o.store.n));
  check("un valore sotto l'estremo inferiore viene riportato dentro", o.store.i === -4, String(o.store.i));
  check("anche un 'set' fuori dominio viene riportato dentro", o.store.c === 3, String(o.store.c));
  check(
    'ogni riporto viene segnalato',
    o.events.filter((e) => e.type === 'bounds-clamped').length === 3,
    String(o.events.filter((e) => e.type === 'bounds-clamped').length),
  );

  const d = await diagnose(`
machine BoundRotti {
    locations { agent a: Nat[5..2]; b: Nat[-1..3] = 0; }
    initial state Uno { writes a; prompt: "."; set b = 1; otherwise -> Fine; }
    final state Fine {}
}`);
  check('un intervallo vuoto e\' un errore', has(d.errors, 'Intervallo vuoto'), d.errors.join(' | '));
  check(
    'un Nat con estremo inferiore negativo e\' un errore',
    has(d.errors, 'estremo inferiore negativo'),
    d.errors.join(' | '),
  );
}

section('Tipi — Int ammette valori negativi, Nat no');
{
  const o = await run(`
machine Segni {
    locations {
        agent i: Int;
        agent n: Nat;
    }
    initial state Uno { writes i, n; prompt: "."; otherwise -> Fine; }
    final state Fine {}
}`, () => ({ i: -7, n: -7 }));
  check('Int conserva il segno', o.store.i === -7, String(o.store.i));
  check('Nat non puo\' diventare negativo', o.store.n === 0, String(o.store.n));
}

section('Tipi — enum e record');
{
  const o = await run(`
machine Composti {
    locations {
        agent stato: { aperto, chiuso, sospeso };
        agent scheda: record { id: Text, conteggio: Nat[0..5] };
    }
    initial state Uno { writes stato, scheda; prompt: "."; otherwise -> Fine; }
    final state Fine {}
}`, () => ({ stato: '#sospeso', scheda: { id: 'A1', conteggio: 9, extra: 'ignorato' } }));

  check("il cancelletto davanti a un letterale enum viene tollerato", o.store.stato === 'sospeso', String(o.store.stato));
  check(
    'un record accetta solo i campi dichiarati',
    JSON.stringify(o.store.scheda) === JSON.stringify({ id: 'A1', conteggio: 5 }),
    JSON.stringify(o.store.scheda),
  );

  const d = await diagnose(`
machine EnumFuori {
    locations { agent s: { a, b }; }
    initial state Uno {
        writes s;
        prompt: ".";
        on s == #zzz -> Fine;
        otherwise -> Fine;
    }
    final state Fine {}
}`);
  check(
    'un letterale enum fuori dominio e\' un errore di compilazione',
    has(d.errors, 'non appartiene al dominio'),
    d.errors.join(' | '),
  );
}

section('Tipi — un valore enum non valido riportato dal modello');
{
  const o = await run(`
machine EnumSporco {
    locations { agent s: { a, b, c }; }
    initial state Uno { writes s; prompt: "."; otherwise -> Fine; }
    final state Fine {}
}`, () => ({ s: 'inventato' }));
  check(
    'il valore resta dentro il dominio',
    ['a', 'b', 'c'].includes(String(o.store.s)),
    String(o.store.s),
  );
  check(
    'e la sostituzione viene segnalata invece di passare in silenzio',
    o.events.some((e) => e.type === 'notice' && e.message.includes('inventato')),
    o.events.filter((e) => e.type === 'notice').map((e) => (e.type === 'notice' ? e.message : '')).join(' | '),
  );
}

// =====================================================================
// invariant
// =====================================================================

section('invariant — condizione booleana sullo stato globale');
{
  const o = await run(`
machine Inv {
    locations {
        agent inviato: Bool;
        escalato: Bool = false;
    }
    invariant esclusivi: not (inviato and escalato);

    initial state Uno { writes inviato; prompt: "."; set escalato = true; otherwise -> Fine; }
    final state Fine {}
}`, () => ({ inviato: true }));
  const v = o.events.find((e) => e.type === 'invariant-violated');
  check('una violazione viene rilevata e nominata', v?.type === 'invariant-violated' && v.name === 'esclusivi');
  check('la corsa non si interrompe per una violazione', o.finished?.reason === 'final');

  const d = await diagnose(`
machine InvNum {
    locations { c: Nat[0..9] = 1; }
    invariant sbagliata: c + 1;
    initial state Uno { prompt: "."; set c = 2; otherwise -> Fine; }
    final state Fine {}
}`);
  check(
    'un\'invariante non booleana e\' un errore',
    has(d.errors, "Un'invariante deve essere Bool"),
    d.errors.join(' | '),
  );
}

section('invariant — verificata anche sullo stato iniziale');
{
  const o = await run(`
machine InvIniziale {
    locations {
        agent x: Text;
        a: Nat[0..9] = 5;
        b: Nat[0..9] = 2;
    }
    invariant ordinati: a <= b;

    initial state Uno { writes x; prompt: "."; set a = 1; otherwise -> Fine; }
    final state Fine {}
}`, () => ({ x: 'ok' }));

  // Gli init violano l'invariante prima ancora che la macchina parta:
  // se nessuno guarda, il modello sembra sano e non lo e'.
  const first = o.events.find((e) => e.type === 'invariant-violated');
  check(
    "la violazione presente negli init viene segnalata all'avvio",
    first?.type === 'invariant-violated' && first.state === '(init)',
    first?.type === 'invariant-violated' ? `segnalata in '${first.state}'` : 'nessuna segnalazione',
  );
}

// =====================================================================
// Stati
// =====================================================================

section('State — un solo initial, i final chiudono la corsa');
{
  const d = await diagnose(`
machine DueIniziali {
    initial state A { prompt: "."; otherwise -> Fine; }
    initial state B { prompt: "."; otherwise -> Fine; }
    final state Fine {}
}`);
  check('due stati iniziali sono un errore', has(d.errors, "Piu' di uno stato iniziale"), d.errors.join(' | '));

  const d2 = await diagnose(`
machine SenzaFinale {
    initial state A { prompt: "."; otherwise -> A; }
}`);
  check('una macchina senza stati finali e\' un errore', has(d2.errors, 'non ha stati finali'), d2.errors.join(' | '));

  const o = await run(`
machine Chiude {
    initial state A { prompt: "."; otherwise -> Fine; }
    final state Fine {}
    final state MaiRaggiunto {}
}`);
  check('la corsa termina appena si entra in uno stato finale', o.finished?.reason === 'final');
  check('e lo stato finale non interroga il modello', o.prompts.length === 1, `${o.prompts.length} prompt`);
  check(
    'lo stato finale compare comunque nella traccia',
    o.trail[o.trail.length - 1] === 'Fine',
    o.trail.join(' -> '),
  );
}

section("State — prompt e 'otherwise' obbligatori: nessun deadlock");
{
  const d = await diagnose(`
machine SenzaOtherwise {
    locations { agent x: Bool; }
    initial state A { writes x; prompt: "."; on x -> Fine; }
    final state Fine {}
}`);
  check(
    "uno stato attivo senza 'otherwise' non e' nemmeno parsabile",
    !d.ok,
    d.errors.slice(0, 1).join(''),
  );

  const d2 = await diagnose(`
machine SenzaPrompt {
    initial state A { otherwise -> Fine; }
    final state Fine {}
}`);
  check('uno stato attivo senza prompt non e\' parsabile', !d2.ok, d2.errors.slice(0, 1).join(''));
}

// =====================================================================
// writes — la condizione di frame
// =====================================================================

section("writes — il frame e' 'writes' piu' i bersagli dei 'set', nient'altro cambia");
{
  const o = await run(`
machine Frame {
    locations {
        agent tocca: Text;
        agent intatta: Text = "prima";
        contatore: Nat[0..9] = 0;
        ferma: Nat[0..9] = 4;
    }
    initial state Uno {
        writes tocca;
        prompt: ".";
        set contatore = contatore + 1;
        otherwise -> Fine;
    }
    final state Fine {}
}`, () => ({ tocca: 'dopo' }));

  check("la locazione in 'writes' cambia", o.store.tocca === 'dopo');
  check("il bersaglio del 'set' cambia", o.store.contatore === 1);
  check(
    "una locazione 'agent' fuori dal frame resta ferma",
    o.store.intatta === 'prima',
    String(o.store.intatta),
  );
  check('una locazione assegnabile fuori dal frame resta ferma', o.store.ferma === 4, String(o.store.ferma));
}

section("writes — quello che manca nel report non azzera la locazione");
{
  const o = await run(`
machine Parziale {
    locations {
        agent a: Text = "vecchio";
        agent b: Text;
    }
    initial state Uno { writes a, b; prompt: "."; otherwise -> Fine; }
    final state Fine {}
}`, () => ({ b: 'nuovo' }));
  check(
    'una locazione dichiarata ma non riportata conserva il valore precedente',
    o.store.a === 'vecchio',
    String(o.store.a),
  );
  check('e la mancanza viene segnalata', o.events.some((e) => e.type === 'notice' && e.message.includes("'a'")));
  check("la locazione riportata invece cambia", o.store.b === 'nuovo');
}

// =====================================================================
// prompt
// =====================================================================

section('prompt — le parti si concatenano e le interpolazioni leggono lo store');
{
  const o = await run(`
machine Template {
    locations {
        agent nota: Text;
        n: Nat[0..9] = 3;
        s: { alfa, beta } = #beta;
        r: record { campo: Text } ;
    }
    initial state Uno {
        writes nota;
        prompt: "n=" <n> " s=" <s> " r=" <r.campo> "\\nriga due\\tcon tab";
        set n = 4;
        otherwise -> Fine;
    }
    final state Fine {}
}`, () => ({ nota: '.' }));

  const p = o.prompts[0] ?? '';
  // 'r.campo' e' la stringa vuota, quindi fra "r=" e l'a capo non
  // deve comparire niente: e' proprio l'assenza di separatori.
  check(
    'le parti testuali e le interpolazioni si concatenano senza separatori',
    p === 'n=3 s=beta r=\nriga due\tcon tab',
    JSON.stringify(p),
  );
  check("un enum si interpola senza il cancelletto", p.includes('s=beta'), JSON.stringify(p));
  check('gli escape del sorgente diventano caratteri veri', p.includes('\n') && p.includes('\t'), JSON.stringify(p));
}

section('prompt — le interpolazioni vedono i valori prima delle assegnazioni dello stato');
{
  const o = await run(`
machine Ordine {
    locations {
        agent x: Text;
        giro: Nat[0..9] = 0;
    }
    initial state Uno {
        writes x;
        prompt: "giro " <giro>;
        set giro = giro + 1;
        limit visits <= 2 else -> Fine;
        on giro > 1 -> Fine;
        otherwise -> Uno;
    }
    final state Fine {}
}`, () => ({ x: '.' }));
  check(
    "alla prima visita il contatore e' ancora 0, alla seconda 1",
    o.prompts[0] === 'giro 0' && o.prompts[1] === 'giro 1',
    o.prompts.join(' | '),
  );
}

// =====================================================================
// set
// =====================================================================

section("set — eseguite in ordine, dopo il prompt, con accesso ai campi");
{
  const o = await run(`
machine Assegna {
    locations {
        agent tick: Text;
        a: Nat[0..9] = 1;
        b: Nat[0..9] = 0;
        rec: record { x: Nat[0..9], y: Nat[0..9] };
    }
    initial state Uno {
        writes tick;
        prompt: ".";
        set a = a + 1;
        set b = a + 1;
        set rec.y = 7;
        otherwise -> Fine;
    }
    final state Fine {}
}`, () => ({ tick: '.' }));

  check("le assegnazioni si vedono l'una con l'altra, in ordine", o.store.a === 2 && o.store.b === 3, `a=${String(o.store.a)} b=${String(o.store.b)}`);
  check(
    "'set' su un campo di record tocca solo quel campo",
    JSON.stringify(o.store.rec) === JSON.stringify({ x: 0, y: 7 }),
    JSON.stringify(o.store.rec),
  );
}

// =====================================================================
// limit
// =====================================================================

section("limit — 'visits <= N' concede N esecuzioni, poi devia senza interrogare il modello");
{
  const o = await run(`
machine Fuel {
    locations { agent x: Bool; }
    initial state Gira {
        writes x;
        prompt: ".";
        limit visits <= 3 else -> Resa;
        on x -> Fine;
        otherwise -> Gira;
    }
    state Resa { prompt: "."; otherwise -> Fine; }
    final state Fine {}
}`, () => ({ x: false }));

  const promptsGira = o.events.filter((e) => e.type === 'prompt-built' && e.state === 'Gira').length;
  check("con 'visits <= 3' il modello viene interrogato tre volte", promptsGira === 3, String(promptsGira));
  check(
    'la quarta entrata devia',
    o.trail.join(' -> ') === 'Gira -> Gira -> Gira -> Gira -> Resa -> Fine',
    o.trail.join(' -> '),
  );
  const hop = o.events.find((e) => e.type === 'transition' && e.reason === 'limit');
  check("la deviazione e' marcata come 'limit'", hop?.type === 'transition' && hop.to === 'Resa');

  const d = await diagnose(`
machine SelfLimit {
    locations { agent x: Bool; }
    initial state A { writes x; prompt: "."; limit visits <= 2 else -> A; otherwise -> Fine; }
    final state Fine {}
}`);
  check("un 'limit' che rimanda a se' stesso e' un errore", has(d.errors, 'rimanda a se'), d.errors.join(' | '));
}

section('limit — il fuel e\' un budget di corsa, non per attraversamento');
{
  const o = await run(`
machine Budget {
    locations { agent x: Nat[0..9]; }
    initial state A {
        writes x;
        prompt: ".";
        limit visits <= 2 else -> Fine;
        on x == 1 -> B;
        otherwise -> Fine;
    }
    state B { prompt: "."; otherwise -> A; }
    final state Fine {}
}`, (state) => (state === 'A' ? { x: 1 } : {}));

  // A viene visitato due volte tramite B, alla terza il fuel scatta.
  check(
    'le visite si contano su tutta la corsa, anche passando da altri stati',
    o.trail.join(' -> ') === 'A -> B -> A -> B -> A -> Fine',
    o.trail.join(' -> '),
  );
}

// =====================================================================
// Transizioni
// =====================================================================

section("Transizioni — valutate in ordine, vince la prima vera, altrimenti 'otherwise'");
{
  const o = await run(`
machine Guardie {
    locations { agent n: Nat[0..9]; }
    initial state Scegli {
        writes n;
        prompt: ".";
        on n > 1 -> Alta;
        on n > 3 -> MaiPresa;
        otherwise -> Bassa;
    }
    state Alta { prompt: "."; otherwise -> Fine; }
    state Bassa { prompt: "."; otherwise -> Fine; }
    state MaiPresa { prompt: "."; otherwise -> Fine; }
    final state Fine {}
}`, () => ({ n: 5 }));
  check(
    'con due guardie vere vince quella scritta prima',
    o.trail[1] === 'Alta',
    o.trail.join(' -> '),
  );

  const o2 = await run(`
machine Fallback {
    locations { agent n: Nat[0..9]; }
    initial state Scegli {
        writes n;
        prompt: ".";
        on n > 3 -> Alta;
        otherwise -> Bassa;
    }
    state Alta { prompt: "."; otherwise -> Fine; }
    state Bassa { prompt: "."; otherwise -> Fine; }
    final state Fine {}
}`, () => ({ n: 1 }));
  check("con nessuna guardia vera si prende 'otherwise'", o2.trail[1] === 'Bassa', o2.trail.join(' -> '));

  const d = await diagnose(`
machine GuardiaNonBool {
    locations { agent n: Nat[0..9]; }
    initial state A { writes n; prompt: "."; on n + 1 -> Fine; otherwise -> Fine; }
    final state Fine {}
}`);
  check('una guardia non booleana e\' un errore', has(d.errors, 'guardia deve essere Bool'), d.errors.join(' | '));
}

// =====================================================================
// Espressioni
// =====================================================================

section('Espressioni — precedenza, associatività, corto circuito');
{
  const o = await run(`
machine Calcolo {
    locations {
        agent tick: Text;
        somma: Int[-99..99] = 0;
        prodotto: Int[-99..99] = 0;
        sottrazione: Int[-99..99] = 0;
        divisione: Int[-99..99] = 0;
        resto: Int[-99..99] = 0;
        negativo: Int[-99..99] = 0;
        divZero: Int[-99..99] = 0;
    }
    initial state Uno {
        writes tick;
        prompt: ".";
        set somma = 2 + 3 * 4;
        set prodotto = (2 + 3) * 4;
        set sottrazione = 10 - 3 - 2;
        set divisione = 7 / 2;
        set resto = 7 % 2;
        set negativo = 0 - 9;
        set divZero = 5 / 0;
        otherwise -> Fine;
    }
    final state Fine {}
}`, () => ({ tick: '.' }));

  check('la moltiplicazione lega piu\' della somma', o.store.somma === 14, String(o.store.somma));
  check('le parentesi cambiano la precedenza', o.store.prodotto === 20, String(o.store.prodotto));
  check("la sottrazione e' associativa a sinistra", o.store.sottrazione === 5, String(o.store.sottrazione));
  check("la divisione e' intera e tronca verso zero", o.store.divisione === 3, String(o.store.divisione));
  check('il modulo funziona', o.store.resto === 1, String(o.store.resto));
  check('un Int puo\' essere negativo', o.store.negativo === -9, String(o.store.negativo));
  check(
    'la divisione per zero viene segnalata invece di valere zero in silenzio',
    o.events.some((e) => e.type === 'notice' && e.message.toLowerCase().includes('divisione per zero')),
    o.events.filter((e) => e.type === 'notice').map((e) => (e.type === 'notice' ? e.message : '')).join(' | ') || 'nessun avviso',
  );
}

section('Espressioni — booleani e confronti');
{
  const o = await run(`
machine Logica {
    locations {
        agent flag: Bool;
        agent s: { rosso, blu };
        andOr: Bool = false;
        negato: Bool = false;
        precedenza: Bool = false;
        testo: Bool = false;
        enumEq: Bool = false;
    }
    initial state Uno {
        writes flag, s;
        prompt: ".";
        otherwise -> Due;
    }
    state Due {
        prompt: ".";
        set andOr = flag and not flag;
        set negato = not flag;
        set precedenza = not flag or flag;
        set testo = "a" != "b";
        set enumEq = s == #blu;
        otherwise -> Fine;
    }
    final state Fine {}
}`, (state) => (state === 'Uno' ? { flag: true, s: 'blu' } : {}));

  check("'and' con un operando falso da' falso", o.store.andOr === false);
  check("'not' inverte", o.store.negato === false);
  check("'not' lega piu' di 'or'", o.store.precedenza === true);
  check('due testi diversi si confrontano', o.store.testo === true);
  check('un enum si confronta con il suo letterale', o.store.enumEq === true);
}

section('Espressioni — le guardie leggono i campi dei record');
{
  const o = await run(`
machine Campi {
    locations { agent t: record { tot: Nat[0..9], ko: Nat[0..9] }; }
    initial state Uno {
        writes t;
        prompt: ".";
        on t.ko == 0 -> Passa;
        otherwise -> Fallisce;
    }
    state Passa { prompt: "."; otherwise -> Fine; }
    state Fallisce { prompt: "."; otherwise -> Fine; }
    final state Fine {}
}`, () => ({ t: { tot: 5, ko: 0 } }));
  check('una guardia su un campo di record decide la strada', o.trail[1] === 'Passa', o.trail.join(' -> '));

  const d = await diagnose(`
machine CampoAssente {
    locations { agent t: record { a: Nat }; }
    initial state Uno { writes t; prompt: "."; on t.b == 1 -> Fine; otherwise -> Fine; }
    final state Fine {}
}`);
  check(
    'un campo inesistente e\' un errore di compilazione',
    has(d.errors, "non e' un campo valido"),
    d.errors.join(' | '),
  );
}

// =====================================================================
// Tipo File
// =====================================================================

section("Tipo File — un percorso, non un testo qualunque");
{
  const o = await run(`
machine Percorsi {
    locations {
        agent buono: File;
        agent fuori: File;
        agent assente: File;
    }
    initial state Uno { writes buono, fuori, assente; prompt: "."; otherwise -> Fine; }
    final state Fine {}
}`, () => ({ buono: 'presente.txt', fuori: '../rubato.txt', assente: 'mai-scritto.txt' }), {
    files: { 'presente.txt': 'ciao' },
  });

  const notices = o.events
    .filter((e): e is Extract<RunEvent, { type: 'notice' }> => e.type === 'notice')
    .map((e) => e.message);

  check('un percorso valido dentro il workspace passa senza rumore', o.store.buono === 'presente.txt', String(o.store.buono));
  check(
    "un percorso che esce dal workspace viene segnalato",
    notices.some((m) => m.includes('fuori') && m.toLowerCase().includes('workspace')),
    notices.join(' | ') || 'nessun avviso',
  );
  check(
    'un percorso a un file inesistente viene segnalato',
    notices.some((m) => m.includes('assente')),
    notices.join(' | ') || 'nessun avviso',
  );
}

section('Espressioni — meno unario');
{
  const o = await run(`
machine Meno {
    locations {
        agent tick: Text;
        lett: Int[-9..9] = -4;
        doppio: Int[-9..9] = 0;
        daRef: Int[-9..9] = 0;
        precede: Int[-9..9] = 0;
        conProdotto: Int[-9..9] = 0;
    }
    initial state Uno {
        writes tick;
        prompt: ".";
        set doppio = - -3;
        set daRef = -lett;
        set precede = -2 + 5;
        set conProdotto = -2 * 3;
        otherwise -> Fine;
    }
    final state Fine {}
}`, () => ({ tick: '.' }));

  check('un letterale negativo e\' scrivibile in un init', o.store.lett === -4, String(o.store.lett));
  check('il meno unario si annida', o.store.doppio === 3, String(o.store.doppio));
  check('si applica a una locazione, non solo a un letterale', o.store.daRef === 4, String(o.store.daRef));
  check("lega piu' della somma", o.store.precede === 3, String(o.store.precede));
  check("lega piu' del prodotto", o.store.conProdotto === -6, String(o.store.conProdotto));

  const d = await diagnose(`
machine MenoSuTesto {
    locations { t: Text = "x"; n: Int[-9..9] = 0; }
    initial state Uno { prompt: "."; set n = -t; set t = "y"; otherwise -> Fine; }
    final state Fine {}
}`);
  check(
    'il meno unario su un testo e\' un errore di tipo',
    has(d.errors, 'meno unario richiede un numero'),
    d.errors.join(' | '),
  );

  const d2 = await diagnose(`
machine MenoSuNat {
    locations { agent x: Text; n: Nat[0..9] = 0; }
    initial state Uno { writes x; prompt: "."; set n = -1; otherwise -> Fine; }
    final state Fine {}
}`);
  check(
    'assegnare un negativo a un Nat viene rifiutato a compilazione',
    has(d2.errors, 'estremo inferiore') || has(d2.errors, 'Nat'),
    d2.errors.join(' | '),
  );
}

// =====================================================================

console.log(
  failures === 0
    ? '\n\x1b[32mIl runtime rispetta il metamodello su tutte le primitive verificate.\x1b[0m\n'
    : `\n\x1b[31m${failures} divergenze fra metamodello e implementazione.\x1b[0m\n`,
);
process.exit(failures ? 1 : 0);
