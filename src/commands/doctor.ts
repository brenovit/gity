import { stat } from 'node:fs/promises';
import {
  ConfigError,
  getApiKey,
  getApiKeyEnv,
  getConfigPath,
  getRepoConfigPath,
  loadConfig,
  loadRepoConfig,
  type Config,
  type ProviderProfile,
} from '../config.js';
import { testConnection } from '../providers/connection.js';
import { findRepoRootAsync, getRepoStatusAsync } from '../util/repo.js';
import { runCommand } from '../util/spawn.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  configPath?: string;
  repoRoot?: string | null;
  provider?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  nodeVersion?: string;
}

function parseMajorVersion(version: string): number {
  const cleaned = version.replace(/^v/i, '');
  const major = Number.parseInt(cleaned.split('.')[0] ?? '', 10);
  return Number.isNaN(major) ? 0 : major;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run diagnostic checks across Node.js runtime, git binary, repository state,
 * `.gityrc`, user config, and provider connectivity/authentication.
 */
export async function inspectDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.version;

  // 1. Node.js version (>= 20)
  const major = parseMajorVersion(nodeVersion);
  if (major >= 20) {
    checks.push({
      name: 'Node.js',
      status: 'ok',
      message: `${nodeVersion} (>= 20 required)`,
    });
  } else {
    checks.push({
      name: 'Node.js',
      status: 'fail',
      message: `${nodeVersion} is unsupported (Node.js >= 20 required)`,
    });
  }

  // 2. Git binary
  try {
    const gitRes = await runCommand('git', ['--version'], { cwd: process.cwd(), timeoutMs: 5000 });
    if (gitRes.code === 0) {
      checks.push({
        name: 'Git',
        status: 'ok',
        message: gitRes.stdout.trim() || 'git available',
      });
    } else {
      checks.push({
        name: 'Git',
        status: 'fail',
        message: gitRes.stderr.trim() || `git exited with code ${gitRes.code}`,
      });
    }
  } catch (err) {
    checks.push({
      name: 'Git',
      status: 'fail',
      message: `git binary not found: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 3. Repository & .gityrc
  const repoRoot = options.repoRoot !== undefined ? options.repoRoot : await findRepoRootAsync();
  let repoProviderOverride: string | undefined;
  let repoModelOverride: string | undefined;

  if (!repoRoot) {
    checks.push({
      name: 'Repository',
      status: 'warn',
      message: 'Not inside a git repository',
    });
  } else {
    try {
      const status = await getRepoStatusAsync(repoRoot);
      checks.push({
        name: 'Repository',
        status: 'ok',
        message: `${status.repoName} @ ${status.branch || 'detached HEAD'} (${status.summary})`,
      });
    } catch (err) {
      checks.push({
        name: 'Repository',
        status: 'fail',
        message: `Failed to inspect git repository: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const rcPath = getRepoConfigPath(repoRoot);
    if (await fileExists(rcPath)) {
      try {
        const rc = await loadRepoConfig(repoRoot);
        repoProviderOverride = rc.provider;
        repoModelOverride = rc.model;
        const details: string[] = [];
        if (rc.provider) details.push(`provider=${rc.provider}`);
        if (rc.model) details.push(`model=${rc.model}`);
        if (rc.commitStyle) details.push(`commitStyle=${rc.commitStyle}`);
        if (rc.pullStrategy) details.push(`pullStrategy=${rc.pullStrategy}`);
        if (rc.ignore.length > 0) details.push(`ignore=${rc.ignore.length} pattern(s)`);
        checks.push({
          name: '.gityrc',
          status: 'ok',
          message: `${rcPath}${details.length > 0 ? ` (${details.join(', ')})` : ''}`,
        });
      } catch (err) {
        checks.push({
          name: '.gityrc',
          status: 'fail',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 4. Config file
  const configPath = options.configPath ?? getConfigPath();
  let config: Config | undefined;
  try {
    const exists = await fileExists(configPath);
    config = await loadConfig(configPath);
    const count = Object.keys(config.providers).length;
    if (!exists || count === 0) {
      checks.push({
        name: 'Config',
        status: 'warn',
        message: `No providers configured at ${configPath} (run \`gity setup\`)`,
      });
    } else {
      checks.push({
        name: 'Config',
        status: 'ok',
        message: `${configPath} (${count} provider profile(s), default: ${config.defaultProvider ?? 'none'})`,
      });
    }
  } catch (err) {
    checks.push({
      name: 'Config',
      status: 'fail',
      message: err instanceof ConfigError || err instanceof Error ? err.message : String(err),
    });
  }

  // 5. Provider resolution, API key & connectivity
  if (config && Object.keys(config.providers).length > 0) {
    const targetName = options.provider ?? repoProviderOverride ?? config.defaultProvider;
    if (!targetName) {
      checks.push({
        name: 'Provider',
        status: 'fail',
        message: 'No default provider set. Run `gity provider use <name>`.',
      });
    } else {
      const baseProfile = config.providers[targetName];
      if (!baseProfile) {
        checks.push({
          name: 'Provider',
          status: 'fail',
          message: `Provider "${targetName}" not found in config.`,
        });
      } else {
        const profile: ProviderProfile = repoModelOverride
          ? { ...baseProfile, model: repoModelOverride }
          : baseProfile;

        const keyEnv = getApiKeyEnv(profile);
        if (keyEnv) {
          const keyVal = getApiKey(profile, env);
          if (keyVal) {
            checks.push({
              name: 'API Key',
              status: 'ok',
              message: `${keyEnv} is set`,
            });
          } else {
            checks.push({
              name: 'API Key',
              status: 'fail',
              message: `Environment variable ${keyEnv} is not set for provider "${targetName}"`,
            });
          }
        }

        const conn = await testConnection(profile, { fetchFn: options.fetchFn, env, timeoutMs: 5000 });
        if (!conn.ok) {
          checks.push({
            name: 'Provider',
            status: 'fail',
            message: `${targetName} (${profile.type}:${profile.model} @ ${profile.baseUrl}) — ${conn.error ?? 'Connection failed'}`,
          });
        } else if (conn.modelFound === false) {
          checks.push({
            name: 'Provider',
            status: 'warn',
            message: `${targetName} (${profile.type}:${profile.model}) connected in ${conn.latencyMs}ms, but model "${profile.model}" was not found in model list`,
          });
        } else {
          checks.push({
            name: 'Provider',
            status: 'ok',
            message: `${targetName} (${profile.type}:${profile.model}) connected in ${conn.latencyMs}ms (${conn.models.length} model(s) available)`,
          });
        }
      }
    }
  }

  const ok = checks.every((c) => c.status !== 'fail');
  return { ok, checks };
}

function symbolFor(status: DoctorStatus): string {
  switch (status) {
    case 'ok':
      return '✓';
    case 'warn':
      return '!';
    case 'fail':
      return '✗';
  }
}

/** CLI handler for `gity doctor`. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  console.log('Running gity doctor...\n');
  const report = await inspectDoctor(options);
  const nameWidth = Math.max(...report.checks.map((c) => c.name.length), 10);
  for (const check of report.checks) {
    console.log(`  ${symbolFor(check.status)} ${check.name.padEnd(nameWidth)}  ${check.message}`);
  }
  console.log();
  if (report.ok) {
    console.log('All required checks passed.');
  } else {
    console.log('Some checks failed. Fix the issues above and re-run `gity doctor`.');
    process.exitCode = 1;
  }
  return report;
}

