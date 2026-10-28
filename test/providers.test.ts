import { describe, expect, it, vi } from 'vitest';
import { buildProfile } from '../src/config.js';
import {
  ClaudeProvider,
  createProvider,
  GeminiProvider,
  LmStudioProvider,
  OllamaProvider,
  ProviderError,
} from '../src/providers/index.js';
import type { ToolSpec } from '../src/types.js';

function fakeFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

const getTimeTool: ToolSpec = {
  name: 'get_time',
  description: 'Get current time in a specified timezone',
  parameters: {
    type: 'object',
    properties: {
      timezone: { type: 'string', description: 'IANA timezone name' },
    },
    required: ['timezone'],
  },
};

describe('createProvider factory', () => {
  it('creates the corresponding provider for each profile type', () => {
    expect(createProvider(buildProfile({ type: 'ollama', model: 'llama3.2' }))).toBeInstanceOf(OllamaProvider);
    expect(createProvider(buildProfile({ type: 'lmstudio', model: 'qwen' }))).toBeInstanceOf(LmStudioProvider);
    expect(createProvider(buildProfile({ type: 'claude', model: 'claude-3-5' }))).toBeInstanceOf(ClaudeProvider);
    expect(createProvider(buildProfile({ type: 'gemini', model: 'gemini-2.5-flash' }))).toBeInstanceOf(GeminiProvider);
  });
});

describe('OllamaProvider', () => {
  const profile = buildProfile({ type: 'ollama', model: 'llama3.2' });

  it('performs plain chat with system prompt and user message', async () => {
    const fetchFn = fakeFetch(200, {
      message: { role: 'assistant', content: 'pong' },
      done_reason: 'stop',
    });
    const provider = new OllamaProvider(profile, { fetchFn });

    const result = await provider.chat({
      system: 'You are a test assistant.',
      messages: [{ role: 'user', content: 'ping' }],
    });

    expect(result).toEqual({
      text: 'pong',
      toolCalls: [],
      stopReason: 'end',
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://localhost:11434/api/chat');
    expect(init?.method).toBe('POST');
    const sent = JSON.parse(init?.body as string);
    expect(sent).toEqual({
      model: 'llama3.2',
      messages: [
        { role: 'system', content: 'You are a test assistant.' },
        { role: 'user', content: 'ping' },
      ],
      stream: false,
    });
  });

  it('smoke test: executes tool-call workflow with fake get_time tool', async () => {
    const fetchFn = fakeFetch(200, {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            function: {
              name: 'get_time',
              arguments: { timezone: 'Europe/Paris' },
            },
          },
        ],
      },
    });
    const provider = new OllamaProvider(profile, { fetchFn });

    const result = await provider.chat({
      messages: [{ role: 'user', content: 'What time is it in Paris?' }],
      tools: [getTimeTool],
    });

    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe('get_time');
    expect(result.toolCalls[0]?.args).toEqual({ timezone: 'Europe/Paris' });

    // Verify tools sent in request
    const sent = JSON.parse(fetchFn.mock.calls[0]![1]?.body as string);
    expect(sent.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_time',
          description: 'Get current time in a specified timezone',
          parameters: getTimeTool.parameters,
        },
      },
    ]);

    // Feeding the tool result back
    const secondFetch = fakeFetch(200, {
      message: { role: 'assistant', content: 'It is 8 PM in Paris.' },
    });
    const secondProvider = new OllamaProvider(profile, { fetchFn: secondFetch });
    await secondProvider.chat({
      messages: [
        { role: 'user', content: 'What time is it in Paris?' },
        { role: 'assistant', content: '', toolCalls: result.toolCalls },
        { role: 'tool', toolCallId: result.toolCalls[0]!.id, name: 'get_time', content: '20:00' },
      ],
    });
    const secondSent = JSON.parse(secondFetch.mock.calls[0]![1]?.body as string);
    expect(secondSent.messages).toEqual([
      { role: 'user', content: 'What time is it in Paris?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            function: {
              name: 'get_time',
              arguments: { timezone: 'Europe/Paris' },
            },
          },
        ],
      },
      { role: 'tool', content: '20:00' },
    ]);
  });

  it('handles error response from Ollama', async () => {
    const fetchFn = fakeFetch(404, { error: "model 'llama3.2' not found" });
    const provider = new OllamaProvider(profile, { fetchFn });

    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      "Ollama error: model 'llama3.2' not found",
    );
  });

  it('rejects invalid response payload', async () => {
    const fetchFn = fakeFetch(200, { something_else: true });
    const provider = new OllamaProvider(profile, { fetchFn });

    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(ProviderError);
  });
});

