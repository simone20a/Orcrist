import type { CompileResult } from '../../shared/protocol.js';

export function Diagnostics({ result }: { result: CompileResult }): JSX.Element {
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  const warnings = result.diagnostics.filter((d) => d.severity === 'warning');

  if (!result.diagnostics.length) {
    return <div className="banner ok">The model compiles.</div>;
  }

  return (
    <div className="field">
      <div className={`banner ${errors.length ? 'error' : 'warn'}`}>
        {errors.length
          ? `${errors.length} error${errors.length === 1 ? 'e' : 'i'}` +
            (warnings.length ? `, ${warnings.length} warning(s)` : '')
          : `Compiles, with ${warnings.length} warning(s)`}
      </div>
      <div className="diagnostics">
        {result.diagnostics.map((d, i) => (
          <div key={i} className={`diagnostic ${d.severity}`}>
            <span className="loc">
              {d.line + 1}:{d.column + 1}
            </span>
            <span className="sev">{d.severity === 'error' ? 'error' : 'warning'}</span>
            <span>{d.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
