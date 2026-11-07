import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCommand, tokenize } from '../src/tools/bash.js';
import {
  executeGitPull,
  getInProgressGitOp,
  pullStrategyArgs,
  validateCommitMessage,
} from '../src/tools/git.js';
import { runTool, toToolSpecs } from '../src/tools/index.js';
import { isIgnoredPath, isInside, isSecretPath, resolveRepoPath, truncate } from '../src/tools/safety.js';
import type { ToolContext } from '../src/tools/tool.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

let base: string;
let repo: string;
let outside: string;
let ctx: ToolContext;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'gity-tools-')));
  repo = join(base, 'repo');
  outside = join(base, 'outside');
  mkdirSync(repo);
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'top secret\n');
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@test.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# Hello\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'initial');
  ctx = { repoRoot: repo };
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('safety: truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });
  it('cuts long text and appends a marker', () => {
    const r = truncate('x'.repeat(50), 10);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('x'.repeat(10))).toBe(true);
    expect(r.text).toContain('[truncated: 40 more chars]');
  });
});

describe('safety: path containment', () => {
  it('isInside handles siblings with a common prefix', () => {
    expect(isInside('/a/repo', '/a/repo/src')).toBe(true);
    expect(isInside('/a/repo', '/a/repo')).toBe(true);
    expect(isInside('/a/repo', '/a/repo-other')).toBe(false);
    expect(isInside('/a/repo', '/a')).toBe(false);
  });

  it('accepts paths inside the repo, including non-existent ones', async () => {
    expect((await resolveRepoPath(repo, 'README.md')).rel).toBe('README.md');
    expect((await resolveRepoPath(repo, 'src/new/file.ts')).rel).toBe('src/new/file.ts');
    expect((await resolveRepoPath(repo, '.')).rel).toBe('.');
  });

  it('rejects ../ escapes and absolute paths outside the repo', async () => {
    await expect(resolveRepoPath(repo, '../outside/secret.txt')).rejects.toThrow(/escapes/);
    await expect(resolveRepoPath(repo, join(outside, 'secret.txt'))).rejects.toThrow(/escapes/);
    await expect(resolveRepoPath(repo, '/etc/passwd')).rejects.toThrow(/escapes/);
  });

  it('rejects symlinks (file and directory) that point outside the repo', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'link.txt'));
    symlinkSync(outside, join(repo, 'linkdir'));
    await expect(resolveRepoPath(repo, 'link.txt')).rejects.toThrow(/symlink/);
    await expect(resolveRepoPath(repo, 'linkdir/secret.txt')).rejects.toThrow(/symlink/);
    await expect(resolveRepoPath(repo, 'linkdir/missing/deeper.txt')).rejects.toThrow(/symlink/);
  });

  it('allows symlinks that stay inside the repo', async () => {
    symlinkSync(join(repo, 'README.md'), join(repo, 'readme-link'));
    expect((await resolveRepoPath(repo, 'readme-link')).rel).toBe('README.md');
  });
});

