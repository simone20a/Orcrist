// =====================================================================
// Contratto fra main e renderer: progetti, impostazioni, eventi di run.
// Tutto quello che passa da qui deve essere JSON puro.
// =====================================================================

import type { CompileResult, IRMachine, IRValue, Store } from './ir.js';

// --- Progetti ---------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  /** cartella oltre la quale l'LLM non puo' leggere ne' scrivere */
  workspace: string;
  /** testo del modello .orc */
  model: string;
  /** percorso del .orc se importato da file, per riaprirlo */
  modelPath?: string;
  createdAt: string;
  updatedAt: string;
  runtime: RuntimeConfig;
  /**
   * Posizioni dei nodi trascinati a mano nel grafo, per nome di stato.
   * Gli stati assenti seguono il layout automatico; svuotare la mappa
   * riporta tutto al layout calcolato.
   */
  layout?: Record<string, { x: number; y: number }>;
}

export interface RuntimeConfig {
  provider: ProviderId;
  model: string;
  /**
   * Assente = si lascia decidere al provider. Serve che sia
   * facoltativa e non "zero": i modelli Anthropic recenti rifiutano
   * la richiesta se il campo compare, qualunque valore abbia.
   */
  temperature?: number;
  maxTokens: number;
  /** iterazioni massime dell'anello di tool per singolo stato */
  maxToolIterations: number;
  /** passi massimi della macchina, salvagente contro i cicli non limitati */
  maxSteps: number;
  /** consente il tool run_command dentro il workspace */
  allowCommands: boolean;
  /** consente web_search e fetch_url; serve comunque una chiave Tavily */
  allowWebSearch: boolean;
}

export const DEFAULT_RUNTIME: RuntimeConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  temperature: undefined,
  maxTokens: 4096,
  maxToolIterations: 12,
  maxSteps: 200,
  allowCommands: false,
  allowWebSearch: true,
};

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'local';

/** Tutto cio' per cui Orcrist custodisce una chiave, LLM o no. */
export type CredentialId = ProviderId | 'tavily';

export interface ProviderInfo {
  id: CredentialId;
  label: string;
  /** false per i modelli locali, che di solito non chiedono chiave */
  needsKey: boolean;
  /** endpoint modificabile: usato solo da 'local' */
  configurableBaseUrl: boolean;
  defaultBaseUrl: string;
  suggestedModels: string[];
  keyHint: string;
}

/** Solo i provider LLM: la ricerca web sta a parte, in WEB_SEARCH. */
export const PROVIDERS: Array<ProviderInfo & { id: ProviderId }> = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    needsKey: true,
    configurableBaseUrl: false,
    defaultBaseUrl: 'https://api.anthropic.com',
    suggestedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    keyHint: 'sk-ant-…',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    needsKey: true,
    configurableBaseUrl: false,
    defaultBaseUrl: 'https://api.openai.com',
    suggestedModels: ['gpt-4.1', 'gpt-4o', 'o4-mini'],
    keyHint: 'sk-…',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    needsKey: true,
    configurableBaseUrl: false,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    keyHint: 'AIza…',
  },
  {
    id: 'local',
    label: 'Locale (OpenAI-compatibile)',
    needsKey: false,
    configurableBaseUrl: true,
    defaultBaseUrl: 'http://localhost:11434/v1',
    suggestedModels: ['qwen2.5-coder', 'llama3.1', 'devstral'],
    keyHint: 'facoltativa',
  },
];

export interface ProviderSettings {
  /** presenza della chiave, mai la chiave in chiaro verso il renderer */
  hasKey: boolean;
  baseUrl?: string;
}

export type SettingsView = Record<CredentialId, ProviderSettings>;

/**
 * La ricerca web non e' un provider LLM ma ha le stesse esigenze —
 * una chiave, un endpoint, una prova di funzionamento — quindi
 * riusa la stessa forma.
 */
