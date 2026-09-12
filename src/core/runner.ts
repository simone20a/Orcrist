/**
 * One prompt in a session = one Run: author a machine (or decide there isn't
 * one to author), then execute it, streaming events to the UI as it goes.
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AuthoringFailure, authorMachine } from './authoring';
import { runFreeform, runMachine } from './executor';
import { makeProvider } from './llm';
import type { LanguageAssets } from './paths';
import { executionSystemPrompt } from './prompts';
import type { Storage } from './storage';
import { buildTools } from './tools';
import type { Project, Run, RunEvent, Session, Settings } from './types';

export interface StartRunOptions {
  storage: Storage;
  project: Project;
  session: Session;
  task: string;
  settings: Settings;
  assets?: LanguageAssets;
  /** Earlier user messages in this session, oldest first. */
  history?: string[];
  emit: (runId: string, event: RunEvent) => void;
  onRunChanged: (run: Run) => void;
  onSessionChanged: (session: Session) => void;
}

const active = new Map<string, AbortController>();

/**
 * The runs currently in flight, each holding every event it has emitted.
 *
 * A run is written to disk only at a few points — when it starts, when its
 * machine is approved, when it ends — so the persisted copy of a run still
 * going has almost none of its transcript. The in-memory copy has all of it,
 * and this is where anything reading a run has to look first: open a second
 * session while the first is working, come back to it later, and what you see
 * should be what happened, not what had reached the disk.
 */
const liveRuns = new Map<string, Run>();

/** The in-flight copy of one run, if it is still going. */
export function liveRun(runId: string): Run | undefined {
  return liveRuns.get(runId);
}

/**
 * Every run in flight, with the state it is executing right now.
 *
 * The session list shows this beside the spinner, so leaving a session that is
 * working no longer means losing sight of what it is doing. Folded from the
 * events rather than stored, because the run object is the single copy and this
 * is just a reading of it.
 */
export function liveRunStates(): { runId: string; sessionId: string; state?: string }[] {
  return [...liveRuns.values()].map((run) => {
    let state: string | undefined;
    for (const e of run.events) {
      if (e.kind === 'state-enter') state = e.state;
      else if (e.kind === 'transition') state = e.to;
    }
    return { runId: run.id, sessionId: run.sessionId, state };
  });
}

/**
 * Replaces any run still going with its live copy — and settles the ones that
 * are not.
 *
 * A run is persisted as `running` and updated again when it ends, so a run the
 * app was executing when it closed is still marked `running` on disk with
 * nothing left to execute it. Nothing would ever come along to correct that:
 * the session would open showing a Stop button for a run that died with the
 * process, and no way back to the composer. Anything claiming to be in flight
 * that this process is not in fact flying was interrupted, and is reported as
 * such.
 */
export function withLiveRuns(runs: Run[]): Run[] {
  return runs.map((r) => {
    const live = liveRuns.get(r.id);
    if (live) return live;
    if (r.status !== 'running' && r.status !== 'authoring' && r.status !== 'awaiting-approval') {
      return r;
    }
    return {
      ...r,
      status: 'cancelled' as const,
      events: [
        ...r.events,
        { t: Date.now(), kind: 'error' as const, text: 'Interrupted — the app closed while this run was going.' },
      ],
    };
  });
}

/** Runs parked between "the machine is written" and "the user said go". */
const pendingApproval = new Map<string, (approved: boolean) => void>();

export function cancelRun(runId: string): boolean {
  // A run waiting for approval is cancelled by treating that as a refusal,
  // otherwise Stop would leave it parked forever.
  const waiting = pendingApproval.get(runId);
  if (waiting) waiting(false);
  const c = active.get(runId);
  if (!c) return Boolean(waiting);
  c.abort();
  return true;
}

export function approveRun(runId: string, approved: boolean): boolean {
  const resolve = pendingApproval.get(runId);
  if (!resolve) return false;
  resolve(approved);
  return true;
}

export function isAwaitingApproval(runId: string): boolean {
  return pendingApproval.has(runId);
}

export function isRunActive(runId: string): boolean {
  return active.has(runId);
}

