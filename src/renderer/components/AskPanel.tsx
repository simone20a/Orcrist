// =====================================================================
// La domanda dell'agente.
//
// Compare in basso, sopra il grafo, mentre la macchina e' ferma ad
// aspettare. Non copre gli stati: resta ancorata al bordo inferiore
// cosi' si continua a vedere dove si trova l'esecuzione e da quale
// stato arriva la domanda.
//
// L'unica cosa che deve fare bene: non lasciare mai la corsa appesa.
// Rispondi, salti, o premi Stop — tre uscite, tutte percorribili.
// =====================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AskAnswer, AskRequest } from '../../shared/protocol.js';

interface Props {
  request: AskRequest;
  onAnswer: (answer: AskAnswer) => void;
  onFocusState: (state: string) => void;
}

export function AskPanel({ request, onAnswer, onFocusState }: Props): JSX.Element {
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const options = useMemo(() => request.options ?? [], [request.options]);
  const closed = request.kind === 'single' || request.kind === 'multi';

  // Ogni domanda riparte pulita, e il cursore e' gia' dove serve.
  useEffect(() => {
    setText('');
    setSelected([]);
    setFreeText(false);
    if (request.kind === 'open') inputRef.current?.focus();
  }, [request.id, request.kind]);

  const usingFreeText = request.kind === 'open' || freeText;
  const canSend = usingFreeText ? text.trim().length > 0 : selected.length > 0;

  const send = (): void => {
    if (!canSend) return;
    onAnswer({
      id: request.id,
      text: usingFreeText ? text.trim() : undefined,
      selected: usingFreeText ? undefined : selected,
    });
  };

  /** Una scelta singola si conferma con un click solo. */
  const pick = (option: string): void => {
    if (request.kind === 'multi') {
      setSelected((s) => (s.includes(option) ? s.filter((x) => x !== option) : [...s, option]));
      return;
    }
    onAnswer({ id: request.id, selected: [option] });
  };

  return (
    <div className="ask" role="dialog" aria-label="Agent question">
      <div className="ask-head">
        <span className="ask-pip" />
        <span className="ask-from">
          <button className="btn ghost" onClick={() => onFocusState(request.state)}>
            {request.state}
          </button>
          <span className="faint">asks</span>
        </span>
        <span className="spacer" />
        <span className="tag">
          {request.kind === 'open' ? 'open response' : request.kind === 'single' ? 'single choice' : 'multiple choice'}
        </span>
      </div>

      <div className="ask-question">{request.question}</div>
      {request.detail && <div className="ask-detail">{request.detail}</div>}

      {closed && !freeText && (
        <div className={`ask-options${request.kind === 'multi' ? ' multi' : ''}`}>
          {options.map((o) => (
            <button
              key={o}
              className={`ask-option${selected.includes(o) ? ' picked' : ''}`}
              onClick={() => pick(o)}
            >
              {request.kind === 'multi' && (
                <span className="box">{selected.includes(o) ? '✓' : ''}</span>
              )}
              <span>{o}</span>
            </button>
          ))}
        </div>
      )}

      {usingFreeText && (
        <textarea
          ref={inputRef}
          className="ask-input"
          rows={2}
          value={text}
          placeholder={request.placeholder ?? 'Write your answer…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Invio manda, Maiusc+Invio va a capo: la risposta e' quasi
            // sempre una riga sola, e chiederle un click e' di troppo.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
      )}

      <div className="ask-actions">
        {closed && request.allowFreeText && (
          <button className="btn ghost" onClick={() => setFreeText((v) => !v)}>
            {freeText ? '← Back to choices' : 'None of these…'}
          </button>
        )}
        <span className="spacer" />
        <button
          className="btn ghost"
          title="The agent continues by deciding independently and reports that choice."
          onClick={() => onAnswer({ id: request.id, skipped: true })}
        >
          Skip
        </button>
        {(usingFreeText || request.kind === 'multi') && (
          <button className="btn primary" disabled={!canSend} onClick={send}>
            Rispondi
          </button>
        )}
      </div>
    </div>
  );
}
