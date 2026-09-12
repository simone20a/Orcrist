import { useState } from 'react';
import type { Run } from '../../core/types';
import { Modal } from './Modal';
import { MachineLocations, MachinePreview } from './MachinePreview';

interface Props {
  run: Run;
  revised: boolean;
  onDecide: (approved: boolean) => void;
}

/**
 * Shown after the machine is authored and validated, before anything executes.
 * The machine decides how the whole run is shaped, so it is worth a look —
 * and nothing is written to the session until this is approved.
 */
export function ApprovalDialog({ run, revised, onDecide }: Props) {
  const [showSource, setShowSource] = useState(false);
  const machine = run.machine;
  if (!machine) return null;

  return (
    <Modal
      title={revised ? `Revised machine: ${machine.name}` : `Proposed machine: ${machine.name}`}
      xl
      onClose={() => onDecide(false)}
      footer={
        <>
          <span className="foot-note">
            Hover a state to see the prompt it will give.
          </span>
          <button onClick={() => onDecide(false)}>Discard</button>
          <button className="primary" onClick={() => onDecide(true)} autoFocus>
            Approve and run
          </button>
        </>
      }
    >
      <MachinePreview machine={machine} />

      {run.authoringNotes && (
        <>
          <div className="section-title">Plan</div>
          <p style={{ color: 'var(--fg-2)', whiteSpace: 'pre-wrap', margin: 0 }}>
            {run.authoringNotes}
          </p>
        </>
      )}

      <MachineLocations machine={machine} />

      {run.warnings && run.warnings.length > 0 && (
        <>
          <div className="section-title">
            Validator warnings <span className="badge warn">{run.warnings.length}</span>
          </div>
          {run.warnings.map((w, i) => (
            <p key={i} style={{ fontSize: 11.5, color: 'var(--fg-3)', margin: '0 0 6px' }}>
              line {w.line}: {w.message}
            </p>
          ))}
        </>
      )}

      <div className="section-title">
        Source
        <span style={{ flex: 1 }} />
        <button className="ghost" onClick={() => setShowSource((s) => !s)} style={{ fontSize: 11 }}>
          {showSource ? 'hide' : 'show'} .orc
        </button>
      </div>
      {showSource && (
        <div className="model-src">
          <pre>{run.modelSource}</pre>
        </div>
      )}
    </Modal>
  );
}
