import { z } from 'zod';
import type { OllamaProfile } from '../config.js';
import type { ChatInput, ChatResult, Message, Provider, ToolCall } from '../types.js';
import { ProviderError } from './errors.js';

const OllamaToolCallSchema = z.object({
  function: z.object({
    name: z.string(),
    arguments: z.unknown(),
  }),
});

const OllamaResponseSchema = z.object({
  message: z.object({
    role: z.string(),
    content: z.string().default(''),
    tool_calls: z.array(OllamaToolCallSchema).optional(),
  }),
  done: z.boolean().optional(),
  done_reason: z.string().optional(),
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
  private readonly fetchFn: typeof fetch;

  constructor(profile: OllamaProfile, options: { fetchFn?: typeof fetch } = {}) {
    this.name = `ollama:${profile.model}`;
    this.baseUrl = profile.baseUrl.replace(/\/+$/, '');
    this.model = profile.model;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    const url = `${this.baseUrl}/api/chat`;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: formatMessages(input.system, input.messages),
      stream: false,
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

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: input.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new ProviderError(`Failed to connect to Ollama at ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }

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

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ProviderError('Ollama returned invalid JSON');
    }

    const parsed = OllamaResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError(`Unexpected response format from Ollama: ${parsed.error.message}`);
    }

    const { message, done_reason } = parsed.data;
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
}