describe('LmStudioProvider', () => {
  const profile = buildProfile({ type: 'lmstudio', model: 'qwen' });

  it('performs plain chat with authorization header if set', async () => {
    const fetchFn = fakeFetch(200, {
      choices: [
        {
          message: { role: 'assistant', content: 'pong' },
          finish_reason: 'stop',
        },
      ],
    });
    const provider = new LmStudioProvider(profile, {
      fetchFn,
      env: { LM_STUDIO_API_KEY: 'test-key' },
    });

    const result = await provider.chat({
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'ping' }],
    });

    expect(result).toEqual({
      text: 'pong',
      toolCalls: [],
      stopReason: 'end',
    });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
    const sent = JSON.parse(init?.body as string);
    expect(sent.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'ping' },
    ]);
  });

  it('smoke test: executes tool-call workflow with fake get_time tool', async () => {
    const fetchFn = fakeFetch(200, {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_123',
                type: 'function',
                function: {
                  name: 'get_time',
                  arguments: JSON.stringify({ timezone: 'UTC' }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const provider = new LmStudioProvider(profile, { fetchFn });

    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Time?' }],
      tools: [getTimeTool],
    });

    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toEqual([
      {
        id: 'call_123',
        name: 'get_time',
        args: { timezone: 'UTC' },
      },
    ]);

    // Feed tool result back
    const secondFetch = fakeFetch(200, {
      choices: [{ message: { role: 'assistant', content: 'UTC is 12:00' }, finish_reason: 'stop' }],
    });
    const secondProvider = new LmStudioProvider(profile, { fetchFn: secondFetch });
    await secondProvider.chat({
      messages: [
        { role: 'user', content: 'Time?' },
        { role: 'assistant', content: '', toolCalls: result.toolCalls },
        { role: 'tool', toolCallId: 'call_123', name: 'get_time', content: '12:00' },
      ],
    });
    const sent = JSON.parse(secondFetch.mock.calls[0]![1]?.body as string);
    expect(sent.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_123',
      content: '12:00',
    });
  });

  it('handles error response from LM Studio', async () => {
    const fetchFn = fakeFetch(500, { error: { message: 'Internal server error' } });
    const provider = new LmStudioProvider(profile, { fetchFn });

    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      'LM Studio error: Internal server error',
    );
  });
});

describe('ClaudeProvider', () => {
  const profile = buildProfile({ type: 'claude', model: 'claude-3-5' });

  it('fails fast when API key env var is missing', async () => {
    const provider = new ClaudeProvider(profile, { env: {} });
    await expect(provider.chat({ messages: [{ role: 'user', content: 'ping' }] })).rejects.toThrow(
      'Environment variable ANTHROPIC_API_KEY is not set',
    );
  });

  it('performs plain chat with system prompt and proper headers', async () => {
    const fetchFn = fakeFetch(200, {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'pong' }],
      stop_reason: 'end_turn',
    });
    const provider = new ClaudeProvider(profile, {
      fetchFn,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    });

    const result = await provider.chat({
      system: 'You are concise.',
      messages: [{ role: 'user', content: 'ping' }],
    });

    expect(result).toEqual({
      text: 'pong',
      toolCalls: [],
      stopReason: 'end',
    });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init?.headers).toMatchObject({
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
    });
    const sent = JSON.parse(init?.body as string);
    expect(sent.system).toBe('You are concise.');
    expect(sent.messages).toEqual([{ role: 'user', content: 'ping' }]);
  });

  it('smoke test: executes tool-call workflow with fake get_time tool', async () => {
    const fetchFn = fakeFetch(200, {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking time...' },
        {
          type: 'tool_use',
          id: 'toolu_abc',
          name: 'get_time',
          input: { timezone: 'Asia/Tokyo' },
        },
      ],
      stop_reason: 'tool_use',
    });
    const provider = new ClaudeProvider(profile, {
      fetchFn,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    });

    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Tokyo time?' }],
      tools: [getTimeTool],
    });

    expect(result.stopReason).toBe('tool_use');
    expect(result.text).toBe('Checking time...');
    expect(result.toolCalls).toEqual([
      {
        id: 'toolu_abc',
        name: 'get_time',
        args: { timezone: 'Asia/Tokyo' },
      },
    ]);

    // Verify tools translated to input_schema
    const sent = JSON.parse(fetchFn.mock.calls[0]![1]?.body as string);
    expect(sent.tools).toEqual([
      {
        name: 'get_time',
        description: getTimeTool.description,
        input_schema: getTimeTool.parameters,
      },
    ]);

    // Feed tool result back as tool_result content block in user role
    const secondFetch = fakeFetch(200, {
      id: 'msg_3',
      content: [{ type: 'text', text: 'It is 04:00 in Tokyo.' }],
      stop_reason: 'end_turn',
    });
    const secondProvider = new ClaudeProvider(profile, {
      fetchFn: secondFetch,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    });
    await secondProvider.chat({
      messages: [
        { role: 'user', content: 'Tokyo time?' },
        { role: 'assistant', content: 'Checking time...', toolCalls: result.toolCalls },
        { role: 'tool', toolCallId: 'toolu_abc', name: 'get_time', content: '04:00' },
      ],
    });
    const secondSent = JSON.parse(secondFetch.mock.calls[0]![1]?.body as string);
    expect(secondSent.messages).toEqual([
      { role: 'user', content: 'Tokyo time?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking time...' },
          { type: 'tool_use', id: 'toolu_abc', name: 'get_time', input: { timezone: 'Asia/Tokyo' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: '04:00' }],
      },
    ]);
  });

  it('handles API error from Claude', async () => {
    const fetchFn = fakeFetch(401, { error: { message: 'invalid x-api-key' } });
    const provider = new ClaudeProvider(profile, {
      fetchFn,
      env: { ANTHROPIC_API_KEY: 'bad-key' },
    });

    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      'Claude error: invalid x-api-key',
    );
  });
});

