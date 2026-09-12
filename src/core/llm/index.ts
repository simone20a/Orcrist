import type { ProviderId, LlmProvider } from './types';
import type { ProviderSettings, Settings } from '../types';
import { anthropicProvider } from './anthropic';
import { openaiProvider } from './openai';
import { ollamaProvider } from './ollama';

export * from './types';
export { listOllamaModels } from './ollama';

function credsFor(ps: ProviderSettings | undefined) {
  return { apiKey: ps?.apiKey, baseUrl: ps?.baseUrl };
}

export function makeProvider(id: ProviderId, settings: Settings): LlmProvider {
  const creds = credsFor(settings.providers[id]);
  switch (id) {
    case 'anthropic':
      return anthropicProvider(creds);
    case 'openai':
      return openaiProvider(creds);
    case 'ollama':
      return ollamaProvider(creds);
  }
}

export function providerLabel(id: ProviderId): string {
  return id === 'anthropic' ? 'Anthropic' : id === 'openai' ? 'OpenAI' : 'Ollama (local)';
}
