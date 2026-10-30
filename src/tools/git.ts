import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { runCommand, type RunResult } from '../util/spawn.js';
import { isSecretPath, resolveRepoPath, SECRET_EXCLUDE_PATHSPECS, ToolSafetyError } from './safety.js';
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
async function toPathspecs(ctx: ToolContext, paths: readonly string[], opts: { allowSecrets: boolean }): Promise<string[]> {
  const specs: string[] = [];
  for (const p of paths) {
    if (p.startsWith(':')) throw new ToolSafetyError(`Pathspec magic is not allowed: ${p}`);
    const { rel } = await resolveRepoPath(ctx.repoRoot, p);
    if (!opts.allowSecrets && isSecretPath(rel)) {
      throw new ToolSafetyError(`Refusing to touch a secret file: ${rel}`);
    }
    specs.push(`:(literal)${rel}`);
  }
  return specs;
}

const pathList = z.array(z.string().min(1)).max(100);

export const gitStatusTool = defineTool({
  name: 'git_status',
  description:
    'Show the working tree status (porcelain v1 with branch header). Lists staged, unstaged and untracked files. Secret files are flagged and must never be staged.',
  schema: z.object({}),
  mutating: false,
  async run(_args, ctx) {
    const r = await runGit(ctx, ['status', '--porcelain=v1', '--branch', '--untracked-files=all']);
    if (r.code !== 0) return failure(r);
    const lines = r.stdout.split('\n').filter((l) => l.length > 0);
    const annotated = lines.map((line) => {
      if (line.startsWith('##')) return line;
      const path = line.slice(3).split(' -> ').pop() ?? '';
      return isSecretPath(path) ? `${line}  [secret: never stage]` : line;
    });
    if (annotated.length <= 1) annotated.push('(working tree clean)');
    return { output: annotated.join('\n') };
  },
});

export const gitDiffTool = defineTool({
  name: 'git_diff',
  description:
    'Show changes as a unified diff. By default shows unstaged changes; set staged=true for the index. Optionally limit to paths or show a --stat summary. Untracked files are not included; secret files are always excluded.',
  schema: z.object({
    staged: z.boolean().default(false).describe('Diff the index (staged changes) instead of the working tree'),
    paths: pathList.optional().describe('Limit the diff to these repo-relative paths'),
    stat: z.boolean().default(false).describe('Only show a diffstat summary'),
    context: z.number().int().min(0).max(20).default(3).describe('Lines of context around changes'),
  }),
  mutating: false,
  async run(args, ctx) {
    const specs = await toPathspecs(ctx, args.paths ?? [], { allowSecrets: false });
    const gitArgs = ['diff', '--no-ext-diff', '--no-textconv', `-U${args.context}`];
    if (args.staged) gitArgs.push('--cached');
    if (args.stat) gitArgs.push('--stat');
    gitArgs.push('--', ...(specs.length > 0 ? specs : ['.']), ...SECRET_EXCLUDE_PATHSPECS);
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
    const specs = await toPathspecs(ctx, args.paths ?? [], { allowSecrets: true });
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
    'Stage specific files. Paths must be individual files inside the repo (deleted files allowed); directories, ".", globs and secret files are rejected.',
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
  description: 'Create a commit from the currently staged changes with the given message. Fails if nothing is staged or a secret file is staged.',
  schema: z.object({
    message: z.string().trim().min(1).max(5000).describe('Full commit message (subject, optional blank line + body)'),
  }),
  mutating: true,
  async run(args, ctx) {
    const staged = await runGit(ctx, ['diff', '--cached', '--name-only', '-z']);
    if (staged.code !== 0) return failure(staged);
    const files = staged.stdout.split('\0').filter((f) => f.length > 0);
    if (files.length === 0) return { ok: false, output: 'Nothing is staged; use git_add first.' };
    const secrets = files.filter(isSecretPath);
    if (secrets.length > 0) {
      throw new ToolSafetyError(`Secret files are staged, refusing to commit: ${secrets.join(', ')}`);
    }
    const r = await runGit(ctx, ['commit', '-m', args.message], 60_000);
    if (r.code !== 0) return failure(r);
    const head = await runGit(ctx, ['log', '-1', '--pretty=format:%h %s']);
    return { output: `Committed ${files.length} file(s): ${head.stdout.trim()}` };
  },
});

export const gitPullTool = defineTool({
  name: 'git_pull',
  description: 'Pull from the upstream remote using `git pull --rebase --autostash`.',
  schema: z.object({}),
  mutating: true,
  async run(_args, ctx) {
    const r = await runGit(ctx, ['pull', '--rebase', '--autostash'], 120_000);
    if (r.code !== 0) return failure(r);
    return { output: combined(r) || 'Pulled successfully.' };
  },
});

export const gitTools: readonly Tool[] = [gitStatusTool, gitDiffTool, gitLogTool, gitAddTool, gitCommitTool, gitPullTool];
