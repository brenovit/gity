import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_ITERATIONS, runAgentLoop } from '../src/agent/loop.js';
import { buildAnalysisUserPrompt, READ_ONLY_SYSTEM_PROMPT } from '../src/agent/prompt.js';
import { runAgent } from '../src/commands/run.js';
import { READ_ONLY_TOOLS, toToolSpecs } from '../src/tools/index.js';
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

describe('READ_ONLY_TOOLS & prompt', () => {
  it('includes only non-mutating tools', () => {
    const names = READ_ONLY_TOOLS.map((t) => t.name);
    expect(names).toEqual(['git_status', 'git_diff', 'git_log', 'grep', 'bash']);
    expect(READ_ONLY_TOOLS.every((t) => !t.mutating)).toBe(true);
  });

  it('builds system and user prompts mentioning read-only analysis and conventional commits', () => {
    expect(READ_ONLY_SYSTEM_PROMPT).toContain('git_status');
    expect(READ_ONLY_SYSTEM_PROMPT).toContain('Conventional Commits');
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
});

