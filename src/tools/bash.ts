import { z } from 'zod';
import { runCommand } from '../util/spawn.js';
import { isIgnoredPath, isSecretPath, resolveRepoPath, ToolSafetyError } from './safety.js';
import { defineTool } from './tool.js';

export const ALLOWED_COMMANDS = ['ls', 'cat', 'head', 'tail', 'wc', 'file', 'pwd', 'tree'] as const;
type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

/** Short flags that would write files, follow forever, or read paths we can't check. */
const DENIED_FLAGS: Partial<Record<AllowedCommand, string>> = {
  tail: 'fF', // follow forever
  tree: 'oR', // -o writes output to a file, -R writes 00Tree.html files
  file: 'Cfm', // -C compiles a magic file, -f/-m read paths from attached args
};

const METACHAR_REASONS: Record<string, string> = {
  '|': 'Pipes are not allowed',
  '>': 'Redirects are not allowed',
  '<': 'Redirects are not allowed',
  ';': 'Command chaining is not allowed',
  '&': 'Command chaining / background jobs are not allowed',
  '(': 'Subshells are not allowed',
  ')': 'Subshells are not allowed',
  '`': 'Subshells are not allowed',
  $: 'Variable expansion and subshells are not allowed',
};

/**
 * Split a command line into words, honouring single/double quotes and backslash escapes.
 * Any unquoted shell metacharacter (pipes, redirects, chaining, subshells) is rejected,
 * as is command substitution inside double quotes. Nothing is ever passed to a shell.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    const next = command[i + 1];

    if (c === '\n' || c === '\r' || c === '\0') throw new ToolSafetyError('Multi-line commands are not allowed');

    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }

    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '`' || (c === '$' && next === '(')) throw new ToolSafetyError('Subshells are not allowed');
      else if (c === '\\' && next !== undefined && '"\\$`'.includes(next)) {
        cur += next;
        i++;
      } else cur += c;
      continue;
    }

    if (c === ' ' || c === '\t') {
      if (inToken) tokens.push(cur);
      cur = '';
      inToken = false;
    } else if (c === "'" || c === '"') {
      quote = c;
      inToken = true;
    } else if (c === '\\') {
      if (next === undefined) throw new ToolSafetyError('Trailing backslash');
      cur += next;
      inToken = true;
      i++;
    } else if (c in METACHAR_REASONS) {
      throw new ToolSafetyError(`${METACHAR_REASONS[c]}: "${c}"`);
    } else {
      cur += c;
      inToken = true;
    }
  }

  if (quote !== null) throw new ToolSafetyError('Unterminated quote');
  if (inToken) tokens.push(cur);
  return tokens;
}

function isAllowedCommand(name: string): name is AllowedCommand {
  return (ALLOWED_COMMANDS as readonly string[]).includes(name);
}

export interface CheckedCommand {
  cmd: AllowedCommand;
  args: string[];
}

/** Parse and validate a command line against the allowlist and repo/secret/ignore path rules. */
export async function checkCommand(
  command: string,
  repoRoot: string,
  ignorePatterns?: readonly string[],
): Promise<CheckedCommand> {
  const tokens = tokenize(command.trim());
  const [cmd, ...args] = tokens;
  if (cmd === undefined) throw new ToolSafetyError('Empty command');
  if (!isAllowedCommand(cmd)) {
    throw new ToolSafetyError(`Command not allowed: ${cmd}. Allowed: ${ALLOWED_COMMANDS.join(', ')}`);
  }

  const denied = DENIED_FLAGS[cmd] ?? '';
  for (const arg of args) {
    if (arg.startsWith('--')) {
      throw new ToolSafetyError(`Long options are not allowed: ${arg}`);
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const bad = [...arg.slice(1)].find((ch) => denied.includes(ch));
      if (bad !== undefined) throw new ToolSafetyError(`Option -${bad} is not allowed for ${cmd}`);
      continue;
    }
    // Every operand (including option values) must be a path inside the repo and not a secret or ignored file.
    const { rel } = await resolveRepoPath(repoRoot, arg);
    if (isSecretPath(rel)) throw new ToolSafetyError(`Refusing to access a secret file: ${rel}`);
    if (isIgnoredPath(rel, ignorePatterns)) {
      throw new ToolSafetyError(`Refusing to access an ignored file (.gityrc): ${rel}`);
    }
  }

  return { cmd, args };
}

export const bashTool = defineTool({
  name: 'bash',
  description: `Run a single read-only command in the repo root. Allowed: ${ALLOWED_COMMANDS.join(', ')}. No pipes, redirects, chaining, globbing or subshells; paths must stay inside the repo; secret and ignored files are blocked.`,
  schema: z.object({
    command: z.string().min(1).max(1000).describe('e.g. "cat src/index.ts" or "head -n 40 README.md"'),
  }),
  mutating: false,
  async run(args, ctx) {
    const { cmd, args: argv } = await checkCommand(args.command, ctx.repoRoot, ctx.ignorePatterns);
    let r;
    try {
      r = await runCommand(cmd, argv, { cwd: ctx.repoRoot, timeoutMs: 10_000, maxBytes: 1024 * 1024, signal: ctx.signal });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, output: `Command not available: ${cmd}` };
      throw error;
    }
    const parts = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter((s) => s.length > 0);
    if (r.timedOut) parts.push('[command timed out]');
    const output = parts.join('\n');
    if (r.code !== 0) return { ok: false, output: output || `${cmd} exited with code ${r.code}` };
    return { output: output || '(no output)' };
  },
});
