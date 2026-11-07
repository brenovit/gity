import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_PULL_STRATEGY, PullStrategySchema, type PullStrategy } from '../config.js';
import { runCommand, type RunResult } from '../util/spawn.js';
import {
  isIgnoredPath,
  isSecretPath,
  resolveRepoPath,
  SECRET_EXCLUDE_PATHSPECS,
  toIgnoreExcludePathspecs,
  ToolSafetyError,
} from './safety.js';
import { defineTool, type Tool, type ToolContext } from './tool.js';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0', // never block on credential prompts
  GIT_EDITOR: 'true', // never open an editor
  GIT_PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0',
};

/** Run git in the repo root with colors/quoting disabled. */
export async function runGit(ctx: ToolContext, args: string[], timeoutMs = 30_000): Promise<RunResult> {
  return runCommand('git', ['-c', 'color.ui=never', '-c', 'core.quotepath=false', ...args], {
    cwd: ctx.repoRoot,
    env: GIT_ENV,
    timeoutMs,
    signal: ctx.signal,
  });
}

function combined(r: RunResult): string {
  const parts = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter((s) => s.length > 0);
  if (r.timedOut) parts.push('[command timed out]');
  return parts.join('\n');
}

function failure(r: RunResult): { ok: false; output: string } {
  return { ok: false, output: combined(r) || `git exited with code ${r.code}` };
}

/** Validate model-supplied paths and convert them to literal, repo-relative pathspecs. */
async function toPathspecs(
  ctx: ToolContext,
  paths: readonly string[],
  opts: { allowSecrets: boolean; allowIgnored?: boolean },
): Promise<string[]> {
  const specs: string[] = [];
  for (const p of paths) {
    if (p.startsWith(':')) throw new ToolSafetyError(`Pathspec magic is not allowed: ${p}`);
    const { rel } = await resolveRepoPath(ctx.repoRoot, p);
    if (!opts.allowSecrets && isSecretPath(rel)) {
      throw new ToolSafetyError(`Refusing to touch a secret file: ${rel}`);
    }
    if (!opts.allowIgnored && isIgnoredPath(rel, ctx.ignorePatterns)) {
      throw new ToolSafetyError(`Refusing to touch an ignored file (.gityrc): ${rel}`);
    }
    specs.push(`:(literal)${rel}`);
  }
  return specs;
}

const pathList = z.array(z.string().min(1)).max(100);

export const MAX_COMMIT_SUBJECT_LENGTH = 72;

export const CONVENTIONAL_COMMIT_TYPES = [
  'feat',
  'fix',
  'refactor',
  'docs',
  'test',
  'chore',
  'perf',
  'build',
  'ci',
  'style',
  'revert',
] as const;

const CONVENTIONAL_SUBJECT_RE =
  /^(feat|fix|refactor|docs|test|chore|perf|build|ci|style|revert)(\([^)\r\n]+\))?!?: (\S.*)$/;

const NON_IMPERATIVE_VERBS = new Set([
  'added',
  'adding',
  'fixed',
  'fixing',
  'updated',
  'updating',
  'removed',
  'removing',
  'changed',
  'changing',
  'created',
  'creating',
  'deleted',
  'deleting',
  'implemented',
  'implementing',
  'refactored',
  'refactoring',
  'moved',
  'moving',
  'renamed',
  'renaming',
]);

/**
 * Validate that a commit message follows the configured commit style (`conventional` by default)
 * with a subject <= 72 chars. Returns null when valid, or a human-readable error message when invalid.
 */
export function validateCommitMessage(message: string, commitStyle: string = 'conventional'): string | null {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return 'Commit message cannot be empty.';
  }

  const lines = trimmed.split(/\r?\n/);
  const subject = (lines[0] ?? '').trim();

  if (subject.length > MAX_COMMIT_SUBJECT_LENGTH) {
    return `Commit subject must be <= ${MAX_COMMIT_SUBJECT_LENGTH} characters (got ${subject.length}: "${subject}").`;
  }

  if (subject.endsWith('.')) {
    return 'Commit subject must not end with a period.';
  }

  if (lines.length > 1 && (lines[1] ?? '').trim().length > 0) {
    return 'Commit message must include a blank line between the subject line and body.';
  }

  if (commitStyle !== 'conventional') {
    return null;
  }

  const match = CONVENTIONAL_SUBJECT_RE.exec(subject);
  if (!match) {
    return `Commit subject must follow Conventional Commits format "<type>[optional scope]: <imperative subject>" (allowed types: ${CONVENTIONAL_COMMIT_TYPES.join(', ')}).`;
  }

  const description = (match[3] ?? '').trim();
  const firstWord = (description.split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (NON_IMPERATIVE_VERBS.has(firstWord)) {
    return `Commit subject must use imperative mood (found "${firstWord}" in "${subject}").`;
  }

  return null;
}

