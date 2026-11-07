import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addProvider,
  buildProfile,
  ConfigError,
  ConfigSchema,
  defaultConfig,
  describeApiKey,
  getConfigPath,
  loadConfig,
  loadRepoConfig,
  maskSecret,
  parsePullStrategy,
  removeProvider,
  RepoConfigSchema,
  resolveProvider,
  saveConfig,
  setDefaultProvider,
} from '../src/config.js';

describe('config schema', () => {
  it('applies defaults for an empty object', () => {
    expect(ConfigSchema.parse({})).toEqual({ providers: {} });
  });

  it('fills per-type base URL and api key env defaults', () => {
    expect(buildProfile({ type: 'ollama', model: 'llama3.2' }).baseUrl).toBe('http://localhost:11434');
    expect(buildProfile({ type: 'lmstudio', model: 'x' }).baseUrl).toBe('http://localhost:1234/v1');
    expect(buildProfile({ type: 'claude', model: 'x' })).toMatchObject({ apiKeyEnv: 'ANTHROPIC_API_KEY' });
    expect(buildProfile({ type: 'gemini', model: 'x' })).toMatchObject({ apiKeyEnv: 'GEMINI_API_KEY' });
  });

  it('strips trailing slashes from base URLs', () => {
    expect(buildProfile({ type: 'ollama', model: 'm', baseUrl: 'http://h:1/' }).baseUrl).toBe('http://h:1');
  });

  it('rejects missing model, bad URL and bad env var names', () => {
    expect(() => buildProfile({ type: 'ollama', model: '  ' })).toThrow(ConfigError);
    expect(() => buildProfile({ type: 'ollama', model: 'm', baseUrl: 'ftp://x' })).toThrow(ConfigError);
    expect(() => buildProfile({ type: 'claude', model: 'm', apiKeyEnv: 'bad-name' })).toThrow(ConfigError);
  });

  it('rejects a default that points to a missing provider', () => {
    expect(ConfigSchema.safeParse({ defaultProvider: 'nope', providers: {} }).success).toBe(false);
  });

  it('validates pullStrategy in config and parsePullStrategy', () => {
    expect(ConfigSchema.parse({ pullStrategy: 'rebase-autostash' })).toEqual({
      pullStrategy: 'rebase-autostash',
      providers: {},
    });
    expect(parsePullStrategy('rebase')).toBe('rebase');
    expect(parsePullStrategy('ff-only')).toBe('ff-only');
    expect(parsePullStrategy('merge')).toBe('merge');
    expect(parsePullStrategy('none')).toBe('none');
    expect(() => parsePullStrategy('force-push')).toThrow(ConfigError);
    expect(ConfigSchema.safeParse({ pullStrategy: 'invalid' }).success).toBe(false);
  });
});

describe('profile operations', () => {
  const ollama = buildProfile({ type: 'ollama', model: 'llama3.2' });
  const claude = buildProfile({ type: 'claude', model: 'claude-sonnet-4-5' });

  it('first provider becomes default; later ones only with makeDefault', () => {
    let c = addProvider(defaultConfig(), 'local', ollama);
    expect(c.defaultProvider).toBe('local');
    c = addProvider(c, 'cloud', claude);
    expect(c.defaultProvider).toBe('local');
    c = addProvider(c, 'cloud2', claude, { makeDefault: true });
    expect(c.defaultProvider).toBe('cloud2');
  });

  it('refuses duplicates unless overwrite is set', () => {
    const c = addProvider(defaultConfig(), 'local', ollama);
    expect(() => addProvider(c, 'local', ollama)).toThrow(/already exists/);
    expect(addProvider(c, 'local', claude, { overwrite: true }).providers.local?.type).toBe('claude');
  });

  it('rejects invalid names', () => {
    expect(() => addProvider(defaultConfig(), 'has space', ollama)).toThrow(ConfigError);
  });

  it('removing the default promotes the next provider', () => {
    let c = addProvider(addProvider(defaultConfig(), 'a', ollama), 'b', claude);
    c = removeProvider(c, 'a');
    expect(c.defaultProvider).toBe('b');
    c = removeProvider(c, 'b');
    expect(c.defaultProvider).toBeUndefined();
    expect(() => removeProvider(c, 'b')).toThrow(/not found/);
  });

  it('use / resolve', () => {
    let c = addProvider(addProvider(defaultConfig(), 'a', ollama), 'b', claude);
    c = setDefaultProvider(c, 'b');
    expect(resolveProvider(c).name).toBe('b');
    expect(resolveProvider(c, 'a').profile.type).toBe('ollama');
    expect(() => setDefaultProvider(c, 'zzz')).toThrow(/not found/);
    expect(() => resolveProvider(defaultConfig())).toThrow(/No default provider/);
  });
});

