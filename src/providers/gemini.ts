import { z } from 'zod';
import type { GeminiProfile } from '../config.js';
import { getApiKey } from '../config.js';
import type { ChatInput, ChatResult, Message, Provider, ToolCall } from '../types.js';
import { ProviderError } from './errors.js';

const GeminiFunctionCallSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()).optional().default({}),
});

const GeminiPartSchema = z.object({
  text: z.string().optional(),
  functionCall: GeminiFunctionCallSchema.optional(),
});

const GeminiCandidateSchema = z.object({
  content: z
    .object({
      parts: z.array(GeminiPartSchema).default([]),
      role: z.string().optional(),
    })
    .optional(),
  finishReason: z.string().optional(),
});

const GeminiResponseSchema = z.object({
  candidates: z.array(GeminiCandidateSchema).optional().default([]),
  promptFeedback: z.unknown().optional(),
});

interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<Record<string, unknown>>;
}

function cleanGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema, ...rest } = schema;
  return rest;
}

function formatMessages(messages: Message[]): GeminiContent[] {
  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    let role: 'user' | 'model';
    const parts: Array<Record<string, unknown>> = [];

    if (msg.role === 'user') {
      role = 'user';
      parts.push({ text: msg.content });
    } else if (msg.role === 'assistant') {
      role = 'model';
      if (msg.content) {
        parts.push({ text: msg.content });
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          parts.push({
            functionCall: {
              name: tc.name,
              args: tc.args ?? {},
            },
          });
        }
      }
      if (parts.length === 0) {
        parts.push({ text: '' });
      }
    } else if (msg.role === 'tool') {
      role = 'user';
      parts.push({
        functionResponse: {
          name: msg.name,
          response: {
            content: msg.content,
            ...(msg.isError ? { error: true } : {}),
          },
        },
      });
    } else {
      continue;
    }

    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }

  return contents;
}

export class GeminiProvider implements Provider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKeyEnv: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;

  constructor(
    profile: GeminiProfile,
    options: { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.name = `gemini:${profile.model}`;
    this.baseUrl = profile.baseUrl.replace(/\/+$/, '');
    this.model = profile.model.replace(/^models\//, '');
    this.apiKeyEnv = profile.apiKeyEnv;
    this.apiKey = getApiKey(profile, options.env);
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    if (!this.apiKey) {
      throw new ProviderError(`Environment variable ${this.apiKeyEnv} is not set`);
    }

    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;
    const contents = formatMessages(input.messages);

    const body: Record<string, unknown> = {
      contents,
    };

    if (input.system && input.system.trim()) {
      body.systemInstruction = {
        parts: [{ text: input.system }],
      };
    }

    if (input.tools && input.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: input.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: cleanGeminiSchema(t.parameters),
          })),
        },
      ];
    }

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: input.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new ProviderError(`Failed to connect to Gemini at ${url}: ${err instanceof Error ? err.message : String(err)}`);
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
      throw new ProviderError(`Gemini error: ${errMsg}`, res.status);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ProviderError('Gemini returned invalid JSON');
    }

    const parsed = GeminiResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError(`Unexpected response format from Gemini: ${parsed.error.message}`);
    }

    const candidate = parsed.data.candidates[0];
    if (!candidate) {
      return {
        text: '',
        toolCalls: [],
        stopReason: 'error',
      };
    }

    let text = '';
    const toolCalls: ToolCall[] = [];

    for (const part of candidate.content?.parts ?? []) {
      if (part.text) {
        text += part.text;
      }
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${toolCalls.length}_${Math.random().toString(36).slice(2, 9)}`,
          name: part.functionCall.name,
          args: part.functionCall.args,
        });
      }
    }

    let stopReason: ChatResult['stopReason'] = 'end';
    if (toolCalls.length > 0) {
      stopReason = 'tool_use';
    } else if (candidate.finishReason === 'MAX_TOKENS') {
      stopReason = 'max_tokens';
    } else if (candidate.finishReason && candidate.finishReason !== 'STOP') {
      stopReason = 'error';
    }

    return {
      text,
      toolCalls,
      stopReason,
    };
  }
}