export const gitStatusTool = defineTool({
  name: 'git_status',
  description:
    'Show the working tree status (porcelain v1 with branch header). Lists staged, unstaged and untracked files. Secret and ignored files are flagged and must never be staged.',
  schema: z.object({}),
  mutating: false,
  async run(_args, ctx) {
    const r = await runGit(ctx, ['status', '--porcelain=v1', '--branch', '--untracked-files=all']);
    if (r.code !== 0) return failure(r);
    const lines = r.stdout.split('\n').filter((l) => l.length > 0);
    const annotated = lines.map((line) => {
      if (line.startsWith('##')) return line;
      const path = line.slice(3).split(' -> ').pop() ?? '';
      if (isSecretPath(path)) return `${line}  [secret: never stage]`;
      if (isIgnoredPath(path, ctx.ignorePatterns)) return `${line}  [ignored: never stage]`;
      return line;
    });
    if (annotated.length <= 1) annotated.push('(working tree clean)');
    return { output: annotated.join('\n') };
  },
});

export const gitDiffTool = defineTool({
  name: 'git_diff',
  description:
    'Show changes as a unified diff. By default shows unstaged changes; set staged=true for the index. Optionally limit to paths or show a --stat summary. Untracked files are not included; secret and ignored files are always excluded.',
  schema: z.object({
    staged: z.boolean().default(false).describe('Diff the index (staged changes) instead of the working tree'),
    paths: pathList.optional().describe('Limit the diff to these repo-relative paths'),
    stat: z.boolean().default(false).describe('Only show a diffstat summary'),
    context: z.number().int().min(0).max(20).default(3).describe('Lines of context around changes'),
  }),
  mutating: false,
  async run(args, ctx) {
    const specs = await toPathspecs(ctx, args.paths ?? [], { allowSecrets: false, allowIgnored: false });
    const gitArgs = ['diff', '--no-ext-diff', '--no-textconv', `-U${args.context}`];
    if (args.staged) gitArgs.push('--cached');
    if (args.stat) gitArgs.push('--stat');
    gitArgs.push(
      '--',
      ...(specs.length > 0 ? specs : ['.']),
      ...SECRET_EXCLUDE_PATHSPECS,
      ...toIgnoreExcludePathspecs(ctx.ignorePatterns),
    );
    const r = await runGit(ctx, gitArgs);
    if (r.code !== 0) return failure(r);
    return { output: r.stdout.trimEnd() || '(no differences)' };
  },
});

export const gitLogTool = defineTool({
  name: 'git_log',
  description: 'Show recent commits (short hash, date, subject). Useful for matching the repository commit message style.',
  schema: z.object({
    limit: z.number().int().min(1).max(50).default(10).describe('Number of commits to show'),
    paths: pathList.optional().describe('Only commits touching these paths'),
  }),
  mutating: false,
  async run(args, ctx) {
    const specs = await toPathspecs(ctx, args.paths ?? [], { allowSecrets: true, allowIgnored: true });
    const gitArgs = ['log', `-n${args.limit}`, '--no-decorate', '--date=short', '--pretty=format:%h %ad %s'];
    if (specs.length > 0) gitArgs.push('--', ...specs);
    const r = await runGit(ctx, gitArgs);
    if (r.code !== 0) {
      if (/does not have any commits yet|bad default revision/i.test(r.stderr)) return { output: '(no commits yet)' };
      return failure(r);
    }
    return { output: r.stdout.trimEnd() || '(no commits)' };
  },
});