describe('secrets', () => {
  it('masks values', () => {
    expect(maskSecret(undefined)).toBe('(not set)');
    expect(maskSecret('short')).toBe('****');
    expect(maskSecret('sk-ant-1234567890abcd')).toBe('sk-a…abcd');
  });

  it('describes api key status without leaking the key', () => {
    const claude = buildProfile({ type: 'claude', model: 'm' });
    const out = describeApiKey(claude, { ANTHROPIC_API_KEY: 'sk-ant-supersecretvalue-9999' });
    expect(out).toBe('ANTHROPIC_API_KEY=sk-a…9999');
    expect(out).not.toContain('supersecret');
    expect(describeApiKey(claude, {})).toBe('ANTHROPIC_API_KEY=(not set)');
    expect(describeApiKey(buildProfile({ type: 'ollama', model: 'm' }))).toBe('not required');
  });
});

describe('load / save', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gity-config-'));
    path = join(dir, 'nested', 'config.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.GITY_CONFIG;
  });

  it('returns defaults when the file is missing', async () => {
    expect(await loadConfig(path)).toEqual({ providers: {} });
  });

  it('round-trips and writes 0600 file in 0700 dir', async () => {
    const c = addProvider(defaultConfig(), 'local', buildProfile({ type: 'ollama', model: 'llama3.2' }));
    await saveConfig(c, path);
    expect(await loadConfig(path)).toEqual(c);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'nested'))).mode & 0o777).toBe(0o700);
    expect(await readFile(path, 'utf-8')).not.toMatch(/apiKey"/);
  });

  it('throws (instead of silently resetting) on invalid JSON or schema', async () => {
    await saveConfig(defaultConfig(), path);
    await writeFile(path, '{ not json');
    await expect(loadConfig(path)).rejects.toThrow(/not valid JSON/);
    await writeFile(path, JSON.stringify({ providers: { x: { type: 'nope' } } }));
    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
  });

  it('honours GITY_CONFIG', () => {
    process.env.GITY_CONFIG = path;
    expect(getConfigPath()).toBe(path);
  });

  it('loads and validates per-repo .gityrc overrides', async () => {
    expect(await loadRepoConfig(dir)).toEqual({ ignore: [] });

    await writeFile(
      join(dir, '.gityrc'),
      JSON.stringify({
        provider: 'my-claude',
        model: 'claude-sonnet-4-5',
        commitStyle: 'freeform',
        ignore: ['dist/**', '*.snap'],
        pullStrategy: 'ff-only',
      }),
    );

    const rc = await loadRepoConfig(dir);
    expect(rc).toEqual({
      provider: 'my-claude',
      model: 'claude-sonnet-4-5',
      commitStyle: 'freeform',
      ignore: ['dist/**', '*.snap'],
      pullStrategy: 'ff-only',
    });

    await writeFile(join(dir, '.gityrc'), '{ bad json');
    await expect(loadRepoConfig(dir)).rejects.toThrow(/not valid JSON/);

    expect(RepoConfigSchema.safeParse({ provider: 'bad name' }).success).toBe(false);
  });
});
