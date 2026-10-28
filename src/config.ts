import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/** Error with a user-facing message (printed without a stack trace). */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Supported provider types. */
export const ProviderTypeSchema = z.enum(['ollama', 'lmstudio', 'claude', 'gemini']);
export type ProviderType = z.infer<typeof ProviderTypeSchema>;

/** Per-type defaults used by the schema, `provider add` and `gity setup`. */
export const PROVIDER_DEFAULTS = {
  ollama: { label: 'Ollama (local)', baseUrl: 'http://localhost:11434', modelHint: 'llama3.2' },
  lmstudio: { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', modelHint: 'qwen2.5-7b-instruct' },
  claude: {
    label: 'Claude API (Anthropic)',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    modelHint: 'claude-sonnet-4-5',
  },
  gemini: {
    label: 'Gemini API (Google)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GEMINI_API_KEY',
    modelHint: 'gemini-2.5-flash',
  },
} as const satisfies Record<ProviderType, { label: string; baseUrl: string; modelHint: string; apiKeyEnv?: string }>;

const modelField = z.string().trim().min(1, 'model is required');
const envVarField = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name');
const urlField = (fallback: string) =>
  z
    .url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
    .transform((u) => u.replace(/\/+$/, ''))
    .default(fallback);

export const OllamaProfileSchema = z.object({
  type: z.literal('ollama'),
  model: modelField,
  baseUrl: urlField(PROVIDER_DEFAULTS.ollama.baseUrl),
});

export const LmStudioProfileSchema = z.object({
  type: z.literal('lmstudio'),
  model: modelField,
  baseUrl: urlField(PROVIDER_DEFAULTS.lmstudio.baseUrl),
});

export const ClaudeProfileSchema = z.object({
  type: z.literal('claude'),
  model: modelField,
  baseUrl: urlField(PROVIDER_DEFAULTS.claude.baseUrl),
  apiKeyEnv: envVarField.default(PROVIDER_DEFAULTS.claude.apiKeyEnv),
});

export const GeminiProfileSchema = z.object({
  type: z.literal('gemini'),
  model: modelField,
  baseUrl: urlField(PROVIDER_DEFAULTS.gemini.baseUrl),
  apiKeyEnv: envVarField.default(PROVIDER_DEFAULTS.gemini.apiKeyEnv),
});

/** Discriminated union of all provider profiles. */
export const ProviderProfileSchema = z.discriminatedUnion('type', [
  OllamaProfileSchema,
  LmStudioProfileSchema,
  ClaudeProfileSchema,
  GeminiProfileSchema,
]);
export type OllamaProfile = z.infer<typeof OllamaProfileSchema>;
export type LmStudioProfile = z.infer<typeof LmStudioProfileSchema>;
export type ClaudeProfile = z.infer<typeof ClaudeProfileSchema>;
export type GeminiProfile = z.infer<typeof GeminiProfileSchema>;

export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
export type ProviderProfileInput = z.input<typeof ProviderProfileSchema>;

/** Provider profile names: letters, digits, `.`, `_`, `-`. */
export const ProviderNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'use letters, digits, ".", "_" or "-" (max 64 chars)');

/** Full config schema. */
export const ConfigSchema = z
  .object({
    /** Name of the default provider profile (key into `providers`). */
    defaultProvider: z.string().optional(),
    /** Named provider profiles. */
    providers: z.record(ProviderNameSchema, ProviderProfileSchema).default({}),
  })
  .refine((c) => c.defaultProvider === undefined || c.defaultProvider in c.providers, {
    message: 'defaultProvider must reference an existing provider',
    path: ['defaultProvider'],
  });
export type Config = z.infer<typeof ConfigSchema>;

export function defaultConfig(): Config {
  return { providers: {} };
}

/** Config file path: `$GITY_CONFIG` > `$XDG_CONFIG_HOME/gity/config.json` > `~/.config/gity/config.json`. */
export function getConfigPath(): string {
  const override = process.env.GITY_CONFIG;
  if (override) return override;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'gity', 'config.json');
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

