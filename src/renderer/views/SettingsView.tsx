import { useEffect, useState } from 'react';
import { api } from '../api';
import { KNOWN_MODELS, type Settings } from '../../core/types';
import type { ProviderId } from '../../core/llm/types';
import { Modal } from '../components/Modal';
import { applyTheme, rememberTheme, THEMES } from '../themes';

interface Props {
  settings: Settings;
  onSave: (s: Settings) => void;
  onClose: () => void;
  onError: (msg: string) => void;
}

const PROVIDERS: { id: ProviderId; label: string; placeholder?: string; note: string }[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    placeholder: 'sk-ant-…',
    note: 'console.anthropic.com',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    placeholder: 'sk-…',
    note: 'platform.openai.com',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    note: 'Local server. Needs a model that supports tool calling.',
  },
];

const TABS = [
  ['models', 'Models'],
  ['providers', 'Providers'],
  ['tools', 'Tools & limits'],
  ['theme', 'Palette'],
] as const;

export function SettingsView({ settings, onSave, onClose, onError }: Props) {
  const [draft, setDraft] = useState<Settings>(structuredClone(settings));
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('models');
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  /**
   * What the machine's own Ollama had to say, in a form the screen can show.
   * 'idle' is only ever seen before the first ask; everything else is a
   * sentence this panel is prepared to print, because "nothing happened" is
   * the one answer a list of local models must never give.
   */
  const [ollamaState, setOllamaState] = useState<'idle' | 'loading' | 'ok' | 'empty' | 'error'>(
    'idle',
  );
  const [ollamaError, setOllamaError] = useState('');
  const [busy, setBusy] = useState(false);

  const patch = (p: Partial<Settings>) => setDraft((d) => ({ ...d, ...p }));
  const patchProvider = (id: ProviderId, p: Partial<Settings['providers'][ProviderId]>) =>
    setDraft((d) => ({ ...d, providers: { ...d.providers, [id]: { ...d.providers[id], ...p } } }));

  const save = async () => {
    try {
      onSave(await api.settings.save(draft));
      rememberTheme(draft.theme ?? 'sage');
      onClose();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  /* A palette is picked by looking at it, so choosing one applies it to the
     whole window immediately rather than after a save. Cancelling puts back
     the one that was saved — a preview that survives being rejected is not a
     preview. */
  const previewTheme = (id: string) => {
    setDraft((d) => ({ ...d, theme: id }));
    applyTheme(id);
  };

  const cancel = () => {
    applyTheme(settings.theme);
    onClose();
  };

  const ollamaUrl = draft.providers.ollama.baseUrl?.trim() || 'http://localhost:11434';

  const loadOllama = async () => {
    setBusy(true);
    setOllamaState('loading');
    try {
      const models = await api.settings.ollamaModels(ollamaUrl);
      setOllamaModels(models);
      setOllamaState(models.length ? 'ok' : 'empty');
      setOllamaError('');
    } catch (e) {
      // Not a toast. The question was asked here, so the answer belongs here —
      // and the usual answer is "the server isn't running", which the user can
      // act on only if they can still see what was asked.
      setOllamaState('error');
      setOllamaError((e as Error).message);
      setOllamaModels([]);
    } finally {
      setBusy(false);
    }
  };

  // Choosing Ollama for a role is itself the request to see what is installed:
  // the list is the point of choosing it. Asked once per visit to Settings —
  // a machine with no Ollama running should not be polled on every render.
  const usesOllama = draft.authoring.provider === 'ollama' || draft.execution.provider === 'ollama';
  useEffect(() => {
    if (usesOllama && ollamaState === 'idle') void loadOllama();
  }, [usesOllama, ollamaState]);

  /** Whether a provider can actually be called right now. */
  const ready = (id: ProviderId) => id === 'ollama' || Boolean(draft.providers[id].apiKey);

  /**
   * One of the two model roles. The model is the thing you came here to read,
   * so it is the largest mark in the block; the provider sits under it as the
   * label it is, and a missing key is stated right here rather than left for
   * the run to discover.
   */
  const role = (which: 'authoring' | 'execution', title: string, does: string) => {
    const choice = draft[which];
    const options =
      choice.provider === 'ollama' && ollamaModels.length
        ? ollamaModels
        : KNOWN_MODELS[choice.provider];
    return (
      <div className="role">
        <div className="role-head">
          <span className="eyebrow">{title}</span>
          <span className="role-does">{does}</span>
        </div>
        <div className="role-body">
          {/* Three providers is a row of choices, not a dropdown: the options
              are worth seeing, and a native select is the one control in this
              app that would look like it came from somewhere else. */}
          <div className="seg" role="group" aria-label={`${title} provider`}>
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                className={`seg-opt ${choice.provider === p.id ? 'on' : ''}`}
                aria-pressed={choice.provider === p.id}
                onClick={() =>
                  patch({
                    [which]: { provider: p.id, model: KNOWN_MODELS[p.id][0] },
                  } as Partial<Settings>)
                }
              >
                {p.label}
              </button>
            ))}
            {!ready(choice.provider) && (
              <button className="ghost warn-link" onClick={() => setTab('providers')}>
                no key — set one
              </button>
            )}
          </div>
          <label className="sr-only" htmlFor={`model-${which}`}>
            Model id
          </label>
          <input
            id={`model-${which}`}
            className="role-model"
            list={`models-${which}`}
            value={choice.model}
            onChange={(e) =>
              patch({ [which]: { ...choice, model: e.target.value } } as Partial<Settings>)
            }
            placeholder="model id"
            spellCheck={false}
          />
          <datalist id={`models-${which}`}>
            {options.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {choice.provider === 'ollama' && localModels(which)}
        </div>
      </div>
    );
  };

  /**
   * The models installed on this machine, listed where the choice is made.
   *
   * They used to go into the `<datalist>` above and nowhere else, which meant
   * the button that fetched them appeared to do nothing at all: a datalist is
   * invisible until the field is cleared and typed into, so a user who clicked
   * "list installed models" got a successful request, a populated list, and an
   * unchanged screen. The list has to be a thing on the page.
   */
  const localModels = (which: 'authoring' | 'execution') => {
    const current = draft[which].model;
    return (
      <div className="local-models">
        <div className="local-head">
          <span className="eyebrow">On this machine</span>
          <button className="ghost" onClick={() => void loadOllama()} disabled={busy}>
            {busy ? 'asking ollama…' : 'refresh'}
          </button>
        </div>

        {ollamaState === 'ok' && (
          <div className="seg" role="group" aria-label="Installed Ollama models">
            {ollamaModels.map((m) => (
              <button
                key={m}
                className={`seg-opt ${current === m ? 'on' : ''}`}
                aria-pressed={current === m}
                onClick={() =>
                  patch({ [which]: { provider: 'ollama', model: m } } as Partial<Settings>)
                }
              >
                {m}
              </button>
            ))}
          </div>
        )}

        {ollamaState === 'loading' && <p className="help">Asking {ollamaUrl}…</p>}

        {ollamaState === 'empty' && (
          <p className="help">
            Ollama is running at {ollamaUrl}, but has no models installed. Pull one that supports
            tool calling — <span className="mono">ollama pull qwen2.5-coder:14b</span> — then
            refresh.
          </p>
        )}

        {ollamaState === 'error' && (
          <p className="help">
            No answer from {ollamaUrl}. Start it with <span className="mono">ollama serve</span>, or
            set a different address under Providers. You can still type a model id above.
            {/* The detail is worth printing only when it says something the
                sentence above does not — a refused connection already has its
                explanation; an HTTP 403 from a proxy does not. */}
            {ollamaError && !/^could not reach Ollama/.test(ollamaError) ? ` — ${ollamaError}` : ''}
          </p>
        )}
      </div>
    );
  };

  return (
    <Modal
      title="Settings"
      wide
      onClose={cancel}
      footer={
        <>
          <button onClick={cancel}>Cancel</button>
          <button className="primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="tabs">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            className={`tab ${tab === id ? 'active' : ''}`}
            onClick={() => setTab(id)}
            aria-pressed={tab === id}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'models' && (
        <>
          {role(
            'authoring',
            'Authoring',
            'Writes the machine. It shapes the whole run, so give it the strongest model you have.',
          )}
          {role(
            'execution',
            'Execution',
            'Runs each state: uses the tools, does the work, reports the values.',
          )}
        </>
      )}

      {tab === 'providers' && (
        <div className="provs">
          {PROVIDERS.map((p) => (
            <div className="prov" key={p.id}>
              <div className="prov-head">
                <span className="prov-name">{p.label}</span>
                <span className={`state-tag ${ready(p.id) ? 'on' : ''}`}>
                  {p.id === 'ollama' ? 'local' : ready(p.id) ? 'key set' : 'no key'}
                </span>
              </div>
              <div className="prov-fields">
                {p.id !== 'ollama' && (
                  <div className="field">
                    <label htmlFor={`key-${p.id}`}>API key</label>
                    <input
                      id={`key-${p.id}`}
                      type="password"
                      value={draft.providers[p.id].apiKey ?? ''}
                      onChange={(e) => patchProvider(p.id, { apiKey: e.target.value })}
                      placeholder={p.placeholder}
                    />
                  </div>
                )}
                <div className="field">
                  <label htmlFor={`url-${p.id}`}>Base URL</label>
                  <input
                    id={`url-${p.id}`}
                    className="mono"
                    value={draft.providers[p.id].baseUrl ?? ''}
                    onChange={(e) => patchProvider(p.id, { baseUrl: e.target.value })}
                    spellCheck={false}
                  />
                </div>
              </div>
              <div className="prov-note">{p.note}</div>
            </div>
          ))}
          <p className="marginal">Keys are kept in this app’s local settings file, in the clear.</p>
        </div>
      )}

      {tab === 'theme' && (
        <div className="themes">
          {THEMES.map((t) => {
            const on = (draft.theme ?? 'sage') === t.id;
            return (
              <button
                key={t.id}
                className={`swatch ${on ? 'on' : ''}`}
                onClick={() => previewTheme(t.id)}
                aria-pressed={on}
                style={{ background: t.brand, color: t.ink }}
              >
                {/* the palette shown as itself: the field behind, the ink set
                    in it, and the four roles as marks along the bottom */}
                <span className="swatch-name">{t.name}</span>
                <span className="swatch-roles">
                  {([
                    ['accent', t.accent],
                    ['warn', t.warn],
                    ['danger', t.danger],
                    ['marginalia', t.marginalia],
                  ] as const).map(([role, c]) => (
                    <i key={role} title={role} style={{ background: c }} />
                  ))}
                </span>
                <span className="swatch-note">{t.note}</span>
              </button>
            );
          })}
        </div>
      )}

      {tab === 'tools' && (
        <>
          <div className="section-title">Tools</div>
          <Toggle
            id="sh"
            name="run_command"
            mono
            on={draft.enableShell}
            onChange={(v) => patch({ enableShell: v })}
            desc="A shell, with the workspace as its working directory."
          />
          <Toggle
            id="web"
            name="web_fetch, web_search"
            mono
            on={draft.enableWeb}
            onChange={(v) => patch({ enableWeb: v })}
            desc="Fetching pages and searching the web."
          />
          <div className="toggle-row static">
            <div>
              <span className="mono tname">read_file, write_file, edit_file, list_directory</span>
              <span className="tdesc">Always on, always sandboxed to the workspace.</span>
            </div>
            <span className="state-tag on">always</span>
          </div>

          <div className="field" style={{ marginTop: 22 }}>
            <label htmlFor="blocked">Blocked shell patterns — one per line</label>
            <textarea
              id="blocked"
              className="mono"
              rows={4}
              value={draft.blockedCommands}
              onChange={(e) => patch({ blockedCommands: e.target.value })}
              spellCheck={false}
            />
            <div className="help">
              A command containing any of these as a substring is refused before it runs.
            </div>
          </div>

          <div className="section-title">Before a run</div>
          <Toggle
            id="approve"
            name="Approve the machine first"
            on={draft.requireModelApproval}
            onChange={(v) => patch({ requireModelApproval: v })}
            desc="Show a newly authored or revised machine and wait. Nothing reaches the session until you approve it."
          />

          <div className="section-title">Safety limits</div>
          <div className="row">
            <div className="field">
              <label htmlFor="maxt">Transitions per run</label>
              <input
                id="maxt"
                type="number"
                min={1}
                value={draft.maxStateTransitions}
                onChange={(e) => patch({ maxStateTransitions: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label htmlFor="maxr">Tool rounds per state</label>
              <input
                id="maxr"
                type="number"
                min={1}
                value={draft.maxToolRoundsPerState}
                onChange={(e) => patch({ maxToolRoundsPerState: Number(e.target.value) })}
              />
            </div>
          </div>
          <p className="marginal">
            Structural caps on top of the language’s own <code>limit</code> — a machine can be
            well-formed and still be handed to a model that loops.
          </p>
        </>
      )}
    </Modal>
  );
}

/** A setting that is on or off, read as a row rather than as a form control. */
function Toggle({
  id,
  name,
  desc,
  on,
  onChange,
  mono,
}: {
  id: string;
  name: string;
  desc: string;
  on: boolean;
  onChange: (v: boolean) => void;
  mono?: boolean;
}) {
  return (
    <label className={`toggle-row ${on ? 'on' : ''}`} htmlFor={id}>
      <div>
        <span className={`tname ${mono ? 'mono' : ''}`}>{name}</span>
        <span className="tdesc">{desc}</span>
      </div>
      <input id={id} type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