describe('GeminiProvider', () => {
  const profile = buildProfile({ type: 'gemini', model: 'gemini-2.5-flash' });

  it('fails fast when API key env var is missing', async () => {
    const provider = new GeminiProvider(profile, { env: {} });
    await expect(provider.chat({ messages: [{ role: 'user', content: 'ping' }] })).rejects.toThrow(
      'Environment variable GEMINI_API_KEY is not set',
    );
  });

  it('performs plain chat with system instruction and user content', async () => {
    const fetchFn = fakeFetch(200, {
      candidates: [
        {
          content: {
            parts: [{ text: 'pong' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    });
    const provider = new GeminiProvider(profile, {
      fetchFn,
      env: { GEMINI_API_KEY: 'test-gemini-key' },
    });

    const result = await provider.chat({
      system: 'You are concise.',
      messages: [{ role: 'user', content: 'ping' }],
    });

    expect(result).toEqual({
      text: 'pong',
      toolCalls: [],
      stopReason: 'end',
    });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(init?.headers).toMatchObject({
      'x-goog-api-key': 'test-gemini-key',
    });
    const sent = JSON.parse(init?.body as string);
    expect(sent.systemInstruction).toEqual({ parts: [{ text: 'You are concise.' }] });
    expect(sent.contents).toEqual([
      {
        role: 'user',
        parts: [{ text: 'ping' }],
      },
    ]);
  });

  it('smoke test: executes tool-call workflow with fake get_time tool', async () => {
    const fetchFn = fakeFetch(200, {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'get_time',
                  args: { timezone: 'America/New_York' },
                },
              },
            ],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    });
    const provider = new GeminiProvider(profile, {
      fetchFn,
      env: { GEMINI_API_KEY: 'test-gemini-key' },
    });

    const result = await provider.chat({
      messages: [{ role: 'user', content: 'NYC time?' }],
      tools: [getTimeTool],
    });

    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe('get_time');
    expect(result.toolCalls[0]?.args).toEqual({ timezone: 'America/New_York' });

    // Verify tools translated to functionDeclarations
    const sent = JSON.parse(fetchFn.mock.calls[0]![1]?.body as string);
    expect(sent.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_time',
            description: getTimeTool.description,
            parameters: getTimeTool.parameters,
          },
        ],
      },
    ]);

    // Feed tool result back as functionResponse
    const secondFetch = fakeFetch(200, {
      candidates: [
        {
          content: {
            parts: [{ text: 'It is 15:00 in NYC.' }],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
    });
    const secondProvider = new GeminiProvider(profile, {
      fetchFn: secondFetch,
      env: { GEMINI_API_KEY: 'test-gemini-key' },
    });
    await secondProvider.chat({
      messages: [
        { role: 'user', content: 'NYC time?' },
        { role: 'assistant', content: '', toolCalls: result.toolCalls },
        { role: 'tool', toolCallId: result.toolCalls[0]!.id, name: 'get_time', content: '15:00' },
      ],
    });
    const secondSent = JSON.parse(secondFetch.mock.calls[0]![1]?.body as string);
    expect(secondSent.contents).toEqual([
      { role: 'user', parts: [{ text: 'NYC time?' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'get_time',
              args: { timezone: 'America/New_York' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'get_time',
              response: { content: '15:00' },
            },
          },
        ],
      },
    ]);
  });

  it('handles API error from Gemini', async () => {
    const fetchFn = fakeFetch(400, { error: { message: 'API key not valid' } });
    const provider = new GeminiProvider(profile, {
      fetchFn,
      env: { GEMINI_API_KEY: 'bad-key' },
    });

    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      'Gemini error: API key not valid',
    );
  });
});
