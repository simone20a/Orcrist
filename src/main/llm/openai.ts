// Adattatore per le API chat/completions di OpenAI e per qualunque
// endpoint compatibile (Ollama, LM Studio, vLLM, llama.cpp server).

import type { ChatRequest, ChatResponse, LlmProvider, Message, ProviderCredentials, ToolCall } from './types.js';
import { LlmError, newCallId, postJson } from './types.js';

export function makeOpenAiCompatibleProvider(requiresKey: boolean): LlmProvider {
  return {
    async chat(req: ChatRequest, creds: ProviderCredentials): Promise<ChatResponse> {
      if (requiresKey && !creds.apiKey) throw new LlmError('OpenAI API key is missing.');

      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: req.maxTokens,
        messages: toOpenAiMessages(req.system, req.messages),
      };
      // Alcuni modelli di ragionamento accettano solo la temperatura
      // predefinita: non mandare il campo e' sempre lecito.
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.tools.length) {
        body.tools = req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.schema },
        }));
        body.tool_choice = req.forceTool
          ? { type: 'function', function: { name: req.forceTool } }
          : 'auto';
      }

      const base = creds.baseUrl.replace(/\/$/, '');
      const url = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      const headers: Record<string, string> = {};
      if (creds.apiKey) headers.authorization = `Bearer ${creds.apiKey}`;

      const json = await postJson(url, headers, body, req.signal);
      const choice = json.choices?.[0];
      const msg = choice?.message ?? {};
      const text: string = msg.content ?? '';

      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any) => ({
        id: c.id ?? newCallId(),
        name: c.function?.name ?? '',
        input: safeParse(c.function?.arguments),
      }));

      if (text) req.onDelta?.(text);
      return { text, toolCalls, stopReason: choice?.finish_reason ?? 'stop' };
    },
  };
}

export const openaiProvider = makeOpenAiCompatibleProvider(true);
export const localProvider = makeOpenAiCompatibleProvider(false);

function toOpenAiMessages(system: string, messages: Message[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant', content: m.content || null };
      if (m.toolCalls.length) {
        entry.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        }));
      }
      out.push(entry);
    } else {
      out.push({ role: 'tool', tool_call_id: m.callId, content: m.content });
    }
  }
  return out;
}

function safeParse(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
