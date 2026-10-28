import {
  addProvider,
  buildProfile,
  describeApiKey,
  getConfigPath,
  loadConfig,
  parseProviderType,
  removeProvider,
  resolveProvider,
  saveConfig,
  setDefaultProvider,
  type ProviderProfile,
} from '../config.js';
import { testConnection, type ConnectionResult } from '../providers/connection.js';

function printTable(rows: string[][]): void {
  const widths = rows[0]?.map((_, col) => Math.max(...rows.map((r) => (r[col] ?? '').length))) ?? [];
  for (const row of rows) {
    console.log(`  ${row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd()}`);
  }
}

export async function providerList(): Promise<void> {
  const config = await loadConfig();
  const entries = Object.entries(config.providers);
  if (entries.length === 0) {
    console.log('No providers configured. Run `gity setup` or `gity provider add`.');
    return;
  }
  const rows = [['', 'NAME', 'TYPE', 'MODEL', 'BASE URL', 'API KEY']];
  for (const [name, p] of entries) {
    rows.push([name === config.defaultProvider ? '*' : '', name, p.type, p.model, p.baseUrl, describeApiKey(p)]);
  }
  printTable(rows);
  console.log('\n  * = default');
}

export async function providerShow(name: string): Promise<void> {
  const config = await loadConfig();
  const { profile } = resolveProvider(config, name);
  printProfile(name, profile, name === config.defaultProvider);
}

export function printProfile(name: string, profile: ProviderProfile, isDefault: boolean): void {
  console.log(`  Name:     ${name}${isDefault ? ' (default)' : ''}`);
  console.log(`  Type:     ${profile.type}`);
  console.log(`  Model:    ${profile.model}`);
  console.log(`  Base URL: ${profile.baseUrl}`);
  console.log(`  API key:  ${describeApiKey(profile)}`);
}

export interface ProviderAddOptions {
  type: string;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  default?: boolean;
  force?: boolean;
}

export async function providerAdd(name: string, opts: ProviderAddOptions): Promise<void> {
  const type = parseProviderType(opts.type);
  const profile = buildProfile({ type, model: opts.model, baseUrl: opts.baseUrl, apiKeyEnv: opts.apiKeyEnv });
  const config = addProvider(await loadConfig(), name, profile, { makeDefault: opts.default, overwrite: opts.force });
  await saveConfig(config);
  console.log(`Saved provider "${name}" to ${getConfigPath()}`);
  printProfile(name, profile, config.defaultProvider === name);
}

export async function providerRemove(name: string): Promise<void> {
  const config = removeProvider(await loadConfig(), name);
  await saveConfig(config);
  console.log(`Removed provider "${name}".`);
  console.log(`Default provider: ${config.defaultProvider ?? '(none)'}`);
}

export async function providerUse(name: string): Promise<void> {
  await saveConfig(setDefaultProvider(await loadConfig(), name));
  console.log(`Default provider set to "${name}".`);
}

export async function providerTest(name?: string): Promise<void> {
  const { name: target, profile } = resolveProvider(await loadConfig(), name);
  console.log(`Testing "${target}" (${profile.type} @ ${profile.baseUrl})...`);
  const result = await testConnection(profile);
  printConnectionResult(profile, result).forEach((line) => console.log(`  ${line}`));
  if (!result.ok) process.exitCode = 1;
}

/** Format a connection result as display lines (shared with `gity setup`). */
export function printConnectionResult(profile: ProviderProfile, result: ConnectionResult): string[] {
  if (!result.ok) return [`✗ ${result.error ?? 'Connection failed'}`];
  const lines = [`✓ Connected in ${result.latencyMs}ms (${result.models.length} models available)`];
  if (result.modelFound === false) {
    lines.push(`! Model "${profile.model}" was not found in the provider's model list`);
  }
  return lines;
}
