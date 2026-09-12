import { LlmError, transportError, type LlmMessage, type LlmProvider, type LlmRequest, type LlmResponse, type ProviderCredentials, type ToolCall } from './types';

/**
 * OpenAI, over two endpoints.
 *
 * `/v1/chat/completions` is the default. The reasoning models (gpt-5.x and
 * friends) refuse function tools there unless reasoning is switched off, and
 * tell you to use `/v1/responses` instead — so when we see that, we switch to
 * the Responses API and stay on it for the rest of the session rather than
 * paying for the failed round trip on every call. Turning reasoning off would
 * also have worked, and would have been the worse trade: this app leans on the
 * model to plan a state's work, which is exactly what reasoning is for.
 */
export function openaiProvider(creds: ProviderCredentials): LlmProvider {
  const baseUrl = (creds.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  let useResponses = false;

  return {
    id: 'openai',
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const token = creds.apiKey;
      if (!token) {
        throw new LlmError('No OpenAI API key configured (Settings → Providers).', 401, 'openai');
      }
      const headers = {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      };

      if (!useResponses) {
        const attempt = await postWithParamDrop(
          `${baseUrl}/chat/completions`,
          headers,
          chatBody(req),
          req.signal,
        );
        if (attempt.ok) return parseChat(await attempt.res.json());

        // "To use function tools, use /v1/responses …"
        if (attempt.status === 400 && /v1\/responses/.test(attempt.text)) {
          useResponses = true;
        } else {
          throw new LlmError(
            `OpenAI ${attempt.status}: ${attempt.text}` + attempt.note,
            attempt.status,
            'openai',
          );
        }
      }

      const attempt = await postWithParamDrop(
        `${baseUrl}/responses`,
        headers,
        responsesBody(req),
        req.signal,
      );
      if (!attempt.ok) {
        throw new LlmError(
          `OpenAI ${attempt.status}: ${attempt.text}` + attempt.note,
          attempt.status,
          'openai',
        );
      }
      return parseResponses(await attempt.res.json());
    },
  };
}

// --- request shaping ----------------------------------------------------

function chatBody(req: LlmRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant', content: m.content || null };
      if (m.toolCalls?.length) {
        entry.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        }));
      }
      messages.push(entry);
      continue;
    }
    messages.push({ role: 'user', content: m.content });
  }

  const body: Record<string, unknown> = { model: req.model, messages };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens) body.max_completion_tokens = req.maxTokens;
  if (!req.disableTools && req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  return body;
}

function responsesBody(req: LlmRequest): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  for (const m of req.messages as LlmMessage[]) {
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.content) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      }
      for (const tc of m.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.args),
        });
      }
      continue;
    }
    input.push({ role: 'user', content: [{ type: 'input_text', text: m.content }] });
  }

  const body: Record<string, unknown> = {
    model: req.model,
    instructions: req.system,
    input,
    // Nothing here depends on server-side threading — the full history is sent
    // every call — and this app handles the user's own source, so don't leave
    // it sitting in the provider's response store.
    store: false,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens) body.max_output_tokens = req.maxTokens;
  if (!req.disableTools && req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }
  return body;
}

// --- transport ----------------------------------------------------------

interface Attempt {
  ok: boolean;
  status: number;
  text: string;
  res: Response;
  note: string;
}

/**
 * OpenAI's model families disagree about which parameters they accept — the
 * reasoning models reject any `temperature` but the default, older ones want
 * `max_tokens` rather than `max_completion_tokens`. Rather than keep a table of
 * which model takes what (which goes stale), drop whatever parameter a 400
 * names and try again: the request is worth more than the parameter.
 */
async function postWithParamDrop(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Attempt> {
  const dropped: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal }).catch(
      (e: unknown) => transportError(e, 'OpenAI', url),
    );
    if (res.ok) {
      return { ok: true, status: res.status, text: '', res, note: '' };
    }
    const text = await res.text();
    const note = dropped.length ? ` (after dropping ${dropped.join(', ')})` : '';
    if (res.status !== 400) return { ok: false, status: res.status, text, res, note };

    let param: string | undefined;
    try {
      param = (JSON.parse(text) as { error?: { param?: string | null } }).error?.param ?? undefined;
    } catch {
      param = undefined;
    }
    // Only a parameter we actually sent can be dropped. A 400 naming something
    // else (a model default, say) is a real error for the caller to read.
    if (!param || !(param in body)) {
      return { ok: false, status: 400, text, res, note };
    }
    delete body[param];
    dropped.push(param);
  }
  throw new LlmError('OpenAI: too many rejected parameters in one request.', 400, 'openai');
}

// --- response parsing ---------------------------------------------------

function parseChat(json: unknown): LlmResponse {
  const j = json as {
    choices?: {
      message: {
        content?: string | null;
        tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      };
      finish_reason?: string;
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = j.choices?.[0];
  const toolCalls: ToolCall[] = (choice?.message.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    args: safeArgs(tc.function.arguments),
  }));
  return {
    text: choice?.message.content ?? '',
    toolCalls,
    stopReason: choice?.finish_reason,
    usage: {
      inputTokens: j.usage?.prompt_tokens,
      outputTokens: j.usage?.completion_tokens,
    },
  };
}

function parseResponses(json: unknown): LlmResponse {
  const j = json as {
    output?: {
      type: string;
      call_id?: string;
      id?: string;
      name?: string;
      arguments?: string;
      content?: { type: string; text?: string }[];
    }[];
    output_text?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    status?: string;
    incomplete_details?: { reason?: string };
  };

  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const item of j.output ?? []) {
    if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text') text += c.text ?? '';
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? item.id ?? '',
        name: item.name ?? '',
        args: safeArgs(item.arguments),
      });
    }
    // 'reasoning' items are summaries of the model's own thinking; nothing here
    // needs them, and they are not required on the way back in.
  }
  if (!text && typeof j.output_text === 'string') text = j.output_text;

  return {
    text,
    toolCalls,
    stopReason: j.incomplete_details?.reason ?? j.status,
    usage: {
      inputTokens: j.usage?.input_tokens,
      outputTokens: j.usage?.output_tokens,
    },
  };
}

function safeArgs(raw: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return { _raw: raw };
  }
}
