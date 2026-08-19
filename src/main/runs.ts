// =====================================================================
// Gestione delle corse: una per progetto.
//
// Il main tiene la verita' (snapshot completo) e spinge gli eventi al
// renderer. Cosi' la GUI puo' essere chiusa e riaperta su un progetto
// in esecuzione senza perdere la traccia.
// =====================================================================

import { BrowserWindow, Notification } from 'electron';
import { randomUUID } from 'node:crypto';
import type { IRMachine } from '../shared/ir.js';
import type { AskAnswer, AskRequest, Project, RunEvent, RunSnapshot } from '../shared/protocol.js';
import { emptySnapshot } from '../shared/protocol.js';
import { applyEvent } from '../shared/reduce.js';
import { compileModel } from '../language/compile.js';
import { Engine } from './runtime/engine.js';
import { Sandbox } from './runtime/sandbox.js';
import { credentialsFor } from './store/settings.js';
import { TavilyClient } from './web/tavily.js';
import { askBridge } from './ask-bridge.js';

interface ActiveRun {
  engine: Engine;
  machine: IRMachine;
  snapshot: RunSnapshot;
}

const runs = new Map<string, ActiveRun>();
const snapshots = new Map<string, RunSnapshot>();

export function snapshotFor(projectId: string): RunSnapshot {
  return runs.get(projectId)?.snapshot ?? snapshots.get(projectId) ?? emptySnapshot();
}

export function isRunning(projectId: string): boolean {
  const s = snapshotFor(projectId);
  return s.status === 'running' || s.status === 'stopping';
}

export async function startRun(project: Project): Promise<{ ok: boolean; message?: string }> {
  if (isRunning(project.id)) return { ok: false, message: 'Il progetto e\' gia\' in esecuzione.' };

  const compiled = await compileModel(project.model);
  if (!compiled.ok || !compiled.machine) {
    const first = compiled.diagnostics.find((d) => d.severity === 'error');
    return { ok: false, message: `Il modello non compila: ${first?.message ?? 'errore sconosciuto'}` };
  }

  const credentials = await credentialsFor(project.runtime.provider);
  if (project.runtime.provider !== 'local' && !credentials.apiKey) {
    return { ok: false, message: `Nessuna chiave API configurata per ${project.runtime.provider}.` };
  }

  // I tool web esistono solo se il progetto li vuole e c'e' una chiave:
  // altrimenti l'agente non li vede nemmeno nell'elenco.
  let web: TavilyClient | undefined;
  if (project.runtime.allowWebSearch) {
    const tavily = await credentialsFor('tavily');
    if (tavily.apiKey) web = new TavilyClient(tavily.apiKey, tavily.baseUrl);
  }

  const runId = randomUUID();
  const snapshot: RunSnapshot = {
    ...emptySnapshot(),
    runId,
    status: 'running',
  };

  const sandbox = new Sandbox(project.workspace);
  const engine = new Engine({
    ask: (request, signal) => askBridge.ask(project.id, request, signal),
    machine: compiled.machine,
    sandbox,
    config: project.runtime,
    credentials,
    web,
    emit: (event) => {
      applyEvent(snapshot, event);
      broadcast(project.id, event);
      if (event.type === 'ask-requested') notifyQuestion(project, event.request);
      if (event.type === 'run-finished') {
        // Se la corsa finisce mentre una domanda pende — errore, tetto
        // di passi — nessuno rispondera' piu': meglio liberare subito.
        askBridge.cancel(project.id);
        runs.delete(project.id);
        snapshots.set(project.id, snapshot);
        notifyFinished(project, event);
      }
    },
  });

  runs.set(project.id, { engine, machine: compiled.machine, snapshot });
  snapshots.set(project.id, snapshot);

  // fire-and-forget: gli eventi raccontano il resto
  void engine.run(runId);
  return { ok: true };
}

export function stopRun(projectId: string): void {
  const run = runs.get(projectId);
  if (!run) return;
  run.snapshot.status = 'stopping';
  run.engine.stop();
}

export function stopAll(): void {
  for (const id of [...runs.keys()]) stopRun(id);
}

/** Chiamata dal renderer quando la persona risponde. */
export function answerAsk(projectId: string, answer: AskAnswer): void {
  askBridge.answer(projectId, answer);
}

/** C'e' una domanda in attesa per questo progetto? */
export function isAwaitingAnswer(projectId: string): boolean {
  return askBridge.isWaiting(projectId);
}

// --------------------------------------------------------------- eventi

function broadcast(projectId: string, event: RunEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('run:event', projectId, event);
  }
}

/**
 * Una domanda ferma la macchina: se la finestra non e' in primo piano
 * la persona non ha modo di accorgersene, e la corsa resterebbe li'.
 */
function notifyQuestion(project: Project, request: AskRequest): void {
  const focused = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());
  if (focused || !Notification.isSupported()) return;

  const n = new Notification({
    title: `Orcrist — ${project.name} attende una risposta`,
    body: request.question.slice(0, 160),
  });
  n.on('click', () => focusProject(project.id));
  n.show();
}

function focusProject(projectId: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  win.webContents.send('run:focus-project', projectId);
}

function notifyFinished(project: Project, event: Extract<RunEvent, { type: 'run-finished' }>): void {
  if (!Notification.isSupported()) return;

  const bodyByReason: Record<string, string> = {
    final: `Stato finale raggiunto: ${event.state ?? '?'}.`,
    stopped: 'Esecuzione interrotta.',
    'max-steps': event.error ?? 'Tetto di passi raggiunto.',
    error: event.error ?? 'Errore durante l\'esecuzione.',
  };

  const n = new Notification({
    title: `Orcrist — ${project.name}`,
    body: bodyByReason[event.reason] ?? 'Esecuzione conclusa.',
    urgency: event.reason === 'error' ? 'critical' : 'normal',
  });
  n.on('click', () => focusProject(project.id));
  n.show();
}
