// Adattatore Google Gemini (generateContent).

import type {
  ChatRequest,
  ChatResponse,
  JsonSchema,
  LlmProvider,
  Message,
  ProviderCredentials,
  ToolCall,
} from './types.js';
import { LlmError, newCallId, postJson } from './types.js';

export const geminiProvider: LlmProvider = {
  async chat(req: ChatRequest, creds: ProviderCredentials): Promise<ChatResponse> {
    if (!creds.apiKey) throw new LlmError('Google API key is missing.');

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages),
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      },
    };

    if (req.tools.length) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: stripUnsupported(t.schema),
          })),
        },
      ];
      body.toolConfig = {
        functionCallingConfig: req.forceTool
          ? { mode: 'ANY', allowedFunctionNames: [req.forceTool] }
          : { mode: 'AUTO' },
      };
    }

    const base = creds.baseUrl.replace(/\/$/, '');
    const url = `${base}/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(creds.apiKey)}`;

    const json = await postJson(url, {}, body, req.signal);
    const candidate = json.candidates?.[0];
    const parts: any[] = candidate?.content?.parts ?? [];

    const text = parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    const toolCalls: ToolCall[] = parts
      .filter((p) => p.functionCall)
      .map((p) => ({
        id: newCallId('gem'),
        name: p.functionCall.name ?? '',
        input: p.functionCall.args ?? {},
      }));

    if (text) req.onDelta?.(text);
    return { text, toolCalls, stopReason: candidate?.finishReason ?? 'STOP' };
  },
};

function toGeminiContents(messages: Message[]): unknown[] {
  const out: Array<{ role: string; parts: unknown[] }> = [];
  // Gemini identifica la risposta di un tool per nome, non per id:
  // teniamo la corrispondenza id -> nome mentre scorriamo.
  const nameById = new Map<string, string>();

  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: m.content }] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts: unknown[] = [];
      if (m.content.trim()) parts.push({ text: m.content });
      for (const c of m.toolCalls) {
        nameById.set(c.id, c.name);
        parts.push({ functionCall: { name: c.name, args: c.input } });
      }
      if (parts.length) out.push({ role: 'model', parts });
      continue;
    }
    const part = {
      functionResponse: {
        name: nameById.get(m.callId) ?? m.name,
        response: { result: m.content },
      },
    };
    const last = out[out.length - 1];
    if (last && last.role === 'user' && last.parts.every((p) => 'functionResponse' in (p as object))) {
      last.parts.push(part);
    } else {
      out.push({ role: 'user', parts: [part] });
    }
  }
  return out;
}

/** Gemini rifiuta additionalProperties nei parametri delle funzioni. */
function stripUnsupported(schema: JsonSchema): JsonSchema {
  const { additionalProperties, ...rest } = schema;
  const out: JsonSchema = { ...rest };
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([k, v]) => [k, stripUnsupported(v)]),
    );
  }
  if (out.items) out.items = stripUnsupported(out.items);
  return out;
}
