// =====================================================================
// Chiavi API ed endpoint.
//
// Le chiavi vengono cifrate con safeStorage — portachiavi di sistema su
// macOS, DPAPI su Windows, libsecret su Linux — e non lasciano mai il
// main process: al renderer va solo il fatto che una chiave esista.
// Se il sistema non offre cifratura si rifiuta di scrivere in chiaro.
// =====================================================================

import { app, safeStorage } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { CredentialId, Preferences, ProviderId, ProviderSettings, SettingsView } from '../../shared/protocol.js';
import { PROVIDERS, WEB_SEARCH } from '../../shared/protocol.js';

/** Provider LLM piu' la ricerca web: tutto cio' che ha una chiave. */
const ALL_CREDENTIALS = [...PROVIDERS, WEB_SEARCH];

interface StoredProvider {
  /** chiave cifrata, base64 */
  key?: string;
  baseUrl?: string;
}

interface SettingsFile {
  version: 1;
  providers: Partial<Record<CredentialId, StoredProvider>>;
  /** scelte da riproporre alla creazione del prossimo progetto */
  preferences?: Preferences;
}

let cache: SettingsFile | undefined;

function filePath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function load(): Promise<SettingsFile> {
  if (cache) return cache;
  const p = filePath();
  if (!existsSync(p)) {
    cache = { version: 1, providers: {}, preferences: {} };
    return cache;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(p, 'utf8')) as SettingsFile;
    cache = { version: 1, providers: parsed.providers ?? {}, preferences: parsed.preferences ?? {} };
  } catch {
    cache = { version: 1, providers: {}, preferences: {} };
  }
  return cache;
}

async function save(): Promise<void> {
  if (!cache) return;
  const p = filePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, p);
}

export async function readSettings(): Promise<SettingsView> {
  const f = await load();
  const view = {} as SettingsView;
  for (const info of ALL_CREDENTIALS) {
    const stored = f.providers[info.id];
    const entry: ProviderSettings = {
      hasKey: !!stored?.key,
      baseUrl: stored?.baseUrl ?? info.defaultBaseUrl,
    };
    view[info.id] = entry;
  }
  return view;
}

export async function setKey(provider: CredentialId, key: string): Promise<SettingsView> {
  const f = await load();
  const trimmed = key.trim();
  if (!trimmed) return clearKey(provider);
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Il sistema non offre un archivio cifrato: Orcrist non salva chiavi API in chiaro. ' +
        'Su Linux serve un portachiavi attivo (gnome-keyring o kwallet).',
    );
  }
  f.providers[provider] = {
    ...f.providers[provider],
    key: safeStorage.encryptString(trimmed).toString('base64'),
  };
  await save();
  return readSettings();
}

export async function clearKey(provider: CredentialId): Promise<SettingsView> {
  const f = await load();
  if (f.providers[provider]) delete f.providers[provider]!.key;
  await save();
  return readSettings();
}

export async function setBaseUrl(provider: CredentialId, baseUrl: string): Promise<SettingsView> {
  const f = await load();
  const info = ALL_CREDENTIALS.find((p) => p.id === provider);
  f.providers[provider] = {
    ...f.providers[provider],
    baseUrl: baseUrl.trim() || info?.defaultBaseUrl,
  };
  await save();
  return readSettings();
}

/** Usata solo dal main: restituisce la chiave in chiaro. */
export async function credentialsFor(provider: CredentialId): Promise<{ apiKey?: string; baseUrl: string }> {
  const f = await load();
  const info = ALL_CREDENTIALS.find((p) => p.id === provider);
  const stored = f.providers[provider];
  let apiKey: string | undefined;
  if (stored?.key) {
    try {
      apiKey = safeStorage.decryptString(Buffer.from(stored.key, 'base64'));
    } catch {
      apiKey = undefined;
    }
  }
  return { apiKey, baseUrl: stored?.baseUrl ?? info?.defaultBaseUrl ?? '' };
}

// --- preferenze -------------------------------------------------------

/**
 * Le scelte fatte all'ultima creazione. Non sono segreti, ma stanno
 * qui perche' e' lo stesso file e la stessa cache.
 */
export async function readPreferences(): Promise<Preferences> {
  const f = await load();
  return { ...(f.preferences ?? {}) };
}

export async function writePreferences(patch: Partial<Preferences>): Promise<Preferences> {
  const f = await load();
  f.preferences = { ...(f.preferences ?? {}), ...patch };
  await save();
  return { ...f.preferences };
}

/**
 * Il primo provider che ha gia' una chiave, cosi' la finestra di
 * creazione non propone un provider inutilizzabile a chi ne ha
 * configurato un altro.
 */
export async function firstConfiguredProvider(): Promise<ProviderId | undefined> {
  const f = await load();
  for (const info of PROVIDERS) {
    if (!info.needsKey || f.providers[info.id]?.key) return info.id;
  }
  return undefined;
}
