import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd: string;
  /** Kill the process after this many ms (default 15s). */
  timeoutMs?: number;
  /** Stop collecting output beyond this many bytes per stream (default 5 MiB). */
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Exit code, or null if the process was killed by a signal. */
  code: number | null;
  timedOut: boolean;
  /** True when stdout or stderr exceeded `maxBytes` and was cut. */
  overflow: boolean;
}

/**
 * Run a command with an argument array (never through a shell).
 * stdin is closed so commands that would read from it exit immediately.
 * Rejects only when the process cannot be started (e.g. ENOENT).
 */
export function runCommand(cmd: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      signal: opts.signal,
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let overflow = false;
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => {
      if (outLen >= maxBytes) {
        overflow = true;
        return;
      }
      out.push(chunk);
      outLen += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errLen >= maxBytes) {
        overflow = true;
        return;
      }
      err.push(chunk);
      errLen += chunk.length;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf-8'),
        stderr: Buffer.concat(err).toString('utf-8'),
        code,
        timedOut,
        overflow,
      });
    });
  });
}
