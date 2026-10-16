import { execFile as execFileNode } from 'node:child_process';
import { dirname, basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileNode);

export interface RepoStatus {
  repoName: string;
  branch: string;
  changedCount: number;
  untrackedCount: number;
  summary: string;
}

export async function findRepoRootAsync(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function getRepoStatusAsync(root: string): Promise<RepoStatus> {
  const { stdout: statusOutput } = await execFileAsync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const lines = statusOutput.split('\n').filter((line: string) => line.length > 0);

  let changedCount = 0;
  let untrackedCount = 0;

  for (const line of lines) {
    const staged = line[0];
    const working = line[1];

    if (staged === '?' && working === '?') {
      untrackedCount += 1;
    } else if (staged !== ' ' || working !== ' ') {
      changedCount += 1;
    }
  }

  const { stdout: branchOutput } = await execFileAsync('git', ['branch', '--show-current'], {
    cwd: root,
    encoding: 'utf-8',
  });
  const branch = branchOutput.trim();

  // Normalize /private/var -> /var for consistent naming on macOS
  const normalizedRoot = root.replace(/^\/private/, '');
  const repoName = basename(normalizedRoot);

  return {
    repoName,
    branch,
    changedCount,
    untrackedCount,
    summary: `${changedCount} changed, ${untrackedCount} untracked`,
  };
}
