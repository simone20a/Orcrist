import type { ProviderId } from '../../shared/protocol.js';
import { anthropicProvider } from './anthropic.js';
import { geminiProvider } from './gemini.js';
import { localProvider, openaiProvider } from './openai.js';
import type { LlmProvider } from './types.js';

const registry: Record<ProviderId, LlmProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  local: localProvider,
};

export function getProvider(id: ProviderId): LlmProvider {
  const p = registry[id];
  if (!p) throw new Error(`Provider sconosciuto: ${id}`);
  return p;
}

export * from './types.js';
