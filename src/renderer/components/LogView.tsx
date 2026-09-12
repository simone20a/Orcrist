import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Run, RunEvent } from '../../core/types';
import { Markdown } from './Markdown';

interface Props {
  runs: Run[];
  onShowModel: () => void;
}

/**
 * The session log: one continuous transcript of every message sent in this
 * session and what the machine did in response — the user's message, then the
 * states it ran through, the tools it used and the values it reported.
 */
export function SessionLog({ runs, onShowModel }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const total = runs.reduce((n, r) => n + r.events.length, 0);

  // Follow the run while it streams, but stop fighting the user the moment
  // they scroll back to read something.
  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  useEffect(() => {
    stick.current = true;
  }, [runs.length]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [total, runs.length]);

  if (!runs.length) {
    return (
      <div className="log">
        <div className="log-empty">
          <div className="big">Nothing here yet</div>
        </div>
      </div>
    );
  }

  return (
    <div className="log" ref={boxRef} onScroll={onScroll}>
      {runs.map((run) => (
        <RunBlock key={run.id} run={run} onShowModel={onShowModel} />
      ))}
    </div>
  );
}

function RunBlock({ run, onShowModel }: { run: Run; onShowModel: () => void }) {
  // pair tool calls with their results so each renders as one collapsible block
  const results = new Map<string, Extract<RunEvent, { kind: 'tool-result' }>>();
  for (const e of run.events) {
    if (e.kind === 'tool-result') results.set(e.id, e);
  }

  // Everything the model says while working is process; the last thing it says
  // is the answer. Only mark it once the run has stopped — during a run the
  // "last" message is just the most recent one, and promoting it would make the
  // emphasis jump down the page on every round.
  const settled = run.status !== 'running' && run.status !== 'authoring' && run.status !== 'awaiting-approval';
  let answerIndex = -1;
  if (settled) {
    for (let i = run.events.length - 1; i >= 0; i--) {
      if (run.events[i].kind === 'assistant') {
        answerIndex = i;
        break;
      }
    }
  }

  return (
    <section className="turn">
      <div className="msg-user">
        <div className="eyebrow">You asked</div>
        <div className="bubble">{run.task}</div>
      </div>

      {run.events.map((e, i) => (
        <EventRow
          key={i}
          event={e}
          results={results}
          onShowModel={onShowModel}
          isAnswer={i === answerIndex}
        />
      ))}

      {run.status === 'failed' && run.error && (
        <div className="ev error">
          <div className="ev-head">
            <span className="who">Run failed</span>
          </div>
          <div className="ev-text">{run.error}</div>
        </div>
      )}
    </section>
  );
}

function EventRow({
  event,
  results,
  onShowModel,
  isAnswer,
}: {
  event: RunEvent;
  results: Map<string, Extract<RunEvent, { kind: 'tool-result' }>>;
  onShowModel: () => void;
  isAnswer: boolean;
}) {
  switch (event.kind) {
    case 'status':
    case 'authoring':
      return (
        <div className="ev status">
          <div className="ev-text">{event.text}</div>
        </div>
      );

    case 'no-model':
      return (
        <div className="ev status">
          <div className="ev-text">No machine for this message — {event.reason}</div>
        </div>
      );

    case 'reuse-model':
      return (
        <div className="ev status">
          <div className="ev-text">
            Re-running {event.name} unchanged — {event.reason}
          </div>
        </div>
      );

    case 'approval-request':
      return (
        <div className="ev status">
          <div className="ev-text">
            Waiting for you to approve {event.name} before anything runs…
          </div>
        </div>
      );

    case 'approval':
      return (
        <div className="ev model-note">
          <span className={`badge ${event.approved ? 'ok' : 'warn'}`}>
            {event.approved ? 'approved' : 'discarded'}
          </span>
          <span className="mono">{event.name}</span>
        </div>
      );

    case 'model':
      return (
        <div className="ev model-note">
          <span className={`badge ${event.revised ? 'warn' : ''}`}>
            {event.revised ? 'machine revised' : 'machine authored'}
          </span>
          <span className="mono">{event.name}</span>
          {event.warnings.length > 0 && (
            <span className="badge warn">{event.warnings.length} warning(s)</span>
          )}
          <button className="ghost" onClick={onShowModel}>
            view .orc
          </button>
        </div>
      );

    case 'state-enter':
      return (
        <div className="ev state-enter">
          <div className="state-enter-row">
            <div>
              <div className="eyebrow">State</div>
              <span className="sname">{event.state}</span>
            </div>
            {event.visit > 1 && (
              <div className="visit">
                <div className="eyebrow">Visit</div>
                <span className="figure lg">{event.visit}</span>
              </div>
            )}
          </div>
          <StatePrompt source={event.prompt} />
        </div>
      );

    case 'assistant': {
      // A one-line answer carries its emphasis at full weight. A structured one
      // — headings, lists, code — cannot: a dozen lines set in 700 stops being
      // emphasis and becomes noise, and bold inside it would have nowhere left
      // to go. Those keep the answer's size and contrast, at a reading weight.
      const structured = /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~|>\s)/.test(event.text) ||
        /\n\s*\n/.test(event.text.trim());
      return (
        <div className={`ev assistant ${isAnswer ? 'answer' : ''} ${isAnswer && structured ? 'rich' : ''}`}>
          <Markdown className="ev-text" source={event.text} />
        </div>
      );
    }

    case 'tool-call':
      return <ToolBlock call={event} result={results.get(event.id)} />;

    case 'tool-result':
      return null; // rendered inside its call

    case 'writes':
      return (
        <div className="ev writes">
          <span className="t">reported</span>{' '}
          {Object.entries(event.values)
            .map(([k, v]) => `${k} = ${short(v)}`)
            .join('   ')}
        </div>
      );

    // The one line in a turn that the model did not write. It says what was
    // run as well as what came back, because a measurement the reader cannot
    // trace is no better than a claim.
    case 'observe':
      return (
        <div className={`ev observe ${event.ok ? '' : 'failed'}`}>
          <span className="dot-observe" />
          <span className="t">{event.ok ? 'measured' : 'not measured'}</span> {event.target}{' '}
          {event.ok ? '=' : '—'} {event.detail}{' '}
          <span className="cmd">— {event.command}</span>
        </div>
      );

    case 'assignment':
      return (
        <div className="ev assignment">
          <span className="t">set</span> {event.target} = {event.expr} → {event.value}
        </div>
      );

    case 'invariant':
      return (
        <div className="ev error">
          <div className="ev-text">Invariant violated: {event.name}</div>
        </div>
      );

    case 'transition':
      return (
        <div className={`ev transition ${event.via}`}>
          {event.from} <span className="arrow">→</span> {event.to}{' '}
          <span className="lbl">[{event.via === 'otherwise' ? 'otherwise' : event.label}]</span>
        </div>
      );

    case 'final':
      return (
        <div className="ev final">
          <span className="eyebrow">Reached final state</span>
          <span className="fname">{event.state}</span>
        </div>
      );

    case 'error':
      return (
        <div className="ev error">
          <div className="ev-text">{event.text}</div>
        </div>
      );

    case 'store':
      return null; // shown live in the machine drawer instead

    default:
      return null;
  }
}

