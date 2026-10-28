import { describe, expect, it, vi } from 'vitest';
import { buildProfile } from '../src/config.js';
import { testConnection } from '../src/providers/connection.js';

function fakeFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

describe('testConnection', () => {
  it('lists Ollama models and accepts the implicit :latest tag', async () => {
    const fetchFn = fakeFetch(200, { models: [{ name: 'llama3.2:latest' }] });
    const r = await testConnection(buildProfile({ type: 'ollama', model: 'llama3.2' }), { fetchFn });
    expect(r).toMatchObject({ ok: true, models: ['llama3.2:latest'], modelFound: true });
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://localhost:11434/api/tags');
  });

  it('uses /models for LM Studio', async () => {
    const fetchFn = fakeFetch(200, { data: [{ id: 'qwen' }] });
    const r = await testConnection(buildProfile({ type: 'lmstudio', model: 'other' }), { fetchFn });
    expect(r).toMatchObject({ ok: true, modelFound: false });
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://localhost:1234/v1/models');
  });

  it('sends the Claude API key header from env', async () => {
    const fetchFn = fakeFetch(200, { data: [{ id: 'claude-x' }] });
    const profile = buildProfile({ type: 'claude', model: 'claude-x' });
    const r = await testConnection(profile, { fetchFn, env: { ANTHROPIC_API_KEY: 'k' } });
    expect(r.ok).toBe(true);
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
  });

  it('strips the models/ prefix for Gemini', async () => {
    const fetchFn = fakeFetch(200, { models: [{ name: 'models/gemini-2.5-flash' }] });
    const profile = buildProfile({ type: 'gemini', model: 'gemini-2.5-flash' });
    const r = await testConnection(profile, { fetchFn, env: { GEMINI_API_KEY: 'k' } });
    expect(r).toMatchObject({ ok: true, modelFound: true, models: ['gemini-2.5-flash'] });
  });

  it('fails fast without calling the network when the API key env var is missing', async () => {
    const fetchFn = fakeFetch(200, {});
    const r = await testConnection(buildProfile({ type: 'claude', model: 'm' }), { fetchFn, env: {} });
    expect(r).toMatchObject({ ok: false, error: 'Environment variable ANTHROPIC_API_KEY is not set' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reports HTTP errors and malformed bodies', async () => {
    const profile = buildProfile({ type: 'gemini', model: 'm' });
    const env = { GEMINI_API_KEY: 'k' };
    const unauthorized = await testConnection(profile, { fetchFn: fakeFetch(401, {}), env });
    expect(unauthorized.error).toMatch(/HTTP 401.*API key/);
    const ollama = buildProfile({ type: 'ollama', model: 'm' });
    const malformed = await testConnection(ollama, { fetchFn: fakeFetch(200, { nope: 1 }) });
    expect(malformed).toMatchObject({ ok: false, error: 'Unexpected response format from provider' });
  });

  it('reports refused connections', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:11434') });
    });
    const r = await testConnection(buildProfile({ type: 'ollama', model: 'm' }), { fetchFn });
    expect(r.error).toMatch(/Connection refused/);
  });
});
