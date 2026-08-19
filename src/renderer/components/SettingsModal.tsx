// =====================================================================
// Chiavi API.
//
// Il renderer non vede mai una chiave: la scrive e basta. Il main la
// cifra con il portachiavi di sistema e restituisce solo hasKey.
// =====================================================================

import { useEffect, useState } from 'react';
import type { CredentialId, SettingsView } from '../../shared/protocol.js';
import { PROVIDERS, WEB_SEARCH } from '../../shared/protocol.js';

export function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [settings, setSettings] = useState<SettingsView | undefined>();
  const [drafts, setDrafts] = useState<Partial<Record<CredentialId, string>>>({});
  const [status, setStatus] = useState<Partial<Record<CredentialId, { ok: boolean; message: string }>>>({});
  const [testing, setTesting] = useState<CredentialId | undefined>();

  useEffect(() => {
    void window.orcrist.settings.read().then(setSettings);
  }, []);

  const saveKey = async (id: CredentialId): Promise<void> => {
    const value = drafts[id] ?? '';
    try {
      setSettings(await window.orcrist.settings.setKey(id, value));
      setDrafts((d) => ({ ...d, [id]: '' }));
      setStatus((s) => ({ ...s, [id]: { ok: true, message: 'Key saved in the system keychain.' } }));
    } catch (err) {
      setStatus((s) => ({ ...s, [id]: { ok: false, message: (err as Error).message } }));
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header>
          <h3>API Keys</h3>
          <button className="btn ghost" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="body">
          <span className="hint">
            Keys are encrypted with the operating-system keychain and remain in the main process; they are never
            exposed to the interface.
          </span>

          {[...PROVIDERS, WEB_SEARCH].map((info) => {
            const current = settings?.[info.id];
            const isWeb = info.id === 'tavily';
            return (
              <div key={info.id} className="field" style={isWeb ? { borderTop: '1px solid var(--line)', paddingTop: 16 } : undefined}>
                {isWeb && (
                  <span className="hint">
                    Used only by <code>web_search</code> and <code>fetch_url</code>. Without a key, the agent
                    works offline, using workspace files only.
                  </span>
                )}
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <label>{info.label}</label>
                  {current?.hasKey ? (
                    <span className="tag set">configured</span>
                  ) : (
                    <span className="tag">{info.needsKey ? 'missing' : 'optional'}</span>
                  )}
                </div>

                <div className="row">
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={current?.hasKey ? '••••••••  (replace to update)' : info.keyHint}
                    value={drafts[info.id] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [info.id]: e.target.value }))}
                    onKeyDown={(e) => e.key === 'Enter' && void saveKey(info.id)}
                  />
                  <button className="btn" disabled={!drafts[info.id]?.trim()} onClick={() => void saveKey(info.id)}>
                    Save
                  </button>
                  {current?.hasKey && (
                    <button
                      className="btn ghost"
                      onClick={async () => setSettings(await window.orcrist.settings.clearKey(info.id))}
                    >
                      Remove
                    </button>
                  )}
                </div>

                {info.configurableBaseUrl && (
                  <input
                    className="mono"
                    value={current?.baseUrl ?? info.defaultBaseUrl}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSettings((s) => (s ? { ...s, [info.id]: { ...s[info.id], baseUrl: v } } : s));
                    }}
                    onBlur={async (e) => setSettings(await window.orcrist.settings.setBaseUrl(info.id, e.target.value))}
                  />
                )}

                <div className="row">
                  <button
                    className="btn ghost"
                    disabled={testing === info.id || (info.needsKey && !current?.hasKey)}
                    onClick={async () => {
                      setTesting(info.id);
                      const res = await window.orcrist.settings.test(info.id, info.suggestedModels[0]);
                      setStatus((s) => ({ ...s, [info.id]: res }));
                      setTesting(undefined);
                    }}
                  >
                    {testing === info.id
                      ? 'Checking…'
                      : isWeb
                        ? 'Try a search'
                        : `Try ${info.suggestedModels[0]}`}
                  </button>
                  {status[info.id] && (
                    <span
                      className="hint"
                      style={{ color: status[info.id]!.ok ? 'var(--live)' : 'var(--danger)' }}
                    >
                      {status[info.id]!.message}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <footer>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
