// =====================================================================
// Motore di esecuzione della macchina a stati.
//
// Un passo, dall'ingresso in uno stato alla transizione, e' sempre lo
// stesso:
//
//   1. conta la visita; se supera il 'limit', salta a onExceeded
//      senza interrogare l'LLM (il fuel e' un vincolo strutturale,
//      non un giudizio del modello)
//   2. costruisci il prompt interpolando lo store
//   3. anello agentico: l'LLM lavora nel workspace con i tool
//   4. se lo stato dichiara 'writes', obbliga la chiamata a 'report'
//      e riversa i valori nello store
//   5. esegui le assegnazioni in ordine
//   6. controlla le invarianti
//   7. valuta le guardie in ordine, prima vera vince; altrimenti
//      'otherwise'
//
// Uno stato finale chiude la corsa.
// =====================================================================

import { stat } from 'node:fs/promises';

import type { IRMachine, IRState, IRValue, Store } from '../../shared/ir.js';
import { findType, typeToString } from '../../shared/ir.js';
import type { AskAnswer, AskRequest, ExitReason, RunEvent, RuntimeConfig } from '../../shared/protocol.js';
import { getProvider } from '../llm/index.js';
import type { LlmProvider, Message, ProviderCredentials, ToolCall } from '../llm/types.js';
import { LlmError } from '../llm/types.js';
import type { CoerceIssue } from './evaluator.js';
import {
  collectFilePaths,
  evalExpr,
  initialStore,
  renderValue,
  readPath,
  truthy,
  writePath,
} from './evaluator.js';
import type { Sandbox } from './sandbox.js';
import type { TavilyClient } from '../web/tavily.js';
import {
  buildAskTool,
  buildFileTools,
  buildReportTool,
  buildStoreTools,
  buildWebTools,
  describeAnswer,
  REPORT_TOOL,
  type ToolContext,
  type ToolImpl,
} from './tools.js';

/**
 * Quanto di una locazione entra nel prompt di sistema. Oltre, si
 * abbrevia e si rimanda a 'read_location': il contesto e' finito, ma
 * niente deve restare irraggiungibile.
 */
const INLINE_VALUE_CHARS = 600;

/**
 * Nome fittizio usato per le violazioni rilevate prima del primo
 * stato: non e' uno stato della macchina, ed e' bene che si veda.
 */
const INIT_PSEUDO_STATE = '(init)';

export interface EngineOptions {
  machine: IRMachine;
  sandbox: Sandbox;
  config: RuntimeConfig;
  credentials: ProviderCredentials;
  emit(event: RunEvent): void;
  /** iniettabile nei test: se assente si usa il registro dei provider */
  provider?: LlmProvider;
  /** presente solo se c'e' una chiave e il progetto abilita il web */
  web?: TavilyClient;
  /**
   * Come si raggiunge la persona davanti allo schermo. Se assente, il
   * tool 'ask_user' non viene nemmeno offerto: senza interfaccia una
   * domanda resterebbe senza risposta per sempre.
   */
  ask?(request: AskRequest, signal: AbortSignal): Promise<AskAnswer>;
}

export class Engine {
  private readonly store: Store;
  private readonly visits = new Map<string, number>();
  private readonly abort = new AbortController();
  private readonly byName: Map<string, IRState>;
  private readonly agentTools: ToolImpl[];
  private stopped = false;
  private step = 0;
  /** percorsi File scritti dal report, in attesa del controllo */
  private pendingFiles: Array<{ path: string; value: string }> = [];

  constructor(private readonly o: EngineOptions) {
    this.store = initialStore(o.machine.locations);
    this.byName = new Map(o.machine.states.map((s) => [s.name, s]));
    this.agentTools = [
      ...buildFileTools(o.config.allowCommands),
      ...buildStoreTools(o.machine.locations),
      ...(o.web ? buildWebTools() : []),
      ...(o.ask ? [buildAskTool()] : []),
    ];
  }

  get currentStore(): Store {
    return this.store;
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }

