// =====================================================================
// Riduttore degli eventi di esecuzione.
//
// Sta in shared perche' lo usano tutti e due i lati: il main per
// mantenere lo snapshot autorevole, il renderer per aggiornare la sua
// copia senza dover richiedere tutto a ogni evento.
// =====================================================================

import type { ActivityItem, RunEvent, RunSnapshot, VisitRecord } from './protocol.js';

/** Il tool con cui il modello scrive: non compare nel registro. */
const REPORT_TOOL = 'report';

/** Porta lo snapshot avanti di un evento, sul posto. */
export function applyEvent(s: RunSnapshot, e: RunEvent): void {
  const currentVisit = (state: string): VisitRecord | undefined => {
    const trace = s.traces[state];
    return trace?.visits[trace.visits.length - 1];
  };

  switch (e.type) {
    case 'run-started':
      s.runId = e.runId;
      s.status = 'running';
      s.store = e.store;
      s.currentState = e.initial;
      break;

    case 'state-entered': {
      s.currentState = e.state;
      s.step = e.step;
      s.visitCounts[e.state] = e.visit;
      const trace = (s.traces[e.state] ??= { visits: [] });
      trace.visits.push({
        index: e.visit,
        startedAt: e.at,
        prompt: '',
        writes: {},
        activity: [],
      });
      break;
    }

    case 'prompt-built': {
      const v = currentVisit(e.state);
      if (v) v.prompt = e.prompt;
      break;
    }

    case 'tool-call': {
      const v = currentVisit(e.state);
      if (!v) break;
      // 'report' non e' un'azione da mostrare come tool: e' la
      // scrittura, e le righe che seguono la descrivono meglio.
      if (e.tool === REPORT_TOOL) break;
      v.activity.push({ kind: 'tool', at: e.at, id: e.id, tool: e.tool, input: e.input });
      break;
    }

    case 'tool-result': {
      const v = currentVisit(e.state);
      if (!v) break;
      // L'esito si attacca alla riga gia' presente nel registro,
      // cosi' la cronologia resta una voce sola per chiamata.
      const entry = [...v.activity].reverse().find(
        (a): a is Extract<ActivityItem, { kind: 'tool' }> => a.kind === 'tool' && a.id === e.id,
      );
      if (entry) {
        entry.ok = e.ok;
        entry.summary = e.summary;
      }
      break;
    }

    case 'writes-committed': {
      const v = currentVisit(e.state);
      if (!v) break;
      v.writes = { ...v.writes, ...e.values };
      for (const [location, value] of Object.entries(e.values)) {
        v.activity.push({ kind: 'write', at: e.at, by: 'agent', location, value });
      }
      break;
    }

    case 'write-rejected': {
      const v = currentVisit(e.state);
      if (v) v.activity.push({ kind: 'rejected', at: e.at, location: e.location, reason: e.reason });
      break;
    }

    case 'assignment': {
      const v = currentVisit(e.state);
      if (!v) break;
      v.activity.push({
        kind: 'write',
        at: e.at,
        by: 'set',
        location: e.source.split('=')[0].trim(),
        value: e.value,
        source: e.source,
      });
      break;
    }

    case 'store-changed':
      s.store = e.store;
      break;

    case 'ask-requested':
      s.pendingAsk = e.request;
      break;

    case 'ask-answered':
      // Solo se e' la domanda che stiamo aspettando: una risposta in
      // ritardo non deve chiudere quella arrivata dopo.
      if (s.pendingAsk?.id === e.id) s.pendingAsk = undefined;
      break;

    case 'invariant-violated':
      s.violations.push({ at: e.at, state: e.state, name: e.name, source: e.source });
      break;

    case 'transition': {
      const v = currentVisit(e.from);
      if (v) {
        v.exit = { to: e.to, reason: e.reason, guard: e.guard };
        v.endedAt = e.at;
      }
      break;
    }

    case 'notice': {
      if (e.level === 'error' && e.state) {
        const v = currentVisit(e.state);
        if (v) v.error = e.message;
      }
      break;
    }

    case 'run-finished':
      s.pendingAsk = undefined;
      s.status = e.reason === 'error' ? 'error' : 'finished';
      s.finishedReason = e.reason;
      s.error = e.error;
      if (e.state) s.currentState = e.state;
      break;

    default:
      break;
  }
}
