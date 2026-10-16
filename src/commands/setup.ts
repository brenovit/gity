import * as prompts from '@clack/prompts';
import { cancel, log } from '@clack/prompts';
import type { ProviderProfile, ProviderType } from '../config.js';
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  validateProviderProfile,
  getProviderApiKey,
  hasApiKey,
  ProviderTypeSchema,
} from '../config.js';

export async function runSetup(): Promise<void> {
  const config = await loadConfig();

  prompts.intro('gity setup');

  // 1. Choose provider type
  const typeChoice = await prompts.select({
    message: 'Choose a provider:',
    options: [
      { value: 'ollama', label: 'Ollama (local)' },
      { value: 'lmstudio', label: 'LM Studio (local)' },
      { value: 'claude', label: 'Claude API (Anthropic)' },
      { value: 'gemini', label: 'Gemini API (Google)' },
    ],
  });

  if (prompts.isCancel(typeChoice)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const type = typeChoice as ProviderType;

  // 2. Provider name (key in the config)
  const name = (await prompts.text({
    message: 'Provider name (used to reference this profile):',
    placeholder: `${type}-default`,
    initialValue: `${type}-default`,
  })) as string;

  if (prompts.isCancel(name)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  // 3. Model name
  const model = (await prompts.text({
    message: 'Model name:',
    placeholder: type === 'ollama' ? 'llama3.2' : type === 'claude' ? 'claude-sonnet-4-20250514' : 'gemini-2.0-flash',
  })) as string;

  if (prompts.isCancel(model)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  // 4. Base URL (with defaults per provider)
  const defaultUrls: Record<ProviderType, string> = {
    ollama: 'http://localhost:11434',
    lmstudio: 'http://localhost:1234/v1',
    claude: 'https://api.anthropic.com',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
  };

  const baseUrl = (await prompts.text({
    message: 'Base URL:',
    placeholder: defaultUrls[type],
    initialValue: defaultUrls[type],
  })) as string;

  if (prompts.isCancel(baseUrl)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  // 5. API key from env (we only store the env var name, not the key)
  let apiKeyEnv: string | undefined;
  if (type === 'claude') {
    apiKeyEnv = 'ANTHROPIC_API_KEY';
  } else if (type === 'gemini') {
    apiKeyEnv = 'GEMINI_API_KEY';
  }

  // Check if env var is already set
  const existingKey = apiKeyEnv ? process.env[apiKeyEnv] : null;
  if (existingKey && existingKey.length > 0) {
    log.info(`Env var ${apiKeyEnv} is already set.`);
  } else if (apiKeyEnv) {
    const confirmSet = await prompts.confirm({
      message: `Set ${apiKeyEnv} in your shell profile (e.g. ~/.zshrc) and restart your terminal?`,
      initialValue: true,
    });
    if (prompts.isCancel(confirmSet)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }
  }

  // Build the provider profile using the discriminated union
  const profile: ProviderProfile = {
    type,
    model: model.trim(),
    baseUrl: baseUrl.trim(),
  } as ProviderProfile;

  // Add apiKeyEnv for cloud providers
  if (type === 'claude' || type === 'gemini') {
    (profile as { apiKeyEnv?: string }).apiKeyEnv = apiKeyEnv;
  }

  // Validate the profile
  const validation = validateProviderProfile(profile);
  if (!validation.valid) {
    console.error('Validation errors:');
    for (const err of validation.errors) {
      console.error(`  - ${err}`);
    }
    console.error('\nNote: API key errors are expected if the env var is not set.');
    console.error('You can set it later and re-test with `gity provider test ${name}`.');
  }

  // 6. Save to config
  config.providers[name] = profile;

  // Set as default if no default exists yet
  if (!config.defaultProvider) {
    config.defaultProvider = name;
  }

  await saveConfig(config);

  const configPath = getConfigPath();
  console.log();
  log.success(`Provider "${name}" saved to ${configPath}`);
  console.log(`  Type:    ${profile.type}`);
  console.log(`  Model:   ${profile.model}`);
  console.log(`  URL:     ${profile.baseUrl}`);
  if (hasApiKey(profile)) {
    console.log(`  API key: (found in env)`);
  } else {
    const envVar = 'apiKeyEnv' in profile ? (profile as { apiKeyEnv?: string }).apiKeyEnv : 'N/A';
    console.log(`  API key: (env var ${envVar} not set — will fail until set)`);
  }
  console.log(`  Default:  ${config.defaultProvider === name ? 'yes' : 'no'}`);
  console.log();
  prompts.outro('Run `gity provider test` to verify your setup.');
}