  async run(runId: string): Promise<void> {
    const initial = this.o.machine.states.find((s) => s.initial);
    if (!initial) {
      this.o.emit({ type: 'run-finished', at: now(), reason: 'error', error: 'Nessuno stato iniziale.' });
      return;
    }

    this.o.emit({ type: 'run-started', runId, at: now(), initial: initial.name, store: clone(this.store) });

    // Un'invariante puo' essere gia' falsa per come sono scritti gli
    // 'init': se non si guarda qui, il modello sembra sano fino alla
    // fine del primo stato.
    this.checkInvariants(INIT_PSEUDO_STATE);

    let current: IRState | undefined = initial;

    try {
      while (current) {
        if (this.stopped) {
          this.o.emit({ type: 'run-finished', at: now(), reason: 'stopped', state: current.name });
          return;
        }
        if (this.step >= this.o.config.maxSteps) {
          this.o.emit({
            type: 'run-finished',
            at: now(),
            reason: 'max-steps',
            state: current.name,
            error: `Raggiunto il tetto di ${this.o.config.maxSteps} passi.`,
          });
          return;
        }

        this.step++;
        const visit = (this.visits.get(current.name) ?? 0) + 1;
        this.visits.set(current.name, visit);
        this.o.emit({ type: 'state-entered', at: now(), state: current.name, visit, step: this.step });

        if (current.final) {
          this.o.emit({ type: 'run-finished', at: now(), reason: 'final', state: current.name });
          return;
        }

        const next = await this.runState(current, visit);
        if (!next) return; // gia' terminata o interrotta
        current = this.byName.get(next);
        if (!current) {
          this.o.emit({
            type: 'run-finished',
            at: now(),
            reason: 'error',
            error: `Transizione verso uno stato inesistente: '${next}'.`,
          });
          return;
        }
      }
    } catch (err) {
      if (this.stopped || (err as Error).name === 'AbortError') {
        this.o.emit({ type: 'run-finished', at: now(), reason: 'stopped', state: current?.name });
        return;
      }
      this.o.emit({
        type: 'run-finished',
        at: now(),
        reason: 'error',
        state: current?.name,
        error: (err as Error).message,
      });
    }
  }

  // ------------------------------------------------------------ un passo

  private async runState(state: IRState, visit: number): Promise<string | undefined> {
    // 1. fuel
    if (state.limit && visit > state.limit.maxVisits) {
      this.o.emit({
        type: 'notice',
        at: now(),
        state: state.name,
        level: 'warning',
        message: `Visita ${visit} oltre il limite di ${state.limit.maxVisits}: si passa a '${state.limit.onExceeded}'.`,
      });
      this.o.emit({
        type: 'transition',
        at: now(),
        from: state.name,
        to: state.limit.onExceeded,
        reason: 'limit',
      });
      return state.limit.onExceeded;
    }

    // 2. prompt
    const prompt = this.buildPrompt(state);
    this.o.emit({ type: 'prompt-built', at: now(), state: state.name, prompt });

    // 3-4. anello agentico
    await this.converse(state, prompt);
    if (this.stopped) {
      this.o.emit({ type: 'run-finished', at: now(), reason: 'stopped', state: state.name });
      return undefined;
    }

    // 5. assegnazioni
    const touchedFiles: Array<{ path: string; value: string }> = [];
    for (const a of state.assignments) {
      const value = evalExpr(a.value, this.store, (m) =>
        this.notice(state.name, 'warning', `${a.source}: ${m}`),
      );
      const outcome = writePath(
        this.store,
        this.o.machine.locations,
        a.target.location,
        a.target.path,
        value,
      );
      this.reportCoercions(state.name, outcome.issues);
      this.o.emit({
        type: 'assignment',
        at: now(),
        state: state.name,
        source: a.source,
        value: readPath(this.store, a.target.location, a.target.path),
      });
      this.collectFiles(a.target.location, a.target.path, touchedFiles);
    }
    this.o.emit({ type: 'store-changed', at: now(), store: clone(this.store) });

    // 5b. i percorsi di tipo File devono essere percorsi veri
    await this.auditFiles(state.name, [...this.pendingFiles, ...touchedFiles]);
    this.pendingFiles = [];

    // 6. invarianti
    this.checkInvariants(state.name);

    // 7. guardie
    for (const t of state.transitions) {
      const value = evalExpr(t.guard, this.store, (m) =>
        this.notice(state.name, 'warning', `guardia '${t.source}': ${m}`),
      );
      if (truthy(value)) {
        this.emitTransition(state.name, t.target, 'guard', t.source);
        return t.target;
      }
    }
    if (state.fallback) {
      this.emitTransition(state.name, state.fallback, 'otherwise');
      return state.fallback;
    }

    this.o.emit({
      type: 'run-finished',
      at: now(),
      reason: 'error',
      state: state.name,
      error: `Lo stato '${state.name}' non ha nessuna uscita percorribile.`,
    });
    return undefined;
  }