/**
 * The instruction a state was given, opened on request.
 *
 * A state's prompt is a work order, sometimes a long one, and the transcript is
 * read for what happened rather than for what was asked. So it arrives as its
 * first couple of lines and grows when clicked. The affordance only appears
 * when there is something hidden — a two-line prompt with a "more" under it
 * would be a lie — which means measuring after layout: whether the text
 * overflows is a fact about the rendered box, not about the string.
 */
function StatePrompt({ source }: { source: string }) {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    // The clamp is on the rendered markdown, not on the wrapper — measuring the
    // wrapper asks whether a box that fits its clamped child overflows, which
    // it never does.
    const el = ref.current?.firstElementChild;
    // Only meaningful while collapsed: once open the box is its own content.
    if (el && !open) setClipped(el.scrollHeight - el.clientHeight > 2);
  }, [source, open]);

  // `clipped` is left alone while open — it is what keeps the control on
  // screen, and re-measuring an expanded box would always say "fits".
  const toggle = () => setOpen((o) => !o);

  return (
    <div className={`sprompt-block ${open ? 'open' : ''} ${clipped ? 'clipped' : ''}`}>
      <div ref={ref} onClick={clipped ? toggle : undefined}>
        <Markdown className="sprompt" source={source} />
      </div>
      {clipped && (
        <button className="ghost sprompt-more" onClick={toggle} aria-expanded={open}>
          {open ? 'show less' : 'show the whole instruction'}
        </button>
      )}
    </div>
  );
}

function ToolBlock({
  call,
  result,
}: {
  call: Extract<RunEvent, { kind: 'tool-call' }>;
  result?: Extract<RunEvent, { kind: 'tool-result' }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ev">
      <div className="tool">
        <div className="tool-head" onClick={() => setOpen((o) => !o)}>
          <span className="caret">{open ? '▾' : '▸'}</span>
          <span className="tname">{call.name}</span>
          <span className="tsum">{summarise(call.args)}</span>
          {result?.isError && <span className="badge err">error</span>}
          {!result && <span className="spin" />}
        </div>
        {open && (
          <div className="tool-body">
            <div className="lbl">arguments</div>
            <pre>{JSON.stringify(call.args, null, 2)}</pre>
            {result && (
              <>
                <div className="lbl">result</div>
                <pre>{result.result}</pre>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function summarise(args: Record<string, unknown>): string {
  const preferred = ['command', 'path', 'url', 'query'];
  for (const k of preferred) {
    if (typeof args[k] === 'string') return String(args[k]);
  }
  const entries = Object.entries(args);
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${k}=${short(v)}`).join(' ');
}

function short(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 70 ? `${s.slice(0, 69)}…` : s;
}