export const gitAddTool = defineTool({
  name: 'git_add',
  description:
    'Stage specific files. Paths must be individual files inside the repo (deleted files allowed); directories, ".", globs, secret files, and .gityrc ignored files are rejected.',
  schema: z.object({
    paths: pathList.min(1).describe('Repo-relative file paths to stage'),
  }),
  mutating: true,
  async run(args, ctx) {
    const specs: string[] = [];
    for (const p of args.paths) {
      if (p.startsWith(':')) throw new ToolSafetyError(`Pathspec magic is not allowed: ${p}`);
      const { abs, rel } = await resolveRepoPath(ctx.repoRoot, p);
      if (rel === '.') throw new ToolSafetyError('Refusing to stage the whole repository; list files explicitly');
      if (isSecretPath(rel)) throw new ToolSafetyError(`Refusing to stage a secret file: ${rel}`);
      if (isIgnoredPath(rel, ctx.ignorePatterns)) {
        throw new ToolSafetyError(`Refusing to stage an ignored file (.gityrc): ${rel}`);
      }
      const stat = await lstat(abs).catch(() => null);
      if (stat?.isDirectory()) throw new ToolSafetyError(`Refusing to stage a directory: ${rel}; list files explicitly`);
      specs.push(`:(literal)${rel}`);
    }
    const r = await runGit(ctx, ['add', '--', ...specs]);
    if (r.code !== 0) return failure(r);
    const staged = await runGit(ctx, ['diff', '--cached', '--name-status']);
    return { output: `Staged ${specs.length} path(s).\nIndex now contains:\n${staged.stdout.trimEnd() || '(nothing)'}` };
  },
});

export const gitCommitTool = defineTool({
  name: 'git_commit',
  description:
    'Create a commit from the currently staged changes with the given message (Conventional Commits format, imperative subject <= 72 chars). Fails if nothing is staged or a secret/ignored file is staged.',
  schema: z.object({
    message: z
      .string()
      .trim()
      .min(1)
      .max(5000)
      .describe('Full commit message (Conventional Commits subject <= 72 chars, optional blank line + body)'),
  }),
  mutating: true,
  async run(args, ctx) {
    const messageError = validateCommitMessage(args.message, ctx.commitStyle ?? 'conventional');
    if (messageError) {
      return { ok: false, output: `Invalid commit message: ${messageError}` };
    }
    const staged = await runGit(ctx, ['diff', '--cached', '--name-only', '-z']);
    if (staged.code !== 0) return failure(staged);
    const files = staged.stdout.split('\0').filter((f) => f.length > 0);
    if (files.length === 0) return { ok: false, output: 'Nothing is staged; use git_add first.' };
    const secrets = files.filter(isSecretPath);
    if (secrets.length > 0) {
      throw new ToolSafetyError(`Secret files are staged, refusing to commit: ${secrets.join(', ')}`);
    }
    const ignored = files.filter((f) => isIgnoredPath(f, ctx.ignorePatterns));
    if (ignored.length > 0) {
      throw new ToolSafetyError(`Ignored files (.gityrc) are staged, refusing to commit: ${ignored.join(', ')}`);
    }
    const r = await runGit(ctx, ['commit', '-m', args.message], 60_000);
    if (r.code !== 0) return failure(r);
    const head = await runGit(ctx, ['log', '-1', '--pretty=format:%h %s']);
    return { output: `Committed ${files.length} file(s): ${head.stdout.trim()}` };
  },
});

export interface GitPullOutcome {
  ok: boolean;
  skipped: boolean;
  conflict: boolean;
  conflictedFiles: string[];
  strategy: PullStrategy;
  output: string;
}