export async function startRun(o: StartRunOptions): Promise<Run> {
  const run: Run = {
    id: randomUUID(),
    sessionId: o.session.id,
    task: o.task,
    status: 'authoring',
    startedAt: new Date().toISOString(),
    events: [],
  };

  const controller = new AbortController();
  active.set(run.id, controller);
  liveRuns.set(run.id, run);

  const emit = (e: RunEvent) => {
    run.events.push(e);
    o.emit(run.id, e);
  };

  const persist = () => {
    o.storage.saveRun(o.project.id, run);
    o.onRunChanged(run);
  };

  persist();

  void (async () => {
    try {
      const tools = buildTools(o.settings);

      // --- 1. authoring ------------------------------------------------
      // The machine belongs to the session, not the run: a later message can
      // keep it, revise it or replace it.
      let machine = o.session.machine;

      if (!o.assets) {
        emit({
          t: Date.now(),
          kind: 'error',
          text:
            'Could not find metamodel/orcrist.langium above the app folder, so no machine can be authored. Running the task directly instead.',
        });
        machine = undefined;
      } else {
        const authoringProvider = makeProvider(o.settings.authoring.provider, o.settings);
        const result = await authorMachine({
          provider: authoringProvider,
          model: o.settings.authoring.model,
          task: o.task,
          assets: o.assets,
          workspaceSummary: summariseWorkspace(o.project.workspace),
          tools: tools.map((t) => t.def.name),
          executionModel: o.settings.execution.model,
          existing:
            o.session.machine && o.session.machineSource
              ? { source: o.session.machineSource, name: o.session.machine.name }
              : undefined,
          history: o.history,
          emit,
          signal: controller.signal,
        });

        if (result.kind === 'no-machine') {
          emit({ t: Date.now(), kind: 'no-model', reason: result.notes });
          run.authoringNotes = result.notes;
          machine = undefined;
        } else if (result.kind === 'keep') {
          emit({
            t: Date.now(),
            kind: 'reuse-model',
            name: o.session.machine!.name,
            reason: result.notes,
          });
          run.authoringNotes = result.notes;
          run.modelSource = o.session.machineSource;
          run.machine = o.session.machine;
        } else {
          machine = result.machine;
          run.modelSource = result.source;
          run.machine = result.machine;
          run.warnings = result.warnings;
          run.authoringNotes = result.notes;

          // The machine decides how the whole run is shaped, so it is worth a
          // look before it runs. Nothing is committed to the session until the
          // user says so: a refused machine leaves the session exactly as it
          // was, rather than half-adopting a process nobody agreed to.
          if (o.settings.requireModelApproval) {
            run.status = 'awaiting-approval';
            emit({
              t: Date.now(),
              kind: 'approval-request',
              name: result.machine!.name,
              revised: Boolean(result.revised),
            });
            persist();

            const approved = await new Promise<boolean>((resolve) => {
              if (controller.signal.aborted) {
                resolve(false);
                return;
              }
              pendingApproval.set(run.id, (v) => {
                pendingApproval.delete(run.id);
                resolve(v);
              });
            });

            emit({ t: Date.now(), kind: 'approval', name: result.machine!.name, approved });
            if (!approved) {
              run.status = 'cancelled';
              emit({
                t: Date.now(),
                kind: 'status',
                text: 'Machine discarded — nothing was executed. Send another message to try a different one.',
              });
              return;
            }
          }

          // the session now works with this machine
          const updated = o.storage.updateSession(o.project.id, o.session.id, {
            machine: result.machine,
            machineSource: result.source,
            machineUpdatedAt: new Date().toISOString(),
          });
          o.session = updated;
          o.onSessionChanged(updated);
        }
      }

      run.status = 'running';
      persist();

      // --- 2. execution -------------------------------------------------
      const execProvider = makeProvider(o.settings.execution.provider, o.settings);
      const systemPrompt = executionSystemPrompt({
        workspace: o.project.workspace,
        machine,
        task: o.task,
        tools: tools.map((t) => ({ name: t.def.name, description: t.def.description })),
      });

      if (machine) {
        emit({
          t: Date.now(),
          kind: 'status',
          text: `Executing machine ${machine.name} — ${machine.states.length} states.`,
        });
        const result = await runMachine({
          machine,
          provider: execProvider,
          model: o.settings.execution.model,
          systemPrompt,
          task: o.task,
          workspace: o.project.workspace,
          tools,
          settings: o.settings,
          emit,
          signal: controller.signal,
        });
        run.finalState = result.finalState;
        run.store = result.store;
        run.status = result.stopped === 'aborted' ? 'cancelled' : 'done';
      } else {
        emit({ t: Date.now(), kind: 'status', text: 'Running the task directly.' });
        await runFreeform({
          provider: execProvider,
          model: o.settings.execution.model,
          systemPrompt,
          task: o.task,
          workspace: o.project.workspace,
          tools,
          settings: o.settings,
          emit,
          signal: controller.signal,
        });
        run.status = controller.signal.aborted ? 'cancelled' : 'done';
      }
    } catch (e) {
      const err = e as Error;
      // Stop now tears down the request in flight, so what surfaces here is
      // often fetch's own AbortError. That is the user's doing, not a fault —
      // it should not read like one in the log.
      const cancelled = controller.signal.aborted || err.name === 'AbortError';
      run.status = cancelled ? 'cancelled' : 'failed';
      run.error = cancelled ? undefined : err.message;
      if (err instanceof AuthoringFailure && err.lastSource) {
        run.modelSource = err.lastSource;
      }
      emit({ t: Date.now(), kind: 'error', text: cancelled ? 'Run cancelled.' : err.message });
    } finally {
      run.finishedAt = new Date().toISOString();
      active.delete(run.id);
      persist();
      // persisted in full now, so the disk copy is the whole story again
      liveRuns.delete(run.id);
    }
  })();

  return run;
}

/** A cheap top-of-workspace listing, so the authored plan can name real files. */
function summariseWorkspace(dir: string, limit = 40): string {
  const skip = new Set(['.git', 'node_modules', '.orcrist-agent', '.DS_Store', 'dist', 'build']);
  try {
    const entries = readdirSync(dir)
      .filter((f) => !skip.has(f))
      .slice(0, limit)
      .map((f) => {
        try {
          return statSync(join(dir, f)).isDirectory() ? `${f}/` : f;
        } catch {
          return f;
        }
      });
    return entries.length ? entries.join('\n') : '(the workspace is empty)';
  } catch {
    return '(could not read the workspace)';
  }
}
