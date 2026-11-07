import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerTest } from '../src/commands/provider.js';
import { addProvider, buildProfile, defaultConfig, saveConfig } from '../src/config.js';

describe('providerTest command', () => {
  let tmpDir: string;

  beforeEach(async () => {
    process.exitCode = undefined;
    tmpDir = await mkdtemp(join(tmpdir(), 'gity-provider-cmd-'));
    process.env.GITY_CONFIG = join(tmpDir, 'config.json');
  });

  afterEach(async () => {
    delete process.env.GITY_CONFIG;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('runs connection check and chat test', async () => {
    const config = addProvider(
      defaultConfig(),
      'test-ollama',
      buildProfile({ type: 'ollama', model: 'llama3.2' }),
      { makeDefault: true },
    );
    await saveConfig(config);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Mock fetch for both tags and chat
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.includes('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'llama3.2' }] }), { status: 200 });
      }
      if (u.includes('/api/chat')) {
        return new Response(JSON.stringify({ message: { role: 'assistant', content: 'pong' } }), {
          status: 200,
        });
      }
      return new Response('Not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await providerTest('test-ollama');

    const logs = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logs).toContain('Testing "test-ollama"');
    expect(logs).toContain('Connected in');
    expect(logs).toContain('Chat reply in');
    expect(logs).toContain('pong');
    expect(process.exitCode).toBeUndefined();

    vi.unstubAllGlobals();
    logSpy.mockRestore();
  });

  it('sets exitCode to 1 if connection fails', async () => {
    const config = addProvider(
      defaultConfig(),
      'broken-ollama',
      buildProfile({ type: 'ollama', model: 'llama3.2' }),
      { makeDefault: true },
    );
    await saveConfig(config);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    });
    vi.stubGlobal('fetch', fetchMock);

    await providerTest('broken-ollama');

    expect(process.exitCode).toBe(1);

    vi.unstubAllGlobals();
    logSpy.mockRestore();
  });
});