/** Map a pull strategy to its `git pull` argument list. */
export function pullStrategyArgs(strategy: PullStrategy): string[] {
  switch (strategy) {
    case 'rebase-autostash':
      return ['pull', '--rebase', '--autostash'];
    case 'rebase':
      return ['pull', '--rebase'];
    case 'ff-only':
      return ['pull', '--ff-only'];
    case 'merge':
      return ['pull', '--no-rebase'];
    case 'none':
      return [];
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function getGitDir(ctx: ToolContext): Promise<string> {
  const r = await runGit(ctx, ['rev-parse', '--git-dir']);
  const dir = r.code === 0 && r.stdout.trim().length > 0 ? r.stdout.trim() : '.git';
  return isAbsolute(dir) ? dir : join(ctx.repoRoot, dir);
}

/** Check whether a rebase or merge operation is currently in progress in the repository. */
export async function getInProgressGitOp(ctx: ToolContext): Promise<'rebase' | 'merge' | null> {
  const gitDir = await getGitDir(ctx);
  if ((await pathExists(join(gitDir, 'rebase-merge'))) || (await pathExists(join(gitDir, 'rebase-apply')))) {
    return 'rebase';
  }
  if (await pathExists(join(gitDir, 'MERGE_HEAD'))) {
    return 'merge';
  }
  return null;
}

async function getConflictedFiles(ctx: ToolContext): Promise<string[]> {
  const r = await runGit(ctx, ['diff', '--name-only', '--diff-filter=U']);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Execute `git pull` with the configured strategy.
 * If a conflict occurs, automatically abort any in-progress rebase/merge so the repository is left in a safe state.
 */
export async function executeGitPull(
  ctx: ToolContext,
  strategy: PullStrategy = DEFAULT_PULL_STRATEGY,
): Promise<GitPullOutcome> {
  if (strategy === 'none') {
    return {
      ok: true,
      skipped: true,
      conflict: false,
      conflictedFiles: [],
      strategy,
      output: 'Skipped git pull (strategy: none).',
    };
  }

  const existingOp = await getInProgressGitOp(ctx);
  if (existingOp) {
    return {
      ok: false,
      skipped: false,
      conflict: true,
      conflictedFiles: await getConflictedFiles(ctx),
      strategy,
      output: `Cannot pull: a git ${existingOp} is already in progress. Resolve or abort it first.`,
    };
  }

  const gitArgs = pullStrategyArgs(strategy);
  const r = await runGit(ctx, gitArgs, 120_000);
  const rawOutput = combined(r);

  if (r.code === 0) {
    return {
      ok: true,
      skipped: false,
      conflict: false,
      conflictedFiles: [],
      strategy,
      output: rawOutput || 'Pulled successfully.',
    };
  }

  const inProgressOp = await getInProgressGitOp(ctx);
  const unmerged = await getConflictedFiles(ctx);
  const conflictFromOutput: string[] = [];
  const conflictRegex = /CONFLICT\b[^\r\n]*?\bin\s+([^\r\n]+)/gi;
  for (const match of rawOutput.matchAll(conflictRegex)) {
    const file = match[1]?.trim();
    if (file) conflictFromOutput.push(file);
  }
  const conflictedFiles = Array.from(new Set([...unmerged, ...conflictFromOutput]));
  const isConflict =
    inProgressOp !== null ||
    conflictedFiles.length > 0 ||
    /CONFLICT|could not apply|Automatic merge failed|Resolve all conflicts/i.test(rawOutput);

  if (inProgressOp === 'rebase') {
    await runGit(ctx, ['rebase', '--abort']);
  } else if (inProgressOp === 'merge') {
    await runGit(ctx, ['merge', '--abort']);
  }

  if (isConflict) {
    const filesDetail =
      conflictedFiles.length > 0 ? ` Conflicting file(s): ${conflictedFiles.join(', ')}.` : '';
    const abortDetail = inProgressOp
      ? ` Aborted in-progress ${inProgressOp} to leave the repository in a clean, safe state with your local commits intact.`
      : ' Repository left in a safe state with your local commits intact.';
    return {
      ok: false,
      skipped: false,
      conflict: true,
      conflictedFiles,
      strategy,
      output: `Pull conflict during \`git ${gitArgs.join(' ')}\`.${filesDetail}${abortDetail}${rawOutput ? `\n${rawOutput}` : ''}`,
    };
  }

  return {
    ok: false,
    skipped: false,
    conflict: false,
    conflictedFiles: [],
    strategy,
    output: rawOutput || `git pull exited with code ${r.code}`,
  };
}

export const gitPullTool = defineTool({
  name: 'git_pull',
  description:
    'Pull from the upstream remote (defaults to `git pull --rebase --autostash`). On conflicts, aborts any in-progress rebase/merge to leave the repository in a safe state.',
  schema: z.object({
    strategy: PullStrategySchema.default(DEFAULT_PULL_STRATEGY).describe(
      'Pull strategy: rebase-autostash (default), rebase, ff-only, merge, or none',
    ),
  }),
  mutating: true,
  async run(args, ctx) {
    const res = await executeGitPull(ctx, args.strategy);
    return { ok: res.ok, output: res.output };
  },
});

export const gitTools: readonly Tool[] = [gitStatusTool, gitDiffTool, gitLogTool, gitAddTool, gitCommitTool, gitPullTool];
