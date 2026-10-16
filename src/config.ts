import { z } from 'zod';

/** Supported provider types. */
export const ProviderTypeSchema = z.enum(['ollama', 'lmstudio', 'claude', 'gemini']);
export type ProviderType = z.infer<typeof ProviderTypeSchema>;

/** Base schema for all provider profiles. */
const BaseProviderSchema = z.object({
  type: ProviderTypeSchema,
  model: z.string().default(''),
  baseUrl: z.string().url().default(''),
});

/** Ollama profile: local, no API key needed. */
export const OllamaProviderSchema = BaseProviderSchema.merge(
  z.object({
    type: z.literal('ollama'),
    baseUrl: z.string().url().default('http://localhost:11434'),
  }),
);

/** LM Studio profile: local OpenAI-compatible. */
export const LmStudioProviderSchema = BaseProviderSchema.merge(
  z.object({
    type: z.literal('lmstudio'),
    baseUrl: z.string().url().default('http://localhost:1234/v1'),
  }),
);

/** Claude profile: requires ANTHROPIC_API_KEY env var. */
export const ClaudeProviderSchema = BaseProviderSchema.merge(
  z.object({
    type: z.literal('claude'),
    baseUrl: z.string().url().default('https://api.anthropic.com'),
    apiKeyEnv: z.string().default('ANTHROPIC_API_KEY'),
  }),
);

/** Gemini profile: requires GEMINI_API_KEY env var. */
export const GeminiProviderSchema = BaseProviderSchema.merge(
  z.object({
    type: z.literal('gemini'),
    baseUrl: z
      .string()
      .url()
      .default('https://generativelanguage.googleapis.com/v1beta'),
    apiKeyEnv: z.string().default('GEMINI_API_KEY'),
  }),
);

/** Discriminated union of all provider profiles. */
export const ProviderProfileSchema = z.discriminatedUnion('type', [
  OllamaProviderSchema,
  LmStudioProviderSchema,
  ClaudeProviderSchema,
  GeminiProviderSchema,
]);
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

/** Map of provider name → profile. */
const ProviderMapSchema = z.record(z.string(), ProviderProfileSchema);

/** Full config schema. */
export const ConfigSchema = z.object({
  /** Name of the default provider (key into profiles). */
  defaultProvider: z.string().default(''),
  /** Named provider profiles. */
  providers: ProviderMapSchema.default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Default config values. */
export const DEFAULT_CONFIG: Config = {
  defaultProvider: '',
  providers: {},
};

const CONFIG_DIR = '.config/gity';
const CONFIG_FILE = 'config.json';

function getConfigDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return `${home}/${CONFIG_DIR}`;
}

export function getConfigPath(): string {
  return `${getConfigDir()}/${CONFIG_FILE}`;
}

/**
 * Load config from disk. Returns defaults if file doesn't exist.
 */
export async function loadConfig(): Promise<Config> {
  const fs = await import('node:fs');

  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw);
  const result = ConfigSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    console.warn(`Warning: config.json has validation issues:\n${issues}`);
    return DEFAULT_CONFIG;
  }

  return result.data;
}

/**
 * Save config to disk. Creates directory with 0600 permissions.
 */
export async function saveConfig(config: Config): Promise<void> {
  const fs = await import('node:fs');

  const configPath = getConfigPath();
  const configDir = getConfigDir();

  // Create directory with 0600 permissions
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o600 });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return;
}

/**
 * Get the API key for a provider profile from env vars.
 * Never logs or returns the actual key value in strings.
 */
export function getProviderApiKey(profile: ProviderProfile): string | null {
  const typed = profile as Record<string, unknown>;
  if ('apiKeyEnv' in typed && typeof typed.apiKeyEnv === 'string') {
    const envVar = typed.apiKeyEnv;
    const value = process.env[envVar];
    if (typeof value === 'string') {
      return value;
    }
    return null;
  }
  // Ollama and LM Studio don't need API keys
  return null;
}

/**
 * Mask API keys for display. Replaces everything but first/last 4 chars.
 */
export function maskSecret(value: string | null | undefined): string {
  if (!value || value.length <= 8) {
    return '****';
  }
  return `${value.slice(0, 4)}....${value.slice(-4)}`;
}

/**
 * Check if a provider has a usable API key.
 */
export function hasApiKey(profile: ProviderProfile): boolean {
  const key = getProviderApiKey(profile);
  return key !== null && key.length > 0;
}

/**
 * Validate that a provider profile has all required fields.
 */
export function validateProviderProfile(profile: ProviderProfile): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!profile.model || profile.model.trim() === '') {
    errors.push(`Provider "${profile.type}" requires a model name.`);
  }

  if (profile.type === 'claude' || profile.type === 'gemini') {
    const key = getProviderApiKey(profile);
    if (!key || key.length === 0) {
      errors.push(
        `Provider "${profile.type}" requires env var ${getApiKeyEnv(profile)} to be set.`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Helper to extract apiKeyEnv from a profile. */
function getApiKeyEnv(profile: ProviderProfile): string {
  const typed = profile as Record<string, unknown>;
  if ('apiKeyEnv' in typed && typeof typed.apiKeyEnv === 'string') {
    return typed.apiKeyEnv;
  }
  return 'unknown';
}