describe('safety: secret files', () => {
  it.each(['.env', '.env.local', 'config/.env.production', 'cert.pem', 'server.key', 'id_rsa', 'id_rsa.pub', '.ssh/id_ed25519', 'store.p12'])(
    'flags %s',
    (p) => expect(isSecretPath(p)).toBe(true),
  );
  it.each(['README.md', 'src/env.ts', 'keyboard.ts', 'docs/pem-format.md'])('does not flag %s', (p) =>
    expect(isSecretPath(p)).toBe(false),
  );

  it('matches .gityrc ignore patterns (globs, directories, basenames)', () => {
    const patterns = ['dist/**', '*.snap', 'docs/generated'];
    expect(isIgnoredPath('dist/bundle.js', patterns)).toBe(true);
    expect(isIgnoredPath('dist/sub/a.js', patterns)).toBe(true);
    expect(isIgnoredPath('test/foo.snap', patterns)).toBe(true);
    expect(isIgnoredPath('foo.snap', patterns)).toBe(true);
    expect(isIgnoredPath('docs/generated/index.md', patterns)).toBe(true);
    expect(isIgnoredPath('src/index.ts', patterns)).toBe(false);
    expect(isIgnoredPath('docs/guide.md', patterns)).toBe(false);
  });

  it('git_status flags ignored files and git_add / bash / grep refuse them', async () => {
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'out.js'), 'bundle\n');
    writeFileSync(join(repo, 'src.snap'), 'snapshot\n');
    const ignoreCtx: ToolContext = { repoRoot: repo, ignorePatterns: ['dist/**', '*.snap'] };

    const st = await runTool('git_status', {}, ignoreCtx);
    expect(st.output).toContain('[ignored: never stage]');

    const addDist = await runTool('git_add', { paths: ['dist/out.js'] }, ignoreCtx);
    expect(addDist.ok).toBe(false);
    expect(addDist.output).toMatch(/Blocked: .*ignored/);

    const bashSnap = await runTool('bash', { command: 'cat src.snap' }, ignoreCtx);
    expect(bashSnap.ok).toBe(false);
    expect(bashSnap.output).toMatch(/Blocked: .*ignored/);

    const grepRes = await runTool('grep', { pattern: 'bundle' }, ignoreCtx);
    expect(grepRes.output).not.toContain('dist/out.js');
  });

  it('git_commit respects freeform commitStyle override from .gityrc', async () => {
    expect(validateCommitMessage('Update README documentation', 'freeform')).toBeNull();
    expect(validateCommitMessage('Update README documentation.', 'freeform')).toMatch(/period/);

    writeFileSync(join(repo, 'README.md'), '# Freeform\n');
    const freeformCtx: ToolContext = { repoRoot: repo, commitStyle: 'freeform' };
    await runTool('git_add', { paths: ['README.md'] }, freeformCtx);
    const commit = await runTool('git_commit', { message: 'Update README documentation' }, freeformCtx);
    expect(commit.ok).toBe(true);
  });
});

describe('bash: tokenizer and forbidden commands', () => {
  it('splits words and honours quotes/escapes', () => {
    expect(tokenize(`cat 'app/(auth)/page.tsx' "a b" c\\ d`)).toEqual(['cat', 'app/(auth)/page.tsx', 'a b', 'c d']);
  });

  it.each([
    ['ls | wc -l', /Pipes/],
    ['cat README.md > out.txt', /Redirects/],
    ['cat < README.md', /Redirects/],
    ['ls; rm -rf .', /chaining/],
    ['ls && rm x', /chaining/],
    ['ls &', /chaining/],
    ['cat $(echo x)', /not allowed/],
    ['cat `echo x`', /Subshells/],
    ['cat "$(echo x)"', /Subshells/],
    ['echo $HOME', /expansion/],
    ['ls\nrm x', /Multi-line/],
    ["cat 'unterminated", /Unterminated/],
  ])('rejects %j', (cmd, re) => {
    expect(() => tokenize(cmd)).toThrow(re);
  });

  it.each(['rm -rf .', 'git push', 'sh -c ls', 'node -e 1', 'curl http://x', 'find . -delete', 'echo hi'])(
    'rejects non-allowlisted command %j',
    async (cmd) => {
      await expect(checkCommand(cmd, repo)).rejects.toThrow(/not allowed/);
    },
  );

  it.each(['tail -f README.md', 'tree -o out.txt', 'tree -R', 'file -C', 'wc --files0-from=list', 'ls --color'])(
    'rejects dangerous option in %j',
    async (cmd) => {
      await expect(checkCommand(cmd, repo)).rejects.toThrow(/not allowed/);
    },
  );

  it('rejects paths escaping the repo and secret files', async () => {
    writeFileSync(join(repo, '.env'), 'TOKEN=abc\n');
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'link.txt'));
    await expect(checkCommand('cat ../outside/secret.txt', repo)).rejects.toThrow(/escapes/);
    await expect(checkCommand('cat /etc/passwd', repo)).rejects.toThrow(/escapes/);
    await expect(checkCommand('cat link.txt', repo)).rejects.toThrow(/symlink/);
    await expect(checkCommand('cat .env', repo)).rejects.toThrow(/secret/);
  });

  it('runs allowed read-only commands', async () => {
    const r = await runTool('bash', { command: 'head -n 1 README.md' }, ctx);
    expect(r).toMatchObject({ ok: true, output: '# Hello' });
    const pwd = await runTool('bash', { command: 'pwd' }, ctx);
    expect(pwd.output).toBe(repo);
  });

  it('returns blocked results instead of throwing', async () => {
    const r = await runTool('bash', { command: 'cat ../outside/secret.txt' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/^Blocked:/);
    expect(r.output).not.toContain('top secret');
  });
});