export const WEB_SEARCH: ProviderInfo = {
  id: 'tavily',
  label: 'Tavily (ricerca web)',
  needsKey: true,
  configurableBaseUrl: false,
  defaultBaseUrl: 'https://api.tavily.com',
  suggestedModels: ['search'],
  keyHint: 'tvly-…',
};

/**
 * Scelte che vale la pena ricordare da un progetto al successivo, cosi'
 * che chi ha gia' configurato una chiave non debba ripetere la stessa
 * selezione ogni volta.
 */
export interface Preferences {
  lastProvider?: ProviderId;
  lastModel?: string;
  lastWorkspace?: string;
}

// --- Domande all'utente -----------------------------------------------

/**
 * Una domanda che l'agente pone alla persona davanti allo schermo.
 * La forma la sceglie il modello: aperta quando serve testo libero,
 * chiusa quando le alternative sono note e conviene non lasciare
 * spazio all'ambiguita'.
 */
export interface AskRequest {
  id: string;
  /** stato della macchina da cui parte la domanda */
  state: string;
  question: string;
  kind: 'open' | 'single' | 'multi';
  /** alternative, obbligatorie per 'single' e 'multi' */
  options?: string[];
  /** suggerimento nel campo di testo, per le domande aperte */
  placeholder?: string;
  /** per le chiuse: consente anche una risposta fuori elenco */
  allowFreeText?: boolean;
  /** contesto facoltativo, mostrato sotto la domanda */
  detail?: string;
}

export interface AskAnswer {
  id: string;
  /** vero se la persona ha scelto di non rispondere */
  skipped?: boolean;
  /** testo libero: domanda aperta, oppure alternativa fuori elenco */
  text?: string;
  /** alternative scelte, per 'single' e 'multi' */
  selected?: string[];
}

// --- Eventi di esecuzione ---------------------------------------------

export type ExitReason = 'guard' | 'limit' | 'otherwise';

export type RunEvent =
  | { type: 'run-started'; runId: string; at: number; initial: string; store: Store }
  | { type: 'state-entered'; at: number; state: string; visit: number; step: number }
  | { type: 'prompt-built'; at: number; state: string; prompt: string }
  | { type: 'llm-delta'; at: number; state: string; text: string }
  | { type: 'llm-message'; at: number; state: string; text: string }
  | { type: 'tool-call'; at: number; state: string; id: string; tool: string; input: unknown }
  | { type: 'tool-result'; at: number; state: string; id: string; tool: string; ok: boolean; summary: string }
  | { type: 'writes-committed'; at: number; state: string; values: Record<string, IRValue> }
  | { type: 'write-rejected'; at: number; state: string; location: string; reason: string }
  | { type: 'assignment'; at: number; state: string; source: string; value: IRValue }
  | { type: 'store-changed'; at: number; store: Store }
  | { type: 'bounds-clamped'; at: number; state: string; location: string; from: number; to: number }
  | { type: 'invariant-violated'; at: number; state: string; name: string; source: string }
  | { type: 'transition'; at: number; from: string; to: string; reason: ExitReason; guard?: string }
  | { type: 'ask-requested'; at: number; state: string; request: AskRequest }
  | { type: 'ask-answered'; at: number; state: string; id: string; summary: string; skipped: boolean }
  | { type: 'notice'; at: number; state?: string; level: 'info' | 'warning' | 'error'; message: string }
  | {
      type: 'run-finished';
      at: number;
      reason: 'final' | 'stopped' | 'error' | 'max-steps';
      state?: string;
      error?: string;
    };

// --- Traccia accumulata (ciò che la GUI mostra cliccando su uno stato) --

/**
 * Registro cronologico di cio' che succede dentro una visita: le
 * chiamate ai tool e le scritture sulle locazioni, nell'ordine in cui
 * sono avvenute. E' quello che il pannello di dettaglio mostra.
 *
 * 'by' distingue chi ha scritto: 'agent' se il valore arriva dal
 * modello via 'report', 'set' se lo ha calcolato il runtime da
 * un'assegnazione del modello Orcrist.
 */
