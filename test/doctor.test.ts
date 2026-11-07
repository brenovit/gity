import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectDoctor, runDoctor } from '../src/commands/doctor.js';
import { addProvider, buildProfile, defaultConfig, saveConfig } from '../src/config.js';
import { createProgressLogger } from '../src/util/logger.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

describe('gity doctor', () => {
  let repo: string;
  let configPath: string;

  beforeEach(() => {
    process.exitCode = undefined;
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'gity-doctor-')));
    configPath = join(repo, 'config.json');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@test.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'README.md'), '# Doctor Test\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'chore: initial');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('passes all checks when Node, git, repo, .gityrc, config, and provider are healthy', async () => {
    const cfg = addProvider(
      defaultConfig(),
      'local-ollama',
      buildProfile({ type: 'ollama', model: 'llama3.2' }),
      { makeDefault: true },
    );
    await saveConfig(cfg, configPath);

    writeFileSync(
      join(repo, '.gityrc'),
      JSON.stringify({
        commitStyle: 'conventional',
        ignore: ['dist/**'],
      }),
    );

    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }), { status: 200 }),
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = await runDoctor({
      repoRoot: repo,
      configPath,
      fetchFn,
      nodeVersion: 'v20.11.0',
    });

    expect(report.ok).toBe(true);
    expect(process.exitCode).toBeUndefined();
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
    expect(byName['Node.js']).toBe('ok');
    expect(byName['Git']).toBe('ok');
    expect(byName['Repository']).toBe('ok');
    expect(byName['.gityrc']).toBe('ok');
    expect(byName['Config']).toBe('ok');
    expect(byName['Provider']).toBe('ok');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('All required checks passed.');
  });

  it('reports failures on unsupported Node, invalid .gityrc, missing API key, or unreachable provider', async () => {
    const cfg = addProvider(
      defaultConfig(),
      'cloud-claude',
      buildProfile({ type: 'claude', model: 'claude-sonnet-4-5' }),
      { makeDefault: true },
    );
    await saveConfig(cfg, configPath);
    writeFileSync(join(repo, '.gityrc'), '{ malformed json');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const report = await runDoctor({
      repoRoot: repo,
      configPath,
      env: {},
      nodeVersion: 'v18.0.0',
    });

    expect(report.ok).toBe(false);
    expect(process.exitCode).toBe(1);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
    expect(byName['Node.js']).toBe('fail');
    expect(byName['.gityrc']).toBe('fail');
    expect(byName['API Key']).toBe('fail');
    expect(byName['Provider']).toBe('fail');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Some checks failed.');
  });

  it('warns when outside a git repo or when no providers are configured', async () => {
    const report = await inspectDoctor({
      repoRoot: null,
      configPath: join(repo, 'missing-config.json'),
      nodeVersion: 'v22.0.0',
    });

    expect(report.ok).toBe(true);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
    expect(byName['Repository']).toBe('warn');
    expect(byName['Config']).toBe('warn');
  });
});

describe('createProgressLogger (spinner & live streaming)', () => {
  it('uses spinner and streams text deltas in TTY non-verbose mode', () => {
    const events: string[] = [];
    const chunks: string[] = [];
    const lines: string[] = [];

    const logger = createProgressLogger({
      isTTY: true,
      verbose: false,
      createSpinner: () => ({
        start: (m) => events.push(`start:${m}`),
        stop: (m) => events.push(`stop:${m}`),
        message: (m) => events.push(`msg:${m}`),
      }),
      logLine: (l) => lines.push(l),
      writeChunk: (c) => chunks.push(c),
    });

    logger.startPhase('Analyzing...');
    logger.logToolCall('git_status()', 1);
    logger.onTextDelta('Commit ');
    logger.onTextDelta('Plan');
    logger.finishPhase('Commit Plan');

    expect(events).toEqual(['start:Analyzing...', 'msg:Running git_status()', 'stop:Done.']);
    expect(lines).toContain('  -> git_status()');
    expect(chunks.join('')).toBe('Commit Plan\n');
  });

  it('logs step numbers and tool result timings in verbose mode without spinner', () => {
    const lines: string[] = [];
    const logger = createProgressLogger({
      isTTY: true,
      verbose: true,
      logLine: (l) => lines.push(l),
    });

    logger.startPhase('Analyzing...');
    logger.logToolCall('git_diff(stat=true)', 2);
    logger.logToolResult('git_diff', true, 42, true);
    logger.finishPhase('Plan text');

    expect(lines).toEqual([
      'Analyzing...',
      '  [step 2] -> git_diff(stat=true)',
      '  <- git_diff [ok, 42ms, truncated]',
      '',
      'Plan text',
    ]);
  });
});

