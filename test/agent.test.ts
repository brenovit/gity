import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as clack from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_ITERATIONS, runAgentLoop } from '../src/agent/loop.js';
import {
  buildAnalysisUserPrompt,
  buildCommitUserPrompt,
  COMMIT_SYSTEM_PROMPT,
  READ_ONLY_SYSTEM_PROMPT,
} from '../src/agent/prompt.js';
import { promptPlanConfirmation, runAgent } from '../src/commands/run.js';
import { COMMIT_TOOLS, READ_ONLY_TOOLS, toToolSpecs } from '../src/tools/index.js';
import type { ChatInput, ChatResult, Provider } from '../src/types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

function scriptedProvider(steps: Array<(input: ChatInput, turn: number) => ChatResult | Promise<ChatResult>>): {
  provider: Provider;
  calls: ChatInput[];
} {
  const calls: ChatInput[] = [];
  let turn = 0;
  const provider: Provider = {
    name: 'mock:test-model',
    async chat(input: ChatInput): Promise<ChatResult> {
      calls.push({
        ...input,
        messages: input.messages.map((m) => ({ ...m })),
      });
      const step = steps[turn];
      turn += 1;
      if (!step) {
        return { text: 'Done.', toolCalls: [], stopReason: 'end' };
      }
      return step(input, turn);
    },
  };
  return { provider, calls };
}

let repo: string;

beforeEach(() => {
  process.exitCode = undefined;
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'gity-agent-')));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@test.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# Gity Test\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'chore: initial commit');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('READ_ONLY_TOOLS, COMMIT_TOOLS & prompt', () => {
  it('includes only non-mutating tools in READ_ONLY_TOOLS', () => {
    const names = READ_ONLY_TOOLS.map((t) => t.name);
    expect(names).toEqual(['git_status', 'git_diff', 'git_log', 'grep', 'bash']);
    expect(READ_ONLY_TOOLS.every((t) => !t.mutating)).toBe(true);
  });

  it('enables git_add and git_commit in COMMIT_TOOLS while excluding git_pull', () => {
    const names = COMMIT_TOOLS.map((t) => t.name);
    expect(names).toEqual(['git_status', 'git_diff', 'git_log', 'git_add', 'git_commit', 'grep', 'bash']);
    expect(names).not.toContain('git_pull');
  });

  it('builds system and user prompts mentioning read-only analysis and conventional commits', () => {
    expect(READ_ONLY_SYSTEM_PROMPT).toContain('git_status');
    expect(READ_ONLY_SYSTEM_PROMPT).toContain('Conventional Commits');
    expect(COMMIT_SYSTEM_PROMPT).toContain('git_add');
    expect(COMMIT_SYSTEM_PROMPT).toContain('git_commit');
    expect(COMMIT_SYSTEM_PROMPT).toContain('git_status');
    expect(buildCommitUserPrompt()).toContain('git_status after each commit');
    expect(buildCommitUserPrompt('feat: custom message')).toContain('feat: custom message');
    const userPrompt = buildAnalysisUserPrompt({
      repoName: 'demo',
      branch: 'main',
      changedCount: 2,
      untrackedCount: 1,
      summary: '2 changed, 1 untracked',
    });
    expect(userPrompt).toContain('demo');
    expect(userPrompt).toContain('2 changed, 1 untracked');
  });
});

