import { z } from 'zod';
import type { ClaudeProfile } from '../config.js';
import { getApiKey } from '../config.js';
import type { ChatInput, ChatResult, Message, Provider, ToolCall } from '../types.js';
import { ProviderError } from './errors.js';

const ClaudeContentBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
]);

const ClaudeResponseSchema = z.object({
  id: z.string().optional(),
  type: z.literal('message').optional(),
  role: z.literal('assistant').optional(),
  content: z.array(ClaudeContentBlockSchema).default([]),
  stop_reason: z.string().nullable().optional(),
});

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

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

function formatMessages(messages: Message[]): ClaudeMessage[] {
  const result: ClaudeMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const last = result[result.length - 1];
      if (last && last.role === 'user') {
        if (Array.isArray(last.content)) {
          last.content.push({ type: 'text', text: msg.content });
        } else {
          last.content = [{ type: 'text', text: last.content }, { type: 'text', text: msg.content }];
        }
      } else {
        result.push({ role: 'user', content: msg.content });
      }
    } else if (msg.role === 'assistant') {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const blocks: Array<Record<string, unknown>> = [];
        if (msg.content) {
          blocks.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.args ?? {},
          });
        }
        result.push({ role: 'assistant', content: blocks });
      } else {
        result.push({ role: 'assistant', content: msg.content });
      }
    } else if (msg.role === 'tool') {
      const toolResultBlock: Record<string, unknown> = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: msg.content,
      };
      if (msg.isError) {
        toolResultBlock.is_error = true;
      }

      const last = result[result.length - 1];
      if (last && last.role === 'user') {
        if (Array.isArray(last.content)) {
          last.content.push(toolResultBlock);
        } else {
          last.content = [{ type: 'text', text: last.content }, toolResultBlock];
        }
      } else {
        result.push({ role: 'user', content: [toolResultBlock] });
      }
    }
  }

  return result;
}

export class ClaudeProvider implements Provider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKeyEnv: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;

  constructor(
    profile: ClaudeProfile,
    options: { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.name = `claude:${profile.model}`;
    this.baseUrl = profile.baseUrl.replace(/\/+$/, '');
    this.model = profile.model;
    this.apiKeyEnv = profile.apiKeyEnv;
    this.apiKey = getApiKey(profile, options.env);
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    if (!this.apiKey) {
      throw new ProviderError(`Environment variable ${this.apiKeyEnv} is not set`);
    }

    const url = `${this.baseUrl}/v1/messages`;
    const formattedMessages = formatMessages(input.messages);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      messages: formattedMessages,
    };

    if (input.system && input.system.trim()) {
      body.system = input.system;
    }

    if (input.tools && input.tools.length > 0) {
      body.tools = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: input.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new ProviderError(`Failed to connect to Claude at ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      let errMsg = `HTTP ${res.status} ${res.statusText}`;
      try {
        const json = await res.json();
        if (json && typeof json === 'object') {
          if ('error' in json && json.error && typeof json.error === 'object' && 'message' in json.error) {
            errMsg = String(json.error.message);
          }
        }
      } catch {
        // ignore
      }
      throw new ProviderError(`Claude error: ${errMsg}`, res.status);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ProviderError('Claude returned invalid JSON');
    }

    const parsed = ClaudeResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError(`Unexpected response format from Claude: ${parsed.error.message}`);
    }

    let text = '';
    const toolCalls: ToolCall[] = [];

    for (const block of parsed.data.content) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: parseArguments(block.input),
        });
      }
    }

    let stopReason: ChatResult['stopReason'] = 'end';
    if (toolCalls.length > 0 || parsed.data.stop_reason === 'tool_use') {
      stopReason = 'tool_use';
    } else if (parsed.data.stop_reason === 'max_tokens') {
      stopReason = 'max_tokens';
    }

    return {
      text,
      toolCalls,
      stopReason,
    };
  }
}