describe('git tools', () => {
  it('git_status flags secret files', async () => {
    writeFileSync(join(repo, '.env'), 'TOKEN=abc\n');
    writeFileSync(join(repo, 'a.ts'), 'export {}\n');
    const r = await runTool('git_status', {}, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/\?\? \.env {2}\[secret: never stage\]/);
    expect(r.output).toMatch(/\?\? a\.ts$/m);
  });

  it('git_diff shows changes, excludes secrets, and truncates large output', async () => {
    writeFileSync(join(repo, 'README.md'), `# Hello\n${'line\n'.repeat(5000)}`);
    writeFileSync(join(repo, 'id_rsa'), 'PRIVATE\n');
    git(repo, 'add', '-f', 'id_rsa');
    const r = await runTool('git_diff', {}, { repoRoot: repo, maxOutputChars: 500 });
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.output).toContain('[truncated:');
    const staged = await runTool('git_diff', { staged: true }, ctx);
    expect(staged.output).not.toContain('PRIVATE');
  });

  it('git_diff rejects secret and escaping paths', async () => {
    expect((await runTool('git_diff', { paths: ['.env'] }, ctx)).output).toMatch(/Blocked: .*secret/);
    expect((await runTool('git_diff', { paths: ['../outside'] }, ctx)).output).toMatch(/Blocked: .*escapes/);
  });

  it('git_add refuses secrets, directories, the repo root, escapes and pathspec magic', async () => {
    writeFileSync(join(repo, '.env.local'), 'X=1\n');
    writeFileSync(join(repo, 'key.pem'), 'k\n');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'a\n');
    for (const paths of [['.env.local'], ['key.pem'], ['src'], ['.'], ['../outside/secret.txt'], [':(glob)**']]) {
      const r = await runTool('git_add', { paths }, ctx);
      expect(r.ok, JSON.stringify(paths)).toBe(false);
      expect(r.output).toMatch(/^Blocked:/);
    }
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('git_add + git_commit + git_log happy path', async () => {
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'a\n');
    const add = await runTool('git_add', { paths: ['src/a.ts'] }, ctx);
    expect(add.ok).toBe(true);
    expect(add.output).toContain('src/a.ts');

    const commit = await runTool('git_commit', { message: 'feat: add a' }, ctx);
    expect(commit).toMatchObject({ ok: true });
    expect(commit.output).toMatch(/feat: add a/);

    const log = await runTool('git_log', { limit: 5 }, ctx);
    expect(log.output.split('\n')).toHaveLength(2);
    expect(log.output).toContain('feat: add a');
  });

  it('git_commit fails when nothing is staged and refuses staged secrets', async () => {
    expect((await runTool('git_commit', { message: 'chore: nothing' }, ctx)).output).toMatch(/Nothing is staged/);
    writeFileSync(join(repo, 'server.key'), 'k\n');
    git(repo, 'add', 'server.key');
    const r = await runTool('git_commit', { message: 'chore: oops' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Blocked: Secret files are staged/);
  });

  it('git_add stages deletions of tracked files', async () => {
    rmSync(join(repo, 'README.md'));
    const r = await runTool('git_add', { paths: ['README.md'] }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/D\s+README\.md/);
  });

  it('validates Conventional Commits format, imperative mood, and subject <= 72 chars', async () => {
    expect(validateCommitMessage('feat: add user login')).toBeNull();
    expect(validateCommitMessage('fix(auth): handle expired token\n\nDetailed body here.')).toBeNull();
    expect(validateCommitMessage(`chore: ${'a'.repeat(65)}`)).toBeNull(); // exactly 72 chars

    expect(validateCommitMessage(`chore: ${'a'.repeat(66)}`)).toMatch(/<= 72 characters/);
    expect(validateCommitMessage('update readme')).toMatch(/Conventional Commits/);
    expect(validateCommitMessage('feat: add user login.')).toMatch(/period/);
    expect(validateCommitMessage('feat: added user login')).toMatch(/imperative mood/);
    expect(validateCommitMessage('fix: fixing bug')).toMatch(/imperative mood/);
    expect(validateCommitMessage('feat: add login\nbody without blank line')).toMatch(/blank line/);

    writeFileSync(join(repo, 'README.md'), '# Updated\n');
    await runTool('git_add', { paths: ['README.md'] }, ctx);

    const nonConventional = await runTool('git_commit', { message: 'update readme' }, ctx);
    expect(nonConventional.ok).toBe(false);
    expect(nonConventional.output).toMatch(/Invalid commit message: .*Conventional Commits/);

    const tooLong = await runTool('git_commit', { message: `feat: ${'x'.repeat(70)}` }, ctx);
    expect(tooLong.ok).toBe(false);
    expect(tooLong.output).toMatch(/Invalid commit message: .*<= 72 characters/);
  });

  it('pullStrategyArgs maps strategies to git pull flags', () => {
    expect(pullStrategyArgs('rebase-autostash')).toEqual(['pull', '--rebase', '--autostash']);
    expect(pullStrategyArgs('rebase')).toEqual(['pull', '--rebase']);
    expect(pullStrategyArgs('ff-only')).toEqual(['pull', '--ff-only']);
    expect(pullStrategyArgs('merge')).toEqual(['pull', '--no-rebase']);
    expect(pullStrategyArgs('none')).toEqual([]);
  });

  it('git_pull rebases local commits onto upstream changes (rebase-autostash)', async () => {
    const remote = join(base, 'remote.git');
    git(base, 'init', '--bare', '-q', remote);
    const branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-u', '-q', 'origin', branch);

    // Push a non-conflicting commit from a second clone
    const peer = join(base, 'peer');
    git(base, 'clone', '-q', remote, peer);
    git(peer, 'config', 'user.email', 'peer@test.com');
    git(peer, 'config', 'user.name', 'Peer');
    git(peer, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(peer, 'remote-file.txt'), 'from peer\n');
    git(peer, 'add', 'remote-file.txt');
    git(peer, 'commit', '-q', '-m', 'feat: add remote file');
    git(peer, 'push', '-q', 'origin', branch);

    // Create a local commit + an unstaged change (to verify --autostash)
    writeFileSync(join(repo, 'local-file.txt'), 'from local\n');
    git(repo, 'add', 'local-file.txt');
    git(repo, 'commit', '-q', '-m', 'feat: add local file');
    writeFileSync(join(repo, 'README.md'), '# Hello\nUnstaged work\n');

    const pullRes = await runTool('git_pull', {}, ctx);
    expect(pullRes.ok).toBe(true);

    // Local commit should now be rebased on top of peer's commit, and unstaged work preserved
    const log = git(repo, 'log', '--pretty=format:%s', '-n', '3').trim().split('\n');
    expect(log).toEqual(['feat: add local file', 'feat: add remote file', 'initial']);
    expect(git(repo, 'status', '--porcelain')).toContain('M README.md');
  });

  it('git_pull aborts rebase on conflict and leaves repository in a safe state', async () => {
    const remote = join(base, 'remote.git');
    git(base, 'init', '--bare', '-q', remote);
    const branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-u', '-q', 'origin', branch);

    // Peer modifies README.md and pushes
    const peer = join(base, 'peer');
    git(base, 'clone', '-q', remote, peer);
    git(peer, 'config', 'user.email', 'peer@test.com');
    git(peer, 'config', 'user.name', 'Peer');
    git(peer, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(peer, 'README.md'), '# Peer conflicting change\n');
    git(peer, 'add', 'README.md');
    git(peer, 'commit', '-q', '-m', 'docs: peer update');
    git(peer, 'push', '-q', 'origin', branch);

    // Local repo also modifies README.md on the same line and commits
    writeFileSync(join(repo, 'README.md'), '# Local conflicting change\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'docs: local update');
    const headBeforePull = git(repo, 'rev-parse', 'HEAD').trim();

    const outcome = await executeGitPull(ctx, 'rebase-autostash');
    expect(outcome.ok).toBe(false);
    expect(outcome.conflict).toBe(true);
    expect(outcome.conflictedFiles).toContain('README.md');
    expect(outcome.output).toMatch(/Pull conflict/);
    expect(outcome.output).toMatch(/safe state/);

    // Verify repo is NOT left mid-rebase and local commit + branch are intact
    expect(await getInProgressGitOp(ctx)).toBeNull();
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch);
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(headBeforePull);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
  });

  it('git_pull with merge strategy aborts merge on conflict and leaves repo in a safe state', async () => {
    const remote = join(base, 'remote.git');
    git(base, 'init', '--bare', '-q', remote);
    const branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-u', '-q', 'origin', branch);

    const peer = join(base, 'peer');
    git(base, 'clone', '-q', remote, peer);
    git(peer, 'config', 'user.email', 'peer@test.com');
    git(peer, 'config', 'user.name', 'Peer');
    git(peer, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(peer, 'README.md'), '# Peer merge conflict\n');
    git(peer, 'add', 'README.md');
    git(peer, 'commit', '-q', '-m', 'docs: peer merge update');
    git(peer, 'push', '-q', 'origin', branch);

    writeFileSync(join(repo, 'README.md'), '# Local merge conflict\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-q', '-m', 'docs: local merge update');
    const headBeforePull = git(repo, 'rev-parse', 'HEAD').trim();

    const outcome = await executeGitPull(ctx, 'merge');
    expect(outcome.ok).toBe(false);
    expect(outcome.conflict).toBe(true);
    expect(outcome.conflictedFiles).toContain('README.md');
    expect(await getInProgressGitOp(ctx)).toBeNull();
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(headBeforePull);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
  });
});