  private emitTransition(from: string, to: string, reason: ExitReason, guard?: string): void {
    this.o.emit({ type: 'transition', at: now(), from, to, reason, guard });
  }

  private notice(state: string | undefined, level: 'info' | 'warning' | 'error', message: string): void {
    this.o.emit({ type: 'notice', at: now(), state, level, message });
  }

  /**
   * Le correzioni applicate per far rientrare un valore nel tipo.
   * Nessuna passa sotto silenzio: un numero riportato nei bound o un
   * letterale enum sostituito cambiano il comportamento delle guardie.
   */
  private reportCoercions(state: string, issues: CoerceIssue[]): void {
    for (const issue of issues) {
      if (issue.kind === 'clamped') {
        this.o.emit({
          type: 'bounds-clamped',
          at: now(),
          state,
          location: issue.path,
          from: issue.from,
          to: issue.to,
        });
      } else {
        this.notice(
          state,
          'warning',
          `${issue.path}: '${issue.got}' non appartiene al dominio { ${issue.domain.join(', ')} }, sostituito con '${issue.used}'.`,
        );
      }
    }
  }

  private checkInvariants(state: string): void {
    for (const inv of this.o.machine.invariants) {
      const value = evalExpr(inv.condition, this.store, (m) =>
        this.notice(state, 'warning', `invariante '${inv.name ?? inv.source}': ${m}`),
      );
      if (!truthy(value)) {
        this.o.emit({
          type: 'invariant-violated',
          at: now(),
          state,
          name: inv.name ?? '(anonima)',
          source: inv.source,
        });
      }
    }
  }

  private collectFiles(
    location: string,
    path: string[],
    out: Array<{ path: string; value: string }>,
  ): void {
    const loc = this.o.machine.locations.find((l) => l.name === location);
    if (!loc) return;
    const type = findType(loc, path);
    if (!type) return;
    collectFilePaths(type, readPath(this.store, location, path), [location, ...path].join('.'), out);
  }

  /**
   * Un valore di tipo File dichiara un percorso, non un testo
   * qualunque. Il runtime non lo corregge — il valore resta quello che
   * il modello ha riportato — ma dice se punta fuori dal workspace o a
   * un file che non esiste, perche' una guardia costruita su un
   * percorso sbagliato porta la macchina dalla parte sbagliata.
   */
  private async auditFiles(state: string, files: Array<{ path: string; value: string }>): Promise<void> {
    for (const f of files) {
      try {
        const abs = await this.o.sandbox.resolve(f.value);
        await stat(abs);
      } catch (err) {
        const name = (err as Error).name;
        const message =
          name === 'SandboxViolation'
            ? `${f.path}: il percorso '${f.value}' esce dal workspace.`
            : `${f.path}: il file '${f.value}' non esiste nel workspace.`;
        this.notice(state, 'warning', message);
      }
    }
  }

  // ------------------------------------------------------- anello con LLM

  private async converse(state: IRState, prompt: string): Promise<void> {
    const provider = this.o.provider ?? getProvider(this.o.config.provider);
    const writes = state.writes
      .map((w) => this.o.machine.locations.find((l) => l.name === w))
      .filter((l): l is NonNullable<typeof l> => !!l);

    const reportTool = writes.length ? buildReportTool(writes) : undefined;
    const toolSpecs = [...this.agentTools.map((t) => t.spec), ...(reportTool ? [reportTool] : [])];
    const system = await this.buildSystemPrompt(state, writes.length > 0);

    const messages: Message[] = [{ role: 'user', content: prompt }];
    let iteration = 0;
    let reported = false;

    while (iteration < this.o.config.maxToolIterations) {
      iteration++;
      const lastRound = iteration === this.o.config.maxToolIterations;

      const res = await provider.chat(
        {
          system,
          messages,
          tools: toolSpecs,
          // all'ultimo giro si obbliga il report, altrimenti lo stato
          // finirebbe senza aver prodotto i valori che ha dichiarato
          forceTool: reportTool && lastRound ? REPORT_TOOL : undefined,
          model: this.o.config.model,
          temperature: this.o.config.temperature,
          maxTokens: this.o.config.maxTokens,
          signal: this.abort.signal,
          onDelta: (text) => this.o.emit({ type: 'llm-delta', at: now(), state: state.name, text }),
          onNotice: (message) => this.notice(state.name, 'info', message),
        },
        this.o.credentials,
      );

      if (res.text.trim()) {
        this.o.emit({ type: 'llm-message', at: now(), state: state.name, text: res.text });
      }

      if (!res.toolCalls.length) {
        // Nessun tool e nessun report ancora: lo si sollecita una volta.
        if (reportTool && !reported) {
          messages.push({ role: 'assistant', content: res.text, toolCalls: [] });
          messages.push({
            role: 'user',
            content: `Chiama ora il tool '${REPORT_TOOL}' con i valori richiesti per chiudere lo stato.`,
          });
          continue;
        }
        messages.push({ role: 'assistant', content: res.text, toolCalls: [] });
        return;
      }

      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });

      const reportCall = res.toolCalls.find((c) => c.name === REPORT_TOOL);
      const otherCalls = res.toolCalls.filter((c) => c.name !== REPORT_TOOL);

      for (const call of otherCalls) {
        if (this.stopped) return;
        const result = await this.invokeTool(state, call);
        messages.push({ role: 'tool', callId: call.id, name: call.name, content: result.content, isError: !result.ok });
      }

      if (reportCall) {
        this.o.emit({
          type: 'tool-call',
          at: now(),
          state: state.name,
          id: reportCall.id,
          tool: REPORT_TOOL,
          input: reportCall.input,
        });
        this.commitWrites(state, reportCall.input);
        reported = true;
        return;
      }

      if (!otherCalls.length) return;
    }

    if (reportTool && !reported) {
      this.o.emit({
        type: 'notice',
        at: now(),
        state: state.name,
        level: 'warning',
        message: `Lo stato ha esaurito ${this.o.config.maxToolIterations} iterazioni senza chiamare '${REPORT_TOOL}': le locazioni in 'writes' restano al valore precedente.`,
      });
    }
  }

  private toolContext(state: IRState): ToolContext {
    return {
      sandbox: this.o.sandbox,
      web: this.o.web,
      signal: this.abort.signal,
      askUser: this.o.ask
        ? async (request) => {
            const full: AskRequest = { ...request, id: newAskId(), state: state.name };
            this.o.emit({ type: 'ask-requested', at: now(), state: state.name, request: full });
            try {
              const answer = await this.o.ask!(full, this.abort.signal);
              this.o.emit({
                type: 'ask-answered',
                at: now(),
                state: state.name,
                id: full.id,
                summary: describeAnswer(answer),
                skipped: !!answer.skipped,
              });
              return answer;
            } catch (err) {
              // Interruzione mentre si aspettava: la domanda va comunque
              // chiusa, altrimenti il pannello resta appeso.
              this.o.emit({
                type: 'ask-answered',
                at: now(),
                state: state.name,
                id: full.id,
                summary: 'Domanda annullata.',
                skipped: true,
              });
              throw err;
            }
          }
        : undefined,
      // Lettura di qualunque locazione. Il perimetro di scrittura non
      // c'entra: quello vale solo per 'report'.
      readLocation: (name, path) => {
        const loc = this.o.machine.locations.find((l) => l.name === name);
        if (!loc) return undefined;
        if (path.length && findType(loc, path) === undefined) return undefined;
        return readPath(this.store, name, path);
      },
    };
  }

  private async invokeTool(state: IRState, call: ToolCall): Promise<{ ok: boolean; content: string }> {
    this.o.emit({
      type: 'tool-call',
      at: now(),
      state: state.name,
      id: call.id,
      tool: call.name,
      input: call.input,
    });

    const impl = this.agentTools.find((t) => t.spec.name === call.name);
    if (!impl) {
      const msg = `Tool sconosciuto: '${call.name}'.`;
      this.o.emit({
        type: 'tool-result',
        at: now(),
        state: state.name,
        id: call.id,
        tool: call.name,
        ok: false,
        summary: msg,
      });
      return { ok: false, content: msg };
    }

    try {
      const out = await impl.run(call.input, this.toolContext(state));
      this.o.emit({
        type: 'tool-result',
        at: now(),
        state: state.name,
        id: call.id,
        tool: call.name,
        ok: true,
        summary: firstLine(out),
      });
      return { ok: true, content: out };
    } catch (err) {
      const msg = (err as Error).message;
      this.o.emit({
        type: 'tool-result',
        at: now(),
        state: state.name,
        id: call.id,
        tool: call.name,
        ok: false,
        summary: msg,
      });
      return { ok: false, content: `Errore: ${msg}` };
    }
  }

  /**
   * Riversa nello store i valori che il modello ha riportato.
   *
   * Il perimetro e' controllato tre volte, e non e' ridondanza inutile:
   * lo schema di 'report' contiene solo le locazioni di 'writes', il
   * validatore ha gia' rifiutato un 'writes' che punta a una locazione
   * non 'agent', e qui si ricontrolla comunque. I provider non sempre
   * fanno rispettare additionalProperties, quindi l'ultima parola deve
   * restare al runtime: una locazione assegnabile la scrive solo un
   * 'set', mai il modello.
   */
  private commitWrites(state: IRState, input: Record<string, unknown>): void {
    const committed: Record<string, IRValue> = {};

    for (const name of Object.keys(input)) {
      if (state.writes.includes(name)) continue;
      const known = this.o.machine.locations.find((l) => l.name === name);
      const reason = !known
        ? `'${name}' non e' una locazione di questa macchina.`
        : !known.agentOwned
          ? `'${name}' non e' marcata 'agent': la puo' scrivere solo un 'set'.`
          : `'${name}' non compare nel 'writes' di '${state.name}'.`;
      this.o.emit({ type: 'write-rejected', at: now(), state: state.name, location: name, reason });
    }

    for (const name of state.writes) {
      const loc = this.o.machine.locations.find((l) => l.name === name);
      if (!loc || !loc.agentOwned) {
        this.o.emit({
          type: 'write-rejected',
          at: now(),
          state: state.name,
          location: name,
          reason: loc
            ? `'${name}' non e' marcata 'agent': il modello non puo' scriverla.`
            : `'${name}' non esiste fra le locazioni della macchina.`,
        });
        continue;
      }
      if (!(name in input)) {
        this.o.emit({
          type: 'notice',
          at: now(),
          state: state.name,
          level: 'warning',
          message: `Il report non contiene '${name}': la locazione resta al valore precedente.`,
        });
        continue;
      }
      const outcome = writePath(this.store, this.o.machine.locations, name, [], input[name] as IRValue);
      this.reportCoercions(state.name, outcome.issues);
      this.collectFiles(name, [], this.pendingFiles);
      committed[name] = this.store[name];
    }
    this.o.emit({ type: 'writes-committed', at: now(), state: state.name, values: committed });
    this.o.emit({ type: 'store-changed', at: now(), store: clone(this.store) });
  }

  // ------------------------------------------------------------- prompt

  private buildPrompt(state: IRState): string {
    let out = '';
    for (const part of state.prompt) {
      out += part.t === 'text' ? part.value : renderValue(readPath(this.store, part.location, part.path));
    }
    return out;
  }

  private async buildSystemPrompt(state: IRState, hasWrites: boolean): Promise<string> {
    const m = this.o.machine;
    const lines: string[] = [];

    lines.push(
      `Sei l'agente di codice di Orcrist. La tua condotta e' descritta da una macchina a stati chiamata '${m.name}';`,
      `in questo momento stai eseguendo lo stato '${state.name}' (visita ${this.visits.get(state.name) ?? 1}).`,
      '',
      `Workspace: ${this.o.sandbox.root}`,
      "Puoi leggere e modificare solo file dentro questa cartella. Ogni percorso fuori dal workspace viene rifiutato.",
      '',
      'Struttura attuale del workspace:',
      await this.o.sandbox.tree(120).catch(() => '(non leggibile)'),
      '',
    );

    if (this.o.ask) {
      lines.push(
        "C'e' una persona che sta guardando l'esecuzione, e con 'ask_user' puoi rivolgerle una domanda:",
        'la macchina resta ferma finche\' non risponde. Usalo per le decisioni che non spettano a te e per',
        'le informazioni che non trovi altrove — non per chiedere il permesso di proseguire. Quando le',
        'alternative sono note, proponile invece di lasciare la domanda aperta.',
        '',
      );
    }

    if (this.o.web) {
      lines.push(
        "Hai accesso al web con 'web_search' e 'fetch_url'. Usali quando la risposta non e' nel workspace",
        'e quando conta che sia aggiornata — versioni di librerie, messaggi di errore, documentazione.',
        'Cita l\'URL da cui hai preso un\'informazione quando la riporti.',
        '',
      );
    }

    // Lo stato globale si presenta diviso per proprieta': la
    // distinzione fra cio' che il modello puo' scrivere e cio' che
    // puo' solo leggere e' il vincolo piu' importante da comunicare.
    if (m.locations.length) {
      const writable = m.locations.filter((l) => l.agentOwned);
      const readOnly = m.locations.filter((l) => !l.agentOwned);
      const describe = (loc: (typeof m.locations)[number]): string => {
        const value = renderValue(this.store[loc.name] ?? '');
        // Qui si abbrevia per non riempire il contesto; il valore
        // intero resta raggiungibile con 'read_location', e lo si dice
        // proprio dove il taglio avviene.
        const shown =
          value.length > INLINE_VALUE_CHARS
            ? `${value.slice(0, INLINE_VALUE_CHARS).replace(/\n/g, ' ')}…  [abbreviata: ${value.length} caratteri in tutto, usa read_location per leggerla intera]`
            : value.replace(/\n/g, ' ');
        return `  ${loc.name}: ${typeToString(loc.type)} = ${shown}`;
      };

      lines.push(
        'STATO GLOBALE DELLA MACCHINA',
        '',
        `Puoi LEGGERE tutte e ${m.locations.length} le locazioni, senza eccezioni: quelle qui sotto sono`,
        "tutte, con il valore che hanno adesso. Il tool 'read_location' ne restituisce una per intero,",
        'e funziona su qualunque locazione — anche su quelle che non puoi scrivere.',
        '',
      );

      if (writable.length) {
        lines.push(
          `Puoi anche SCRIVERE queste ${writable.length} (marcate 'agent' nel modello):`,
          ...writable.map(describe),
          '',
          `Le scrivi solo chiamando il tool '${REPORT_TOOL}', e solo quelle che questo stato dichiara in`,
          "'writes'. Non esiste nessun altro modo: non puoi scriverle con un file, con un comando, ne'",
          'annunciandolo nel testo della risposta.',
          '',
        );
      } else {
        lines.push(
          "Non puoi scrivere nessuna locazione: questa macchina non ne dichiara di marcate 'agent'.",
          '',
        );
      }

      if (readOnly.length) {
        lines.push(
          `Queste ${readOnly.length} le puoi leggere ma non scrivere:`,
          ...readOnly.map(describe),
          '',
          "Le calcola il runtime dalle assegnazioni 'set' del modello. Leggile pure e tienine conto —",
          'spesso sono contatori che dicono a che punto e\' la macchina — ma qualunque tentativo di',
          'modificarle viene rifiutato e registrato.',
          '',
        );
      }
    }

    if (hasWrites) {
      const detail = state.writes
        .map((w) => {
          const loc = m.locations.find((l) => l.name === w);
          return `  ${w}: ${loc ? typeToString(loc.type) : '?'}`;
        })
        .join('\n');
      lines.push(
        'COSA DEVE PRODURRE QUESTO STATO',
        '',
        detail,
        '',
        `Fai il lavoro con i tool, poi chiama '${REPORT_TOOL}' una volta sola con tutti questi campi e`,
        'nessun altro. I valori finiscono nello stato globale e li leggono le guardie che decidono dove',
        'va la macchina: riporta quello che risulta davvero dal lavoro fatto, non quello che ti sembra',
        "desiderabile. Se il lavoro non e' riuscito, dillo nei valori — un ramo di recupero esiste apposta.",
      );
    } else {
      lines.push(
        'COSA DEVE PRODURRE QUESTO STATO',
        '',
        "Niente: questo stato non dichiara 'writes' e non puoi scrivere nessuna locazione da qui.",
        'Esegui il compito con i tool e chiudi con un breve resoconto.',
      );
    }

    const exits = [
      ...state.transitions.map((t) => `  se ${t.source} -> ${t.target}`),
      ...(state.limit ? [`  oltre ${state.limit.maxVisits} visite -> ${state.limit.onExceeded}`] : []),
      ...(state.fallback ? [`  altrimenti -> ${state.fallback}`] : []),
    ];
    if (exits.length) {
      lines.push('', 'Uscite di questo stato, valutate in ordine dopo il tuo turno:', ...exits);
    }

    return lines.join('\n');
  }
}

let askCounter = 0;
function newAskId(): string {
  return `ask_${Date.now().toString(36)}_${(askCounter++).toString(36)}`;
}

function now(): number {
  return Date.now();
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function firstLine(s: string): string {
  const line = s.split('\n')[0] ?? '';
  const extra = s.includes('\n') ? ` (+${s.split('\n').length - 1} righe)` : '';
  return line.slice(0, 200) + extra;
}

export { LlmError };
