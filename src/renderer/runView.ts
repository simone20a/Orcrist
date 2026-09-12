import type { Run, RunEvent } from '../core/types';
import type { Store } from '../orcrist/evaluator';

export interface RunView {
  currentState?: string;
  currentVisit: number;
  currentPrompt?: string;
  visited: Set<string>;
  visitCounts: Record<string, number>;
  store: Store;
  lastTransition?: { from: string; to: string; via: string; label: string };
  finalState?: string;
  transitions: number;
  toolCalls: number;
  errors: number;
  awaitingApproval: boolean;
}

/** Folds a run's event log into the state the FSM column renders. */
export function foldRun(run: Run | undefined): RunView {
  const view: RunView = {
    currentVisit: 0,
    visited: new Set(),
    visitCounts: {},
    store: {},
    transitions: 0,
    toolCalls: 0,
    errors: 0,
    awaitingApproval: false,
  };
  if (!run) return view;

  for (const e of run.events) {
    applyEvent(view, e);
  }
  if (run.store) view.store = { ...view.store, ...run.store };
  return view;
}

export function applyEvent(view: RunView, e: RunEvent): void {
  switch (e.kind) {
    case 'state-enter':
      view.currentState = e.state;
      view.currentVisit = e.visit;
      view.currentPrompt = e.prompt;
      view.visited.add(e.state);
      view.visitCounts[e.state] = e.visit;
      break;
    case 'store':
      view.store = e.store;
      break;
    case 'transition':
      view.transitions++;
      view.lastTransition = { from: e.from, to: e.to, via: e.via, label: e.label };
      view.currentState = e.to;
      break;
    case 'tool-call':
      view.toolCalls++;
      break;
    case 'final':
      view.finalState = e.state;
      view.currentState = e.state;
      view.visited.add(e.state);
      break;
    case 'error':
      view.errors++;
      break;
    case 'approval-request':
      view.awaitingApproval = true;
      break;
    case 'approval':
      view.awaitingApproval = false;
      break;
    default:
      break;
  }
}

export function statusLabel(run?: Run): { text: string; cls: string } {
  if (!run) return { text: 'idle', cls: '' };
  switch (run.status) {
    case 'authoring':
      return { text: 'authoring model', cls: 'live' };
    case 'awaiting-approval':
      return { text: 'awaiting approval', cls: 'warn' };
    case 'running':
      return { text: 'running', cls: 'live' };
    case 'done':
      // The drawer names the final state right underneath, so repeating it
      // here would say the same word twice in a row.
      return { text: 'done', cls: 'ok' };
    case 'failed':
      return { text: 'failed', cls: 'err' };
    case 'cancelled':
      return { text: 'cancelled', cls: 'warn' };
  }
}

/** Busy in any sense — the composer stays shut and Stop is offered. */
export function isLive(run?: Run): boolean {
  return (
    run?.status === 'authoring' ||
    run?.status === 'running' ||
    run?.status === 'awaiting-approval'
  );
}
