// =====================================================================
// Il ponte fra una domanda del motore e la persona davanti allo
// schermo.
//
// Sta in un modulo suo, senza dipendenze da Electron, per due ragioni:
// e' la parte con la semantica piu' delicata dell'intera funzione — una
// promessa che resta sospesa e che deve chiudersi sempre, comunque
// vada — e cosi' i test possono esercitare proprio questa, invece di
// un doppio che finirebbe per non honorare l'interruzione.
//
// Tre uscite, tutte garantite:
//   answer()   la persona ha risposto
//   cancel()   la corsa e' finita mentre la domanda pendeva
//   abort      lo Stop ha interrotto l'esecuzione
// =====================================================================

import type { AskAnswer, AskRequest } from '../shared/protocol.js';

interface Waiting {
  id: string;
  resolve(answer: AskAnswer): void;
  reject(err: Error): void;
}

export interface AskBridge {
  /** Usata dal motore: si sospende finche' non arriva una risposta. */
  ask(projectId: string, request: AskRequest, signal: AbortSignal): Promise<AskAnswer>;
  /** Usata dall'interfaccia quando la persona risponde. */
  answer(projectId: string, answer: AskAnswer): void;
  /** Chiude una domanda rimasta senza interlocutore. */
  cancel(projectId: string): void;
  isWaiting(projectId: string): boolean;
}

export function abortError(message = 'Question cancelled: execution stopped.'): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

export function createAskBridge(): AskBridge {
  // Una sola domanda per progetto: il motore e' sequenziale.
  const pending = new Map<string, Waiting>();

  return {
    ask(projectId, request, signal) {
      return new Promise<AskAnswer>((resolve, reject) => {
        if (signal.aborted) {
          reject(abortError());
          return;
        }

        const settle = (): void => {
          pending.delete(projectId);
          signal.removeEventListener('abort', onAbort);
        };
        function onAbort(): void {
          settle();
          reject(abortError());
        }
        signal.addEventListener('abort', onAbort, { once: true });

        // Se una domanda precedente fosse ancora appesa — non dovrebbe
        // succedere, ma non si lascia un thread sospeso per sempre.
        pending.get(projectId)?.reject(abortError('Question replaced by a new one.'));

        pending.set(projectId, {
          id: request.id,
          resolve: (a) => {
            settle();
            resolve(a);
          },
          reject: (e) => {
            settle();
            reject(e);
          },
        });
      });
    },

    answer(projectId, answer) {
      const waiting = pending.get(projectId);
      // L'id protegge dalle risposte in ritardo: una finestra rimasta
      // aperta su una domanda vecchia non deve sbloccarne una nuova.
      if (!waiting || waiting.id !== answer.id) return;
      waiting.resolve(answer);
    },

    cancel(projectId) {
      pending.get(projectId)?.reject(abortError('Execution completed without an answer.'));
    },

    isWaiting(projectId) {
      return pending.has(projectId);
    },
  };
}

/** Il ponte dell'applicazione. */
export const askBridge = createAskBridge();
