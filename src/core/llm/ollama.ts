import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse, type ProviderCredentials } from './types';

/**
 * Local models through Ollama's /api/chat. Tool-calling works only with models
 * that support it (llama3.1+, qwen2.5-coder, mistral-nemo …); with a model that
 * does not, the executor still runs but the state's writes have to come from
 * the fallback text parse, which is why the UI warns about it.
 */
export function ollamaProvider(creds: ProviderCredentials): LlmProvider {
  const baseUrl = (creds.baseUrl || 'http://localhost:11434').replace(/\/$/, '');

  return {
    id: 'ollama',
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const messages: Record<string, unknown>[] = [{ role: 'system', content: req.system }];
      for (const m of req.messages) {
        if (m.role === 'tool') {
          messages.push({ role: 'tool', content: m.content });
          continue;
        }
        if (m.role === 'assistant') {
          const entry: Record<string, unknown> = { role: 'assistant', content: m.content || '' };
          if (m.toolCalls?.length) {
            entry.tool_calls = m.toolCalls.map((tc) => ({
              function: { name: tc.name, arguments: tc.args },
            }));
          }
          messages.push(entry);
          continue;
        }
        messages.push({ role: 'user', content: m.content });
      }

      const body: Record<string, unknown> = { model: req.model, messages, stream: false };
      if (req.temperature !== undefined) body.options = { temperature: req.temperature };
      if (!req.disableTools && req.tools.length) {
        body.tools = req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        }));
      }

      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (e) {
        // A cancelled run is not an unreachable Ollama: let it through as-is.
        if ((e as Error).name === 'AbortError') throw e;
        throw new LlmError(
          `Could not reach Ollama at ${baseUrl}. Is \`ollama serve\` running? (${(e as Error).message})`,
          undefined,
          'ollama',
        );
      }
      if (!res.ok) {
        throw new LlmError(`Ollama ${res.status}: ${await res.text()}`, res.status, 'ollama');
      }
      const json = (await res.json()) as {
        message?: {
          content?: string;
          tool_calls?: { function: { name: string; arguments: unknown } }[];
        };
        prompt_eval_count?: number;
        eval_count?: number;
        done_reason?: string;
      };

      const toolCalls = (json.message?.tool_calls ?? []).map((tc, i) => ({
        id: `ollama_${Date.now()}_${i}`,
        name: tc.function.name,
        args:
          typeof tc.function.arguments === 'string'
            ? (JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>)
            : ((tc.function.arguments ?? {}) as Record<string, unknown>),
      }));

      return {
        text: json.message?.content ?? '',
        toolCalls,
        stopReason: json.done_reason,
        usage: { inputTokens: json.prompt_eval_count, outputTokens: json.eval_count },
      };
    },
  };
}

/** Model list for the settings screen. */
export async function listOllamaModels(baseUrl?: string): Promise<string[]> {
  // A default parameter only covers `undefined`, and the address arrives from
  // a text field a user can empty — which produced `fetch('/api/tags')` and a
  // "failed to parse URL" where the honest answer was "you cleared the box".
  const root = (baseUrl ?? '').trim().replace(/\/+$/, '') || 'http://localhost:11434';
  const res = await fetch(`${root}/api/tags`).catch((e: unknown) => {
    throw new LlmError(
      `could not reach Ollama at ${root}: ${(e as Error).message}`,
      undefined,
      'ollama',
    );
  });
  if (!res.ok) throw new LlmError(`Ollama ${res.status}: ${await res.text()}`, res.status, 'ollama');
  const json = (await res.json()) as { models?: { name: string }[] };
  return (json.models ?? []).map((m) => m.name);
}