describe('grep tool', () => {
  it('finds matches, includes untracked files, skips secrets', async () => {
    writeFileSync(join(repo, 'notes.txt'), 'needle here\n');
    writeFileSync(join(repo, '.env'), 'needle=secret\n');
    const r = await runTool('grep', { pattern: 'needle' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('notes.txt:1:needle here');
    expect(r.output).not.toContain('secret');
  });

  it('reports no matches and caps results', async () => {
    expect((await runTool('grep', { pattern: 'nope-not-here' }, ctx)).output).toBe('(no matches)');
    writeFileSync(join(repo, 'many.txt'), 'hit\n'.repeat(20));
    const r = await runTool('grep', { pattern: 'hit', fixedStrings: true, maxResults: 5 }, ctx);
    expect(r.output.split('\n')).toHaveLength(6);
    expect(r.output).toContain('[15 more matches not shown]');
  });

  it('rejects escaping and secret search paths', async () => {
    expect((await runTool('grep', { pattern: 'x', path: '../outside' }, ctx)).output).toMatch(/Blocked/);
    expect((await runTool('grep', { pattern: 'x', path: '.env' }, ctx)).output).toMatch(/Blocked/);
  });
});

describe('registry', () => {
  it('validates args with zod and reports unknown tools', async () => {
    const bad = await runTool('git_add', { paths: [] }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.output).toMatch(/Invalid arguments for git_add/);
    const unknown = await runTool('rm_rf', {}, ctx);
    expect(unknown).toMatchObject({ ok: false });
    expect(unknown.output).toMatch(/Unknown tool/);
  });

  it('exposes object JSON Schemas without $schema', () => {
    const specs = toToolSpecs();
    expect(specs.map((s) => s.name)).toEqual(['git_status', 'git_diff', 'git_log', 'git_add', 'git_commit', 'git_pull', 'grep', 'bash']);
    for (const s of specs) {
      expect(s.parameters.type).toBe('object');
      expect(s.parameters).not.toHaveProperty('$schema');
    }
  });
});
