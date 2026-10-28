import * as p from '@clack/prompts';
import { z } from 'zod';
import {
  addProvider,
  buildProfile,
  getApiKey,
  getConfigPath,
  loadConfig,
  PROVIDER_DEFAULTS,
  ProviderNameSchema,
  ProviderTypeSchema,
  saveConfig,
  type ProviderProfile,
  type ProviderType,
} from '../config.js';
import { testConnection } from '../providers/connection.js';

const MANUAL_MODEL = '__manual__';

/** Exit cleanly when the user presses Ctrl+C / Esc. */
function unwrap<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  return value as Exclude<T, symbol>;
}

/** Adapt a zod schema to a clack `validate` callback. */
function validateWith(schema: z.ZodType) {
  return (value: string | undefined): string | undefined => {
    const result = schema.safeParse((value ?? '').trim());
    return result.success ? undefined : result.error.issues[0]?.message;
  };
}

export async function runSetup(): Promise<void> {
  let config = await loadConfig();
  p.intro('gity setup');

  const type: ProviderType = unwrap(
    await p.select({
      message: 'Which LLM provider do you want to use?',
      options: ProviderTypeSchema.options.map((t) => ({ value: t, label: PROVIDER_DEFAULTS[t].label })),
    }),
  );
  const defaults: { baseUrl: string; modelHint: string; apiKeyEnv?: string } = PROVIDER_DEFAULTS[type];

  const name = unwrap(
    await p.text({
      message: 'Profile name',
      initialValue: type,
      validate: validateWith(ProviderNameSchema),
    }),
  ).trim();

  if (name in config.providers) {
    const overwrite = unwrap(await p.confirm({ message: `Profile "${name}" exists. Overwrite it?`, initialValue: false }));
    if (!overwrite) {
      p.cancel('Nothing changed.');
      return;
    }
  }

  const baseUrl = unwrap(
    await p.text({
      message: 'Base URL',
      initialValue: defaults.baseUrl,
      validate: validateWith(z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' })),
    }),
  ).trim();

  let apiKeyEnv: string | undefined;
  if (defaults.apiKeyEnv) {
    apiKeyEnv = unwrap(
      await p.text({
        message: 'Environment variable holding the API key (the key itself is never stored)',
        initialValue: defaults.apiKeyEnv,
        validate: validateWith(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'invalid environment variable name')),
      }),
    ).trim();
  }

  // Probe the provider with a provisional model so we can offer its model list.
  const probe = buildProfile({ type, baseUrl, apiKeyEnv, model: defaults.modelHint });
  if (apiKeyEnv && !getApiKey(probe)) {
    p.log.warn(`${apiKeyEnv} is not set. Add \`export ${apiKeyEnv}=...\` to ~/.zshrc and open a new terminal.`);
  }

  const spin = p.spinner();
  spin.start(`Connecting to ${baseUrl}`);
  const result = await testConnection(probe);
  if (result.ok) spin.stop(`Connected in ${result.latencyMs}ms`);
  else spin.error(`Connection failed: ${result.error ?? 'unknown error'}`);

  const model = await askModel(result.ok ? result.models : [], defaults.modelHint);
  const profile: ProviderProfile = buildProfile({ type, baseUrl, apiKeyEnv, model });

  if (!result.ok) {
    const saveAnyway = unwrap(await p.confirm({ message: 'Save this profile anyway?', initialValue: true }));
    if (!saveAnyway) {
      p.cancel('Nothing saved.');
      return;
    }
  }

  let makeDefault = !config.defaultProvider || config.defaultProvider === name;
  if (!makeDefault) {
    makeDefault = unwrap(
      await p.confirm({
        message: `Make "${name}" the default provider (currently "${config.defaultProvider}")?`,
        initialValue: true,
      }),
    );
  }

  config = addProvider(config, name, profile, { makeDefault, overwrite: true });
  await saveConfig(config);

  p.note(
    [
      `type:     ${profile.type}`,
      `model:    ${profile.model}`,
      `base URL: ${profile.baseUrl}`,
      ...(apiKeyEnv ? [`api key:  $${apiKeyEnv}`] : []),
      `default:  ${config.defaultProvider === name ? 'yes' : 'no'}`,
    ].join('\n'),
    `Saved "${name}" to ${getConfigPath()}`,
  );
  p.outro('Done! Run `gity provider test` any time to re-check the connection.');
}

async function askModel(available: string[], hint: string): Promise<string> {
  if (available.length > 0) {
    const choice = unwrap(
      await p.select({
        message: 'Model',
        options: [
          ...available.map((m) => ({ value: m, label: m })),
          { value: MANUAL_MODEL, label: 'Enter a model name manually…' },
        ],
        maxItems: 12,
      }),
    );
    if (choice !== MANUAL_MODEL) return choice;
  }
  return unwrap(
    await p.text({
      message: 'Model name',
      placeholder: hint,
      defaultValue: hint,
      validate: (v) => (v !== undefined && v.length > 0 && v.trim() === '' ? 'model is required' : undefined),
    }),
  ).trim();
}
