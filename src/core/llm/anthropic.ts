import { LlmError, transportError, type LlmProvider, type LlmRequest, type LlmResponse, type ProviderCredentials } from './types';

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export function anthropicProvider(creds: ProviderCredentials): LlmProvider {
  const baseUrl = (creds.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');

  return {
    id: 'anthropic',
    async complete(req: LlmRequest): Promise<LlmResponse> {
      if (!creds.apiKey) {
        throw new LlmError('No Anthropic API key configured (Settings → Providers).', 401, 'anthropic');
      }

      // Fold the neutral message list into Anthropic's content-block shape.
      const messages: { role: 'user' | 'assistant'; content: unknown }[] = [];
      for (const m of req.messages) {
        if (m.role === 'tool') {
          const block = {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: m.content,
            is_error: m.isError ?? false,
          };
          const last = messages[messages.length - 1];
          if (last && last.role === 'user' && Array.isArray(last.content)) {
            (last.content as unknown[]).push(block);
          } else {
            messages.push({ role: 'user', content: [block] });
          }
          continue;
        }
        if (m.role === 'assistant') {
          const content: unknown[] = [];
          if (m.content) content.push({ type: 'text', text: m.content });
          for (const tc of m.toolCalls ?? []) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
          }
          messages.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no output)' }] });
          continue;
        }
        // Anthropic requires alternating roles. A state's prompt arrives right
        // after the previous state's tool results, so fold it into that same
        // user turn rather than emitting two user messages in a row.
        const prev = messages[messages.length - 1];
        if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
          (prev.content as unknown[]).push({ type: 'text', text: m.content });
        } else {
          messages.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
        }
      }

      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: req.maxTokens ?? 8192,
        system: req.system,
        messages,
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (!req.disableTools && req.tools.length) {
        body.tools = req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        }));
      }

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      headers['x-api-key'] = creds.apiKey;

      const url = `${baseUrl}/v1/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      }).catch((e: unknown) => transportError(e, 'Anthropic', url));
      if (!res.ok) {
        throw new LlmError(`Anthropic ${res.status}: ${await res.text()}`, res.status, 'anthropic');
      }
      const json = (await res.json()) as {
        content: AnthropicBlock[];
        usage?: { input_tokens?: number; output_tokens?: number };
        stop_reason?: string;
      };

      let text = '';
      const toolCalls = [];
      for (const block of json.content ?? []) {
        if (block.type === 'text') text += block.text ?? '';
        if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id!, name: block.name!, args: block.input ?? {} });
        }
      }
      return {
        text,
        toolCalls,
        stopReason: json.stop_reason,
        usage: {
          inputTokens: json.usage?.input_tokens,
          outputTokens: json.usage?.output_tokens,
        },
      };
    },
  };
}