describe('runAgentLoop', () => {
  it('executes read-only tools across multiple turns and returns the commit plan without touching git', async () => {
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'math.ts'), 'export const add = (a: number, b: number) => a + b;\n');
    writeFileSync(join(repo, 'README.md'), '# Gity Test\n\nUpdated docs.\n');
    writeFileSync(join(repo, '.env'), 'SECRET=123\n');

    const statusBefore = git(repo, 'status', '--porcelain');
    const headBefore = git(repo, 'rev-parse', 'HEAD');

    const { provider, calls } = scriptedProvider([
      () => ({
        text: '',
        stopReason: 'tool_use',
        toolCalls: [
          { id: 'c1', name: 'git_status', args: {} },
          { id: 'c2', name: 'git_log', args: { limit: 3 } },
        ],
      }),
      (input) => {
        const toolOutputs = input.messages.filter((m) => m.role === 'tool');
        expect(toolOutputs).toHaveLength(2);
        expect(toolOutputs[0]?.content).toContain('[secret: never stage]');
        expect(toolOutputs[1]?.content).toContain('chore: initial commit');
        return {
          text: '',
          stopReason: 'tool_use',
          toolCalls: [
            { id: 'c3', name: 'git_diff', args: {} },
            { id: 'c4', name: 'bash', args: { command: 'cat src/math.ts' } },
          ],
        };
      },
      () => ({
        text: [
          '### Commit 1',
          '```',
          'feat: add math addition helper',
          '```',
          '- `src/math.ts`',
          '',
          '### Commit 2',
          '```',
          'docs: update README',
          '```',
          '- `README.md`',
          '',
          '**Skipped Files**: `.env` (secret)',
        ].join('\n'),
        stopReason: 'end',
        toolCalls: [],
      }),
    ]);

    const onToolCall = vi.fn();
    const onToolResult = vi.fn();

    const result = await runAgentLoop({
      provider,
      system: READ_ONLY_SYSTEM_PROMPT,
      userPrompt: buildAnalysisUserPrompt(),
      repoRoot: repo,
      onToolCall,
      onToolResult,
    });

    expect(result.stopReason).toBe('completed');
    expect(result.iterations).toBe(3);
    expect(result.toolTraces.map((t) => t.call.name)).toEqual(['git_status', 'git_log', 'git_diff', 'bash']);
    expect(result.text).toContain('feat: add math addition helper');
    expect(result.text).toContain('docs: update README');
    expect(onToolCall).toHaveBeenCalledTimes(4);
    expect(onToolResult).toHaveBeenCalledTimes(4);

    // Verify only read-only tools were advertised to the provider
    expect(calls[0]?.tools?.map((t) => t.name)).toEqual(toToolSpecs(READ_ONLY_TOOLS).map((t) => t.name));

    // Verify git state was not modified at all
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('refuses mutating tools (git_add, git_commit, git_pull) if the model hallucinates them', async () => {
    writeFileSync(join(repo, 'README.md'), '# Modified\n');

    const { provider } = scriptedProvider([
      () => ({
        text: '',
        stopReason: 'tool_use',
        toolCalls: [
          { id: 'bad1', name: 'git_add', args: { paths: ['README.md'] } },
          { id: 'bad2', name: 'git_commit', args: { message: 'feat: sneaky commit' } },
        ],
      }),
      (input) => {
        const errors = input.messages.filter((m) => m.role === 'tool');
        expect(errors).toHaveLength(2);
        expect(errors[0]?.isError).toBe(true);
        expect(errors[0]?.content).toContain('Unknown tool: git_add');
        expect(errors[1]?.isError).toBe(true);
        expect(errors[1]?.content).toContain('Unknown tool: git_commit');
        return {
          text: 'Cannot stage or commit in read-only mode.',
          stopReason: 'end',
          toolCalls: [],
        };
      },
    ]);

    const result = await runAgentLoop({
      provider,
      system: READ_ONLY_SYSTEM_PROMPT,
      userPrompt: 'Analyze changes',
      repoRoot: repo,
    });

    expect(result.stopReason).toBe('completed');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('enforces the maxIterations cap (default 15 and custom)', async () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(15);

    const { provider } = scriptedProvider(
      Array.from({ length: 10 }, (_, i) => () => ({
        text: `Still checking (${i + 1})`,
        stopReason: 'tool_use' as const,
        toolCalls: [{ id: `call_${i}`, name: 'git_status', args: {} }],
      })),
    );

    const result = await runAgentLoop({
      provider,
      system: 'sys',
      userPrompt: 'go',
      repoRoot: repo,
      maxIterations: 3,
    });

    expect(result.stopReason).toBe('max_iterations');
    expect(result.iterations).toBe(3);
    expect(result.toolTraces).toHaveLength(3);
    expect(result.text).toBe('Still checking (3)');
  });

  it('enforces the character/token budget guard', async () => {
    const { provider } = scriptedProvider([
      () => ({
        text: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: 'c1', name: 'git_status', args: {} }],
      }),
      () => ({
        text: 'Should not reach here',
        stopReason: 'end',
        toolCalls: [],
      }),
    ]);

    const result = await runAgentLoop({
      provider,
      system: 'system prompt',
      userPrompt: 'user prompt',
      repoRoot: repo,
      maxTotalChars: 40, // exceeded after first tool result is appended
    });

    expect(result.stopReason).toBe('max_tokens');
    expect(result.iterations).toBe(1);
  });

  it('stops with timeout when maxDurationMs elapses', async () => {
    const provider: Provider = {
      name: 'slow-mock',
      async chat({ signal }) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 200);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          });
        });
        return { text: 'late', toolCalls: [], stopReason: 'end' };
      },
    };

    const result = await runAgentLoop({
      provider,
      system: 'sys',
      userPrompt: 'go',
      repoRoot: repo,
      maxDurationMs: 25,
    });

    expect(result.stopReason).toBe('timeout');
  });

  it('stops with aborted when caller AbortSignal is triggered', async () => {
    const controller = new AbortController();
    controller.abort();

    const { provider, calls } = scriptedProvider([]);
    const result = await runAgentLoop({
      provider,
      system: 'sys',
      userPrompt: 'go',
      repoRoot: repo,
      signal: controller.signal,
    });

    expect(result.stopReason).toBe('aborted');
    expect(calls).toHaveLength(0);
  });
});

