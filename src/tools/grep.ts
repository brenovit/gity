import { z } from 'zod';
import { runGit } from './git.js';
import {
  isIgnoredPath,
  isSecretPath,
  resolveRepoPath,
  SECRET_EXCLUDE_PATHSPECS,
  toIgnoreExcludePathspecs,
  ToolSafetyError,
} from './safety.js';
import { defineTool } from './tool.js';

const MAX_LINE_CHARS = 300;

export const grepTool = defineTool({
  name: 'grep',
  description:
    'Search tracked and untracked (non-ignored) files for a pattern using git grep. Returns "path:line:text" matches. Secret and ignored files are never searched.',
  schema: z.object({
    pattern: z.string().min(1).max(500).describe('Extended regular expression (or literal text when fixedStrings=true)'),
    path: z.string().min(1).optional().describe('Limit the search to this repo-relative file or directory'),
    ignoreCase: z.boolean().default(false),
    fixedStrings: z.boolean().default(false).describe('Treat the pattern as a literal string'),
    maxResults: z.number().int().min(1).max(500).default(100),
  }),
  mutating: false,
  async run(args, ctx) {
    let scope = '.';
    if (args.path !== undefined) {
      if (args.path.startsWith(':')) throw new ToolSafetyError(`Pathspec magic is not allowed: ${args.path}`);
      const { rel } = await resolveRepoPath(ctx.repoRoot, args.path);
      if (isSecretPath(rel)) throw new ToolSafetyError(`Refusing to search a secret file: ${rel}`);
      if (isIgnoredPath(rel, ctx.ignorePatterns)) {
        throw new ToolSafetyError(`Refusing to search an ignored file (.gityrc): ${rel}`);
      }
      scope = rel === '.' ? '.' : `:(literal)${rel}`;
    }

    const gitArgs = ['grep', '-n', '-I', '--no-color', '--untracked', '--full-name'];
    if (args.ignoreCase) gitArgs.push('-i');
    gitArgs.push(
      args.fixedStrings ? '-F' : '-E',
      '-e',
      args.pattern,
      '--',
      scope,
      ...SECRET_EXCLUDE_PATHSPECS,
      ...toIgnoreExcludePathspecs(ctx.ignorePatterns),
    );

    const r = await runGit(ctx, gitArgs);
    if (r.code === 1 && r.stderr.trim() === '') return { output: '(no matches)' };
    if (r.code !== 0) return { ok: false, output: r.stderr.trim() || `git grep exited with code ${r.code}` };

    const lines = r.stdout
      .split('\n')
      .filter((l) => l.length > 0)
      .filter((l) => {
        const filePath = l.split(':', 1)[0] ?? '';
        return !isSecretPath(filePath) && !isIgnoredPath(filePath, ctx.ignorePatterns);
      });
    const shown = lines
      .slice(0, args.maxResults)
      .map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l));
    if (lines.length > args.maxResults) {
      shown.push(`[${lines.length - args.maxResults} more matches not shown]`);
    }
    return { output: shown.join('\n') };
  },
});