/** Load config from disk. Missing file → defaults. Invalid file → ConfigError (never silently reset). */
export async function loadConfig(path: string = getConfigPath()): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return defaultConfig();
    throw err;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(`Config file is not valid JSON: ${path}`);
  }

  const result = ConfigSchema.safeParse(json);
  if (!result.success) {
    throw new ConfigError(`Invalid config at ${path}:\n${formatIssues(result.error)}`);
  }
  return result.data;
}

/** Save config atomically with 0600 permissions (directory 0700). */
export async function saveConfig(config: Config, path: string = getConfigPath()): Promise<void> {
  const validated = ConfigSchema.parse(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}

/** Validate user input into a full profile, applying per-type defaults. */
export function buildProfile(input: ProviderProfileInput): ProviderProfile {
  const result = ProviderProfileSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(`Invalid provider settings:\n${formatIssues(result.error)}`);
  }
  return result.data;
}

export function parseProviderType(value: string): ProviderType {
  const result = ProviderTypeSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigError(`Invalid provider type "${value}". Must be one of: ${ProviderTypeSchema.options.join(', ')}`);
  }
  return result.data;
}

export function assertProviderName(name: string): void {
  const result = ProviderNameSchema.safeParse(name);
  if (!result.success) {
    throw new ConfigError(`Invalid provider name "${name}": ${result.error.issues[0]?.message ?? 'invalid'}`);
  }
}

/** Add (or replace with `overwrite`) a profile. The first profile becomes the default automatically. */
export function addProvider(
  config: Config,
  name: string,
  profile: ProviderProfile,
  opts: { makeDefault?: boolean; overwrite?: boolean } = {},
): Config {
  assertProviderName(name);
  if (name in config.providers && !opts.overwrite) {
    throw new ConfigError(`Provider "${name}" already exists. Use --force to overwrite it.`);
  }
  const providers = { ...config.providers, [name]: profile };
  const defaultProvider = opts.makeDefault || !config.defaultProvider ? name : config.defaultProvider;
  return { ...config, providers, defaultProvider };
}

/** Remove a profile. If it was the default, the first remaining profile (if any) becomes the default. */
export function removeProvider(config: Config, name: string): Config {
  const { [name]: removed, ...providers } = config.providers;
  if (!removed) throw notFound(name);
  let defaultProvider = config.defaultProvider;
  if (defaultProvider === name) defaultProvider = Object.keys(providers)[0];
  return { ...config, providers, defaultProvider };
}

export function setDefaultProvider(config: Config, name: string): Config {
  if (!(name in config.providers)) throw notFound(name);
  return { ...config, defaultProvider: name };
}

/** Resolve a profile by name, or the default profile when no name is given. */
export function resolveProvider(config: Config, name?: string): { name: string; profile: ProviderProfile } {
  const target = name ?? config.defaultProvider;
  if (!target) {
    throw new ConfigError('No default provider configured. Run `gity setup` or `gity provider use <name>`.');
  }
  const profile = config.providers[target];
  if (!profile) throw notFound(target);
  return { name: target, profile };
}

function notFound(name: string): ConfigError {
  return new ConfigError(`Provider "${name}" not found. Run \`gity provider list\` to see configured providers.`);
}

/** Env var holding the API key for this profile (cloud providers only). */
export function getApiKeyEnv(profile: ProviderProfile): string | undefined {
  return profile.type === 'claude' || profile.type === 'gemini' ? profile.apiKeyEnv : undefined;
}

/** Read the API key from the environment. Keys are never stored in the config file. */
export function getApiKey(profile: ProviderProfile, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const envVar = getApiKeyEnv(profile);
  const value = envVar ? env[envVar] : undefined;
  return value && value.length > 0 ? value : undefined;
}

/** Mask a secret for display, keeping at most the first/last 4 chars. */
export function maskSecret(value: string | undefined): string {
  if (!value) return '(not set)';
  if (value.length <= 12) return '****';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Human-readable API key status, e.g. `ANTHROPIC_API_KEY=sk-a…wxyz` or `not required`. */
export function describeApiKey(profile: ProviderProfile, env: NodeJS.ProcessEnv = process.env): string {
  const envVar = getApiKeyEnv(profile);
  if (!envVar) return 'not required';
  return `${envVar}=${maskSecret(getApiKey(profile, env))}`;
}