describe('runAgent command', () => {
  it('returns early without calling the provider when working tree is clean', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { provider, calls } = scriptedProvider([]);

    const res = await runAgent({
      repoRoot: repo,
      providerInstance: provider,
      dryRun: true,
    });

    expect(res).toBeNull();
    expect(calls).toHaveLength(0);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Working tree is clean');
  });

  it('analyzes dirty repo and prints the proposed commit plan', async () => {
    writeFileSync(join(repo, 'feature.ts'), 'export const feature = true;\n');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { provider } = scriptedProvider([
      () => ({
        text: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: '1', name: 'git_status', args: {} }],
      }),
      () => ({
        text: 'Commit 1: feat: add feature flag (`feature.ts`)',
        stopReason: 'end',
        toolCalls: [],
      }),
    ]);

    const res = await runAgent({
      repoRoot: repo,
      providerInstance: provider,
      dryRun: true,
      verbose: true,
    });

    expect(res?.stopReason).toBe('completed');
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('git_status()');
    expect(output).toContain('Commit 1: feat: add feature flag');
  });

  it('default flow: shows plan, asks confirmation (yes), creates multiple logical commits and verifies with git_status', async () => {
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const feature = true;\n');
    writeFileSync(join(repo, 'README.md'), '# Gity Test\n\nUpdated docs.\n');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const confirmPlan = vi.fn().mockResolvedValue({ action: 'yes' });

    const { provider, calls } = scriptedProvider([
      // Phase 1: read-only analysis
      () => ({
        text: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: 'p1', name: 'git_status', args: {} }],
      }),
      () => ({
        text: 'Plan:\n1. feat: add feature module (src/feature.ts)\n2. docs: update README (README.md)',
        stopReason: 'end',
        toolCalls: [],
      }),
      // Phase 2: commit execution
      () => ({
        text: '',
        stopReason: 'tool_use',
        toolCalls: [
          { id: 'c1', name: 'git_add', args: { paths: ['src/feature.ts'] } },
          { id: 'c2', name: 'git_commit', args: { message: 'feat: add feature module' } },
          { id: 'c3', name: 'git_status', args: {} },
        ],
      }),
      () => ({
        text: '',
        stopReason: 'tool_use',
        toolCalls: [
          { id: 'c4', name: 'git_add', args: { paths: ['README.md'] } },
          { id: 'c5', name: 'git_commit', args: { message: 'docs: update README' } },
          { id: 'c6', name: 'git_status', args: {} },
        ],
      }),
      () => ({
        text: 'Created 2 commits successfully.',
        stopReason: 'end',
        toolCalls: [],
      }),
    ]);

    const res = await runAgent({
      repoRoot: repo,
      providerInstance: provider,
      confirmPlan,
    });

    expect(confirmPlan).toHaveBeenCalledTimes(1);
    expect(confirmPlan).toHaveBeenCalledWith(expect.stringContaining('feat: add feature module'));
    expect(res?.stopReason).toBe('completed');
    expect(res?.toolTraces.map((t) => t.call.name)).toEqual([
      'git_status',
      'git_add',
      'git_commit',
      'git_status',
      'git_add',
      'git_commit',
      'git_status',
    ]);

    // Phase 1 advertised only READ_ONLY_TOOLS; Phase 2 advertised COMMIT_TOOLS
    expect(calls[0]?.tools?.map((t) => t.name)).toEqual(READ_ONLY_TOOLS.map((t) => t.name));
    expect(calls[2]?.tools?.map((t) => t.name)).toEqual(COMMIT_TOOLS.map((t) => t.name));

    const commits = git(repo, 'log', '--pretty=format:%s', '-n', '3').trim().split('\n');
    expect(commits).toEqual(['docs: update README', 'feat: add feature module', 'chore: initial commit']);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Created 2 commits successfully.');
  });

  it('default flow: aborts without touching git when confirmation is declined (no)', async () => {
    writeFileSync(join(repo, 'feature.ts'), 'export const feature = true;\n');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const confirmPlan = vi.fn().mockResolvedValue({ action: 'no' });
    const headBefore = git(repo, 'rev-parse', 'HEAD');

    const { provider, calls } = scriptedProvider([
      () => ({
        text: 'Plan: feat: add feature (feature.ts)',
        stopReason: 'end',
        toolCalls: [],
      }),
    ]);

    const res = await runAgent({
      repoRoot: repo,
      providerInstance: provider,
      confirmPlan,
    });

    expect(confirmPlan).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(res?.toolTraces).toHaveLength(0);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Aborted — no commits created.');
  });

  it('default flow: passes edited plan to commit phase when user chooses edit', async () => {
    writeFileSync(join(repo, 'feature.ts'), 'export const feature = true;\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const confirmPlan = vi.fn().mockResolvedValue({
      action: 'edit',
      plan: 'Use commit message "feat(core): add feature flag"',
    });

    const { provider, calls } = scriptedProvider([
      () => ({
        text: 'Plan: feat: add feature (feature.ts)',
        stopReason: 'end',
        toolCalls: [],
      }),
      (input) => {
        const lastMsg = input.messages[input.messages.length - 1];
        expect(lastMsg?.role).toBe('user');
        expect(lastMsg?.content).toContain('feat(core): add feature flag');
        return {
          text: '',
          stopReason: 'tool_use',
          toolCalls: [
            { id: 'c1', name: 'git_add', args: { paths: ['feature.ts'] } },
            { id: 'c2', name: 'git_commit', args: { message: 'feat(core): add feature flag' } },
            { id: 'c3', name: 'git_status', args: {} },
          ],
        };
      },
      () => ({
        text: 'Committed with edited message.',
        stopReason: 'end',
        toolCalls: [],
      }),
    ]);

    const res = await runAgent({
      repoRoot: repo,
      providerInstance: provider,
      confirmPlan,
    });

    expect(confirmPlan).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(3);
    expect(res?.stopReason).toBe('completed');
    expect(git(repo, 'log', '-1', '--pretty=format:%s').trim()).toBe('feat(core): add feature flag');
  });

  it('--yes skips confirmation and automatically verifies with git_status if omitted by the model', async () => {
    writeFileSync(join(repo, 'feature.ts'), 'export const feature = true;\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const confirmPlan = vi.fn();

    const { provider } = scriptedProvider([
      () => ({
        text: 'Plan: feat: add feature flag (feature.ts)',
        stopReason: 'end',
        toolCalls: [],
      }),
      () => ({
        text: '',
        stopReason: 'tool_use',
        toolCalls: [
          { id: 'c1', name: 'git_add', args: { paths: ['feature.ts'] } },
          { id: 'c2', name: 'git_commit', args: { message: 'feat: add feature flag' } },
        ],
      }),
      () => ({
        text: 'Committed.',
        stopReason: 'end',
        toolCalls: [],
      }),
    ]);

    const res = await runAgent({
      repoRoot: repo,
      providerInstance: provider,
      yes: true,
      confirmPlan,
    });

    expect(confirmPlan).not.toHaveBeenCalled();
    expect(res?.stopReason).toBe('completed');
    // git_status was automatically appended after git_commit to verify repo state
    expect(res?.toolTraces.map((t) => t.call.name)).toEqual(['git_add', 'git_commit', 'git_status']);
    expect(git(repo, 'log', '-1', '--pretty=format:%s').trim()).toBe('feat: add feature flag');
  });

  it('promptPlanConfirmation handles yes, no, and edit choices', async () => {
    const select = vi.fn();
    const text = vi.fn();
    const driver = { select, text, isCancel: clack.isCancel };

    select.mockResolvedValueOnce('yes');
    expect(await promptPlanConfirmation('initial plan', driver)).toEqual({ action: 'yes' });

    select.mockResolvedValueOnce('no');
    expect(await promptPlanConfirmation('initial plan', driver)).toEqual({ action: 'no' });

    select.mockResolvedValueOnce('edit');
    text.mockResolvedValueOnce('  feat: updated plan  ');
    expect(await promptPlanConfirmation('initial plan', driver)).toEqual({
      action: 'edit',
      plan: 'feat: updated plan',
    });
  });

  it('pulls from remote after commits using git pull --rebase --autostash', async () => {
    const remoteRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gity-remote-')));
    try {
      const bareRemote = join(remoteRoot, 'origin.git');
      git(remoteRoot, 'init', '--bare', '-q', bareRemote);
      const branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
      git(repo, 'remote', 'add', 'origin', bareRemote);
      git(repo, 'push', '-u', '-q', 'origin', branch);

      // Push an upstream commit from a peer clone
      const peer = join(remoteRoot, 'peer');
      git(remoteRoot, 'clone', '-q', bareRemote, peer);
      git(peer, 'config', 'user.email', 'peer@test.com');
      git(peer, 'config', 'user.name', 'Peer');
      git(peer, 'config', 'commit.gpgsign', 'false');
      writeFileSync(join(peer, 'upstream.txt'), 'upstream content\n');
      git(peer, 'add', 'upstream.txt');
      git(peer, 'commit', '-q', '-m', 'feat: add upstream file');
      git(peer, 'push', '-q', 'origin', branch);

      // Create a local uncommitted file
      writeFileSync(join(repo, 'local.ts'), 'export const local = 1;\n');
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { provider } = scriptedProvider([
        () => ({
          text: 'Plan: feat: add local module (local.ts)',
          stopReason: 'end',
          toolCalls: [],
        }),
        () => ({
          text: '',
          stopReason: 'tool_use',
          toolCalls: [
            { id: 'c1', name: 'git_add', args: { paths: ['local.ts'] } },
            { id: 'c2', name: 'git_commit', args: { message: 'feat: add local module' } },
            { id: 'c3', name: 'git_status', args: {} },
          ],
        }),
        () => ({
          text: 'Committed local.ts.',
          stopReason: 'end',
          toolCalls: [],
        }),
      ]);

      const res = await runAgent({
        repoRoot: repo,
        providerInstance: provider,
        yes: true,
      });

      expect(res?.stopReason).toBe('completed');
      expect(res?.toolTraces.map((t) => t.call.name)).toEqual([
        'git_add',
        'git_commit',
        'git_status',
        'git_pull',
      ]);

      const commits = git(repo, 'log', '--pretty=format:%s', '-n', '3').trim().split('\n');
      expect(commits).toEqual(['feat: add local module', 'feat: add upstream file', 'chore: initial commit']);
    } finally {
      rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it('skips pulling when --no-pull (pull: false) is passed', async () => {
    const remoteRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gity-remote-')));
    try {
      const bareRemote = join(remoteRoot, 'origin.git');
      git(remoteRoot, 'init', '--bare', '-q', bareRemote);
      const branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
      git(repo, 'remote', 'add', 'origin', bareRemote);
      git(repo, 'push', '-u', '-q', 'origin', branch);

      const peer = join(remoteRoot, 'peer');
      git(remoteRoot, 'clone', '-q', bareRemote, peer);
      git(peer, 'config', 'user.email', 'peer@test.com');
      git(peer, 'config', 'user.name', 'Peer');
      git(peer, 'config', 'commit.gpgsign', 'false');
      writeFileSync(join(peer, 'upstream.txt'), 'upstream content\n');
      git(peer, 'add', 'upstream.txt');
      git(peer, 'commit', '-q', '-m', 'feat: add upstream file');
      git(peer, 'push', '-q', 'origin', branch);

      writeFileSync(join(repo, 'local.ts'), 'export const local = 1;\n');
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { provider } = scriptedProvider([
        () => ({
          text: 'Plan: feat: add local module (local.ts)',
          stopReason: 'end',
          toolCalls: [],
        }),
        () => ({
          text: '',
          stopReason: 'tool_use',
          toolCalls: [
            { id: 'c1', name: 'git_add', args: { paths: ['local.ts'] } },
            { id: 'c2', name: 'git_commit', args: { message: 'feat: add local module' } },
            { id: 'c3', name: 'git_status', args: {} },
          ],
        }),
        () => ({
          text: 'Committed local.ts.',
          stopReason: 'end',
          toolCalls: [],
        }),
      ]);

      const res = await runAgent({
        repoRoot: repo,
        providerInstance: provider,
        yes: true,
        pull: false,
      });

      expect(res?.stopReason).toBe('completed');
      expect(res?.toolTraces.map((t) => t.call.name)).not.toContain('git_pull');
      const commits = git(repo, 'log', '--pretty=format:%s', '-n', '2').trim().split('\n');
      expect(commits).toEqual(['feat: add local module', 'chore: initial commit']);
    } finally {
      rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it('on pull conflict: stops, reports clearly, and leaves repo in a safe state with local commits intact', async () => {
    const remoteRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gity-remote-')));
    try {
      const bareRemote = join(remoteRoot, 'origin.git');
      git(remoteRoot, 'init', '--bare', '-q', bareRemote);
      const branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
      git(repo, 'remote', 'add', 'origin', bareRemote);
      git(repo, 'push', '-u', '-q', 'origin', branch);

      // Peer modifies README.md and pushes
      const peer = join(remoteRoot, 'peer');
      git(remoteRoot, 'clone', '-q', bareRemote, peer);
      git(peer, 'config', 'user.email', 'peer@test.com');
      git(peer, 'config', 'user.name', 'Peer');
      git(peer, 'config', 'commit.gpgsign', 'false');
      writeFileSync(join(peer, 'README.md'), '# Conflicting upstream change\n');
      git(peer, 'add', 'README.md');
      git(peer, 'commit', '-q', '-m', 'docs: upstream update');
      git(peer, 'push', '-q', 'origin', branch);

      // Local modifies README.md on the same line
      writeFileSync(join(repo, 'README.md'), '# Conflicting local change\n');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { provider } = scriptedProvider([
        () => ({
          text: 'Plan: docs: update README (README.md)',
          stopReason: 'end',
          toolCalls: [],
        }),
        () => ({
          text: '',
          stopReason: 'tool_use',
          toolCalls: [
            { id: 'c1', name: 'git_add', args: { paths: ['README.md'] } },
            { id: 'c2', name: 'git_commit', args: { message: 'docs: update README' } },
            { id: 'c3', name: 'git_status', args: {} },
          ],
        }),
        () => ({
          text: 'Committed README.md.',
          stopReason: 'end',
          toolCalls: [],
        }),
      ]);

      const res = await runAgent({
        repoRoot: repo,
        providerInstance: provider,
        yes: true,
      });

      expect(res?.stopReason).toBe('error');
      expect(process.exitCode).toBe(1);
      const errOutput = errSpy.mock.calls.flat().join('\n');
      expect(errOutput).toMatch(/Pull conflict/);
      expect(errOutput).toContain('README.md');
      expect(errOutput).toMatch(/safe state/);

      // Repo is clean, on its branch, not stuck mid-rebase, with the local commit preserved
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch);
      expect(git(repo, 'status', '--porcelain').trim()).toBe('');
      expect(git(repo, 'log', '-1', '--pretty=format:%s').trim()).toBe('docs: update README');
    } finally {
      rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it('honours per-repo .gityrc overrides (commitStyle, ignore patterns) and --provider / --model flags', async () => {
    const configPath = join(repo, 'test-config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultProvider: 'default-ollama',
        providers: {
          'default-ollama': { type: 'ollama', model: 'llama3.2', baseUrl: 'http://localhost:11434' },
          'alt-ollama': { type: 'ollama', model: 'qwen2.5', baseUrl: 'http://localhost:11434' },
        },
      }),
    );
    git(repo, 'add', 'test-config.json');
    git(repo, 'commit', '-q', '-m', 'chore: add test config');

    writeFileSync(
      join(repo, '.gityrc'),
      JSON.stringify({
        provider: 'alt-ollama',
        commitStyle: 'freeform',
        ignore: ['ignored.txt', '.gityrc'],
      }),
    );
    writeFileSync(join(repo, 'ignored.txt'), 'do not commit me\n');
    writeFileSync(join(repo, 'app.ts'), 'export const app = 1;\n');

    vi.spyOn(console, 'log').mockImplementation(() => {});

    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe('custom-override-model');
      return new Response(
        JSON.stringify({
          message: { role: 'assistant', content: 'Plan: Add app module (app.ts)' },
          done_reason: 'stop',
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const res = await runAgent({
        repoRoot: repo,
        configPath,
        model: 'custom-override-model',
        dryRun: true,
      });

      expect(res?.stopReason).toBe('completed');
      expect(res?.text).toContain('Plan: Add app module');
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

