// =====================================================================
// I campi che descrivono come gira un progetto.
//
// Stanno qui perche' servono identici in due posti — alla creazione e
// nelle impostazioni di un progetto gia' esistente — e tenerne due
// copie significherebbe che prima o poi divergono.
// =====================================================================

import type { ProviderId, RuntimeConfig, SettingsView } from '../../shared/protocol.js';
import { PROVIDERS } from '../../shared/protocol.js';

interface Props {
  value: RuntimeConfig;
  settings?: SettingsView;
  onChange: (patch: Partial<RuntimeConfig>) => void;
  /** i limiti numerici interessano solo a chi sta mettendo a punto un progetto */
  showLimits?: boolean;
}

export function RuntimeFields({ value, settings, onChange, showLimits = false }: Props): JSX.Element {
  const info = PROVIDERS.find((p) => p.id === value.provider) ?? PROVIDERS[0];
  const keyMissing = info.needsKey && settings && !settings[value.provider]?.hasKey;
  const tavilyMissing = settings && !settings.tavily?.hasKey;

  return (
    <>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="rt-prov">Provider</label>
          <select
            id="rt-prov"
            value={value.provider}
            onChange={(e) => {
              const id = e.target.value as ProviderId;
              const next = PROVIDERS.find((p) => p.id === id)!;
              // cambiando provider il modello precedente non esiste piu':
              // si propone il primo suggerito invece di lasciare un nome rotto
              onChange({ provider: id, model: next.suggestedModels[0] });
            }}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {settings && !p.needsKey ? '' : settings?.[p.id]?.hasKey ? ' ✓' : ' (key missing)'}
              </option>
            ))}
          </select>
          {keyMissing && (
            <span className="hint" style={{ color: 'var(--warn)' }}>
              No key configured: set one in “API Keys” before running.
            </span>
          )}
        </div>

        <div className="field">
          <label htmlFor="rt-model">LLM model</label>
          <input
            id="rt-model"
            value={value.model}
            list="rt-model-list"
            onChange={(e) => onChange({ model: e.target.value })}
          />
          <datalist id="rt-model-list">
            {info.suggestedModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
      </div>

      {showLimits && (
        <div className="grid-2">
          <div className="field">
            <label htmlFor="rt-temp">Temperature</label>
            <input
              id="rt-temp"
              type="number"
              min={0}
              max={2}
              step={0.1}
              placeholder="provider default"
              value={value.temperature ?? ''}
              onChange={(e) =>
                // Vuoto significa "non mandare il campo": i modelli
                // Anthropic recenti rifiutano la richiesta se compare,
                // qualunque valore abbia.
                onChange({
                  temperature: e.target.value.trim() === '' ? undefined : clampNum(e.target.value, 0, 2, 0),
                })
              }
            />
            <span className="hint">
              Leave blank to use the provider default. 0 makes runs repeatable, but recent Anthropic models
              no longer accept this parameter.
            </span>
          </div>
          <div className="field">
            <label htmlFor="rt-tokens">Tokens per response</label>
            <input
              id="rt-tokens"
              type="number"
              min={256}
              max={64000}
              step={256}
              value={value.maxTokens}
              onChange={(e) => onChange({ maxTokens: clampNum(e.target.value, 256, 64000, 4096) })}
            />
          </div>
          <div className="field">
            <label htmlFor="rt-iter">Tool iterations per state</label>
            <input
              id="rt-iter"
              type="number"
              min={1}
              max={100}
              value={value.maxToolIterations}
              onChange={(e) => onChange({ maxToolIterations: clampNum(e.target.value, 1, 100, 12) })}
            />
            <span className="hint">The report is forced on the final iteration.</span>
          </div>
          <div className="field">
            <label htmlFor="rt-steps">Maximum machine steps</label>
            <input
              id="rt-steps"
              type="number"
              min={1}
              max={10000}
              value={value.maxSteps}
              onChange={(e) => onChange({ maxSteps: clampNum(e.target.value, 1, 10000, 200) })}
            />
            <span className="hint">Safeguard against unbounded loops.</span>
          </div>
        </div>
      )}

      <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={value.allowCommands}
          onChange={(e) => onChange({ allowCommands: e.target.checked })}
        />
        <span className="dim" style={{ fontSize: 12.5 }}>
          Allow shell commands in the workspace (build, test). Commands run with your
          permissions: enable it only if you trust the model.
        </span>
      </label>

      <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={value.allowWebSearch}
          onChange={(e) => onChange({ allowWebSearch: e.target.checked })}
        />
        <span className="dim" style={{ fontSize: 12.5 }}>
          Enable web search (<code>web_search</code>, <code>fetch_url</code>).
          {value.allowWebSearch && tavilyMissing && (
            <span style={{ color: 'var(--warn)' }}> Tavily key missing: web tools remain hidden.</span>
          )}
        </span>
      </label>
    </>
  );
}

function clampNum(raw: string, lo: number, hi: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
