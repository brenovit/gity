import { z } from 'zod';
import type { LmStudioProfile } from '../config.js';
import { getApiKey } from '../config.js';
import type { ChatInput, ChatResult, Message, Provider, ToolCall } from '../types.js';
import { ProviderError } from './errors.js';

const OpenAiToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  function: z.object({
    name: z.string(),
    arguments: z.unknown(),
  }),
});

const OpenAiResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          role: z.string().optional(),
          content: z.string().nullable().optional(),
          tool_calls: z.array(OpenAiToolCallSchema).optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1, 'Expected at least one choice in response'),
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
        content: msg.content || null,
      };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        entry.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args),
          },
        }));
      }
      formatted.push(entry);
    } else if (msg.role === 'tool') {
      formatted.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content,
      });
    }
  }

  return formatted;
}

export class LmStudioProvider implements Provider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;

  constructor(
    profile: LmStudioProfile,
    options: { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.name = `lmstudio:${profile.model}`;
    this.baseUrl = profile.baseUrl.replace(/\/+$/, '');
    this.model = profile.model;
    this.apiKey = getApiKey(profile, options.env);
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    const url = this.baseUrl.endsWith('/v1')
      ? `${this.baseUrl}/chat/completions`
      : `${this.baseUrl}/v1/chat/completions`;

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

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: input.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new ProviderError(`Failed to connect to LM Studio at ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      let errMsg = `HTTP ${res.status} ${res.statusText}`;
      try {
        const json = await res.json();
        if (json && typeof json === 'object') {
          if ('error' in json) {
            const errVal = json.error;
            if (typeof errVal === 'string') errMsg = errVal;
            else if (errVal && typeof errVal === 'object' && 'message' in errVal && typeof errVal.message === 'string') {
              errMsg = errVal.message;
            }
          }
        }
      } catch {
        // ignore
      }
      throw new ProviderError(`LM Studio error: ${errMsg}`, res.status);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ProviderError('LM Studio returned invalid JSON');
    }

    const parsed = OpenAiResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError(`Unexpected response format from LM Studio: ${parsed.error.message}`);
    }

    const choice = parsed.data.choices[0];
    if (!choice) {
      throw new ProviderError('LM Studio returned an empty choices array');
    }

    const { message, finish_reason } = choice;
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc, index) => ({
      id: tc.id || `call_${index}_${Math.random().toString(36).slice(2, 9)}`,
      name: tc.function.name,
      args: parseArguments(tc.function.arguments),
    }));

    let stopReason: ChatResult['stopReason'] = 'end';
    if (toolCalls.length > 0 || finish_reason === 'tool_calls') {
      stopReason = 'tool_use';
    } else if (finish_reason === 'length') {
      stopReason = 'max_tokens';
    }

    return {
      text: message.content ?? '',
      toolCalls,
      stopReason,
    };
  }
}
