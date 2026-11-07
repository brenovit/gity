import { z } from 'zod';
import type { OllamaProfile } from '../config.js';
import type { ChatInput, ChatResult, Message, Provider, ToolCall } from '../types.js';
import { ProviderError } from './errors.js';
import { fetchWithRetry, readLines, type HttpRequestOptions } from './http.js';

const OllamaToolCallSchema = z.object({
  function: z.object({
    name: z.string(),
    arguments: z.unknown(),
  }),
});

const OllamaResponseSchema = z.object({
  message: z
    .object({
      role: z.string().optional(),
      content: z.string().default(''),
      tool_calls: z.array(OllamaToolCallSchema).optional(),
    })
    .optional(),
  done: z.boolean().optional(),
  done_reason: z.string().optional(),
  error: z.string().optional(),
});

function parseArguments(args: unknown): Record<string, unknown> {
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { raw: args };
    }
  }
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

function formatMessages(system: string | undefined, messages: Message[]) {
  const formatted: Array<Record<string, unknown>> = [];

  if (system && system.trim()) {
    formatted.push({ role: 'system', content: system });
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      formatted.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const entry: Record<string, unknown> = {
        role: 'assistant',
        content: msg.content,
      };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        entry.tool_calls = msg.toolCalls.map((tc) => ({
          function: {
            name: tc.name,
            arguments: tc.args,
          },
        }));
      }
      formatted.push(entry);
    } else if (msg.role === 'tool') {
      formatted.push({
        role: 'tool',
        content: msg.content,
      });
    }
  }

  return formatted;
}

export class OllamaProvider implements Provider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly httpOptions: HttpRequestOptions;

  constructor(profile: OllamaProfile, options: HttpRequestOptions = {}) {
    this.name = `ollama:${profile.model}`;
    this.baseUrl = profile.baseUrl.replace(/\/+$/, '');
    this.model = profile.model;
    this.httpOptions = options;
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    const url = `${this.baseUrl}/api/chat`;
    const shouldStream = Boolean(input.onTextDelta);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: formatMessages(input.system, input.messages),
      stream: shouldStream,
    };

    if (input.tools && input.tools.length > 0) {
      body.tools = input.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      },
      {
        ...this.httpOptions,
        providerLabel: 'Ollama',
        signal: input.signal,
      },
    );

    if (!res.ok) {
      let errMsg = `HTTP ${res.status} ${res.statusText}`;
      try {
        const json = await res.json();
        if (json && typeof json === 'object' && 'error' in json && typeof json.error === 'string') {
          errMsg = json.error;
        }
      } catch {
        // ignore
      }
      throw new ProviderError(`Ollama error: ${errMsg}`, res.status);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (shouldStream && res.body && contentType.includes('ndjson')) {
      return this.readNdjsonStream(res.body, input.onTextDelta, input.signal);
    }

    const rawText = await res.text();
    const lines = rawText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (shouldStream && lines.length > 1) {
      return this.parseChunkLines(lines, input.onTextDelta);
    }

    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      throw new ProviderError('Ollama returned invalid JSON');
    }

    const parsed = OllamaResponseSchema.safeParse(json);
    if (!parsed.success || !parsed.data.message) {
      const detail = !parsed.success ? parsed.error.message : 'missing message field';
      throw new ProviderError(`Unexpected response format from Ollama: ${detail}`);
    }

    const { message, done_reason } = parsed.data;
    if (message.content && input.onTextDelta) {
      input.onTextDelta(message.content);
    }
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc, index) => ({
      id: `call_${index}_${Math.random().toString(36).slice(2, 9)}`,
      name: tc.function.name,
      args: parseArguments(tc.function.arguments),
    }));

    let stopReason: ChatResult['stopReason'] = 'end';
    if (toolCalls.length > 0) {
      stopReason = 'tool_use';
    } else if (done_reason === 'length') {
      stopReason = 'max_tokens';
    }

    return {
      text: message.content,
      toolCalls,
      stopReason,
    };
  }

  private async readNdjsonStream(
    body: ReadableStream<Uint8Array>,
    onTextDelta: ((delta: string) => void) | undefined,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const lines: string[] = [];
    for await (const line of readLines(body, signal)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      lines.push(trimmed);
      let json: unknown;
      try {
        json = JSON.parse(trimmed);
      } catch {
        throw new ProviderError('Ollama returned invalid JSON in stream');
      }
      const parsed = OllamaResponseSchema.safeParse(json);
      if (parsed.success && parsed.data.message?.content) {
        onTextDelta?.(parsed.data.message.content);
      }
    }
    return this.parseChunkLines(lines, undefined);
  }

  private parseChunkLines(lines: string[], onTextDelta: ((delta: string) => void) | undefined): ChatResult {
    let text = '';
    const toolCalls: ToolCall[] = [];
    let doneReason: string | undefined;

    for (const line of lines) {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        throw new ProviderError('Ollama returned invalid JSON');
      }
      const parsed = OllamaResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new ProviderError(`Unexpected response format from Ollama: ${parsed.error.message}`);
      }
      if (parsed.data.error) {
        throw new ProviderError(`Ollama error: ${parsed.data.error}`);
      }
      const msg = parsed.data.message;
      if (msg?.content) {
        text += msg.content;
        onTextDelta?.(msg.content);
      }
      for (const tc of msg?.tool_calls ?? []) {
        toolCalls.push({
          id: `call_${toolCalls.length}_${Math.random().toString(36).slice(2, 9)}`,
          name: tc.function.name,
          args: parseArguments(tc.function.arguments),
        });
      }
      if (parsed.data.done_reason) {
        doneReason = parsed.data.done_reason;
      }
    }

    let stopReason: ChatResult['stopReason'] = 'end';
    if (toolCalls.length > 0) {
      stopReason = 'tool_use';
    } else if (doneReason === 'length') {
      stopReason = 'max_tokens';
    }

    return { text, toolCalls, stopReason };
  }
}
