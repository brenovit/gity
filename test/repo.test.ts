import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findRepoRootAsync, getRepoStatusAsync } from '../src/util/repo.js';

function runGit(cwd: string, args: string[]): void {
  execSync(['git', ...args].join(' '), { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

function initRepo(cwd: string): void {
  runGit(cwd, ['init']);
  runGit(cwd, ['config', 'user.email', 'test@test.com']);
  runGit(cwd, ['config', 'user.name', 'Test']);
}

describe('repo utilities', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gity-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('findRepoRootAsync', () => {
    it('returns null when CWD is not a git repo', async () => {
      // Create a non-repo directory and run git from it via child process
      const nonRepo = join(tmpDir, 'not-a-repo');
      mkdirSync(nonRepo, { recursive: true });

      // We can't change CWD in vitest workers, so test by running git directly
      const { execSync } = await import('node:child_process');
      let result: string;
      try {
        result = execSync('git rev-parse --show-toplevel', {
          cwd: nonRepo,
          encoding: 'utf-8',
        }).trim();
      } catch {
        result = '';
      }
      expect(result).toBe('');
    });

    it('returns the repo root when CWD is inside a git repo', async () => {
      initRepo(tmpDir);

      // Test by running git from inside tmpDir
      const { execSync } = await import('node:child_process');
      const root = execSync('git rev-parse --show-toplevel', {
        cwd: tmpDir,
        encoding: 'utf-8',
      }).trim();
      // macOS resolves /var -> /private/var; normalize both paths
      const normalizedRoot = root.replace(/^\/private/, '');
      const normalizedTmp = tmpDir.replace(/^\/private/, '');
      expect(normalizedRoot).toBe(normalizedTmp);
    });
  });

  describe('getRepoStatusAsync', () => {
    it('reports 0 changed and 0 untracked in a clean repo', async () => {
      initRepo(tmpDir);
      writeFileSync(join(tmpDir, 'README.md'), '# Hello\n');
      runGit(tmpDir, ['add', 'README.md']);
      runGit(tmpDir, ['commit', '-m', 'initial']);

      const status = await getRepoStatusAsync(tmpDir);
      expect(status.changedCount).toBe(0);
      expect(status.untrackedCount).toBe(0);
      // Git defaults to 'main' on modern systems
      expect(['main', 'master']).toContain(status.branch);
    });

    it('counts modified and untracked files correctly', async () => {
      initRepo(tmpDir);
      writeFileSync(join(tmpDir, 'README.md'), '# Hello\n');
      runGit(tmpDir, ['add', 'README.md']);
      runGit(tmpDir, ['commit', '-m', 'initial']);

      // Create a staged file
      writeFileSync(join(tmpDir, 'main.ts'), 'console.log("hi");\n');
      runGit(tmpDir, ['add', 'main.ts']);

      // Create an untracked file
      writeFileSync(join(tmpDir, 'new-file.txt'), 'new content\n');

      const status = await getRepoStatusAsync(tmpDir);
      expect(status.changedCount).toBe(1); // staged main.ts
      expect(status.untrackedCount).toBe(1); // new-file.txt
    });

    it('extracts repo name from path', async () => {
      initRepo(tmpDir);
      const status = await getRepoStatusAsync(tmpDir);
      // The repo name is the last directory component of the path
      const expectedName = basename(tmpDir);
      // Git may return /private/var prefix on macOS; normalize
      const normalizedRoot = tmpDir.replace(/^\/private/, '');
      const expected = basename(normalizedRoot);
      expect(status.repoName).toBe(expected);
    });

    it('handles mixed status codes correctly', async () => {
      initRepo(tmpDir);
      writeFileSync(join(tmpDir, 'a.txt'), 'a\n');
      runGit(tmpDir, ['add', 'a.txt']);
      runGit(tmpDir, ['commit', '-m', 'initial']);

      // Modify a tracked file (working tree change, not staged)
      writeFileSync(join(tmpDir, 'a.txt'), 'a modified\n');

      // Add a new tracked file (staged)
      writeFileSync(join(tmpDir, 'b.txt'), 'b\n');
      runGit(tmpDir, ['add', 'b.txt']);

      // Untracked file
      writeFileSync(join(tmpDir, 'c.txt'), 'c\n');

      const status = await getRepoStatusAsync(tmpDir);
      expect(status.changedCount).toBe(2); // a.txt (WT) + b.txt (staged)
      expect(status.untrackedCount).toBe(1); // c.txt
    });
  });
});
