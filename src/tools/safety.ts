import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Default cap for tool output sent back to the model. */
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

export class ToolSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolSafetyError';
  }
}

export interface Truncated {
  text: string;
  truncated: boolean;
}

/** Cut `text` to `max` chars, appending a "[truncated]" marker when cut. */
export function truncate(text: string, max: number = DEFAULT_MAX_OUTPUT_CHARS): Truncated {
  if (text.length <= max) return { text, truncated: false };
  const omitted = text.length - max;
  return { text: `${text.slice(0, max)}\n[truncated: ${omitted} more chars]`, truncated: true };
}

/** True if `target` is `root` itself or lies beneath it (both must be absolute). */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** realpath of `p`, or of its nearest existing ancestor joined with the missing remainder. */
async function realpathLenient(p: string): Promise<string> {
  const missing: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length > 0 ? join(real, ...missing.reverse()) : real;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
      const parent = dirname(current);
      if (parent === current) return p;
      missing.push(basename(current));
      current = parent;
    }
  }
}

export interface RepoPath {
  /** Absolute, symlink-resolved path. */
  abs: string;
  /** Path relative to the (real) repo root, using `/` separators; `.` for the root. */
  rel: string;
}

/**
 * Resolve a user/model-supplied path against the repo root and verify it stays inside,
 * both lexically and after resolving symlinks. Non-existent paths are allowed
 * (e.g. deleted files) as long as their existing ancestors resolve inside the repo.
 */
export async function resolveRepoPath(root: string, input: string): Promise<RepoPath> {
  if (input.includes('\0')) throw new ToolSafetyError('Path contains a NUL byte');
  const realRoot = await realpath(root);
  const lexical = resolve(realRoot, input);
  if (!isInside(realRoot, lexical)) {
    throw new ToolSafetyError(`Path escapes the repository: ${input}`);
  }
  const real = await realpathLenient(lexical);
  if (!isInside(realRoot, real)) {
    throw new ToolSafetyError(`Path resolves outside the repository (symlink): ${input}`);
  }
  const rel = relative(realRoot, real).split(sep).join('/');
  return { abs: real, rel: rel === '' ? '.' : rel };
}

const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /^\.env/i, // .env, .env.local, .envrc ...
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i, // id_rsa, id_rsa.pub, id_ed25519 ...
];

/** True if the path's file name matches a known secret pattern. */
export function isSecretPath(p: string): boolean {
  const name = p.split(/[\\/]/).filter(Boolean).pop() ?? '';
  return SECRET_NAME_PATTERNS.some((re) => re.test(name));
}

/** Git pathspecs that exclude secret files from diff/grep output. */
export const SECRET_EXCLUDE_PATHSPECS: readonly string[] = [
  ':(exclude,glob,icase)**/.env*',
  ':(exclude,glob,icase)**/*.pem',
  ':(exclude,glob,icase)**/*.key',
  ':(exclude,glob,icase)**/*.p12',
  ':(exclude,glob,icase)**/*.pfx',
  ':(exclude,glob,icase)**/id_rsa*',
  ':(exclude,glob,icase)**/id_dsa*',
  ':(exclude,glob,icase)**/id_ecdsa*',
  ':(exclude,glob,icase)**/id_ed25519*',
];