export type ActivityItem =
  | { kind: 'tool'; at: number; id: string; tool: string; input: unknown; ok?: boolean; summary?: string }
  | { kind: 'write'; at: number; by: 'agent' | 'set'; location: string; value: IRValue; source?: string }
  | { kind: 'rejected'; at: number; location: string; reason: string };

export interface VisitRecord {
  index: number;
  startedAt: number;
  endedAt?: number;
  prompt: string;
  /** valori finiti nello store, per locazione */
  writes: Record<string, IRValue>;
  /** tool e scritture in ordine cronologico: e' cio' che la GUI mostra */
  activity: ActivityItem[];
  exit?: { to: string; reason: ExitReason; guard?: string };
  error?: string;
}

export interface StateTrace {
  visits: VisitRecord[];
}

export type RunStatus = 'idle' | 'running' | 'stopping' | 'finished' | 'error';

export interface RunSnapshot {
  runId?: string;
  status: RunStatus;
  currentState?: string;
  store: Store;
  visitCounts: Record<string, number>;
  traces: Record<string, StateTrace>;
  step: number;
  finishedReason?: 'final' | 'stopped' | 'error' | 'max-steps';
  error?: string;
  violations: Array<{ at: number; state: string; name: string; source: string }>;
  /**
   * Domanda in attesa di risposta. Vive nello snapshot e non solo
   * nell'evento, cosi' chi riapre il progetto la ritrova invece di
   * restare davanti a una corsa ferma senza capire perche'.
   */
  pendingAsk?: AskRequest;
}

export function emptySnapshot(): RunSnapshot {
  return {
    status: 'idle',
    store: {},
    visitCounts: {},
    traces: {},
    step: 0,
    violations: [],
  };
}

// --- Superficie IPC esposta dal preload -------------------------------

export interface OrcristApi {
  projects: {
    list(): Promise<Project[]>;
    create(input: NewProjectInput): Promise<Project>;
    update(id: string, patch: Partial<Omit<Project, 'id'>>): Promise<Project>;
    remove(id: string): Promise<void>;
    get(id: string): Promise<Project | undefined>;
  };
  model: {
    compile(text: string): Promise<CompileResult>;
    readFile(path: string): Promise<{ path: string; text: string }>;
  };
  dialog: {
    pickWorkspace(): Promise<string | undefined>;
    pickModelFile(): Promise<{ path: string; text: string } | undefined>;
  };
  settings: {
    read(): Promise<SettingsView>;
    setKey(provider: CredentialId, key: string): Promise<SettingsView>;
    clearKey(provider: CredentialId): Promise<SettingsView>;
    setBaseUrl(provider: CredentialId, baseUrl: string): Promise<SettingsView>;
    test(provider: CredentialId, model: string): Promise<{ ok: boolean; message: string }>;
    readPreferences(): Promise<Preferences>;
    writePreferences(patch: Partial<Preferences>): Promise<Preferences>;
  };
  run: {
    start(projectId: string): Promise<{ ok: boolean; message?: string }>;
    stop(projectId: string): Promise<void>;
    snapshot(projectId: string): Promise<RunSnapshot>;
    answer(projectId: string, answer: AskAnswer): Promise<void>;
    onEvent(cb: (projectId: string, event: RunEvent) => void): () => void;
    /** il click sulla notifica di fine corsa riporta su quel progetto */
    onFocusProject(cb: (projectId: string) => void): () => void;
  };
  shell: {
    openWorkspace(path: string): Promise<void>;
  };
}

export interface NewProjectInput {
  name: string;
  workspace: string;
  model: string;
  modelPath?: string;
  runtime?: Partial<RuntimeConfig>;
}

export type { CompileResult, IRMachine, Store, IRValue };
