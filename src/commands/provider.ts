import { loadConfig, saveConfig, getConfigPath, maskSecret, getProviderApiKey, hasApiKey, validateProviderProfile, ProviderProfile, ProviderType, ProviderTypeSchema } from '../config.js';
import { runSetup } from './setup.js';

function printProviderTable(profiles: Record<string, ProviderProfile>, defaultName: string): void {
  const rows: [string, string, string, string, string][] = [];

  for (const [name, profile] of Object.entries(profiles)) {
    const isDefault = name === defaultName ? '✓' : ' ';
    const keyStatus = hasApiKey(profile) ? '✓' : '✗';
    rows.push([name, profile.type, profile.model, keyStatus, isDefault]);
  }

  if (rows.length === 0) {
    console.log('  No providers configured. Run `gity setup` to add one.');
    return;
  }

  // Calculate column widths (use non-null assertion since we initialize all indices)
  let w0 = 16;
  let w1 = 12;
  let w2 = 30;
  let w3 = 8;
  let w4 = 8;
  for (const row of rows) {
    w0 = Math.max(w0, row[0].length);
    w1 = Math.max(w1, row[1].length);
    w2 = Math.max(w2, (row[2] ?? '').length);
    w3 = Math.max(w3, row[3].length);
    w4 = Math.max(w4, row[4].length);
  }

  const header = ['Name', 'Type', 'Model', 'Key', 'Default']
    .map((h: string, i: number) => {
      const width = [w0, w1, w2, w3, w4][i]!;
      return h.padEnd(width);
    })
    .join('  ');

  const separator = [w0, w1, w2, w3, w4].map((width: number) => '-'.repeat(width)).join('-+-');

  console.log(`  ${header}`);
  console.log(`  ${separator}`);

  const widthArr = [w0, w1, w2, w3, w4];
  for (const row of rows) {
    const line = row.map((val, i) => val.padEnd(widthArr[i]!)).join('  ');
    console.log(`  ${line}`);
  }
}

export async function providerList(): Promise<void> {
  const config = await loadConfig();
  console.log();
  console.log('  Configured providers:');
  console.log();
  printProviderTable(config.providers, config.defaultProvider);
  console.log();
  console.log(`  Default: ${config.defaultProvider || '(none)'} `);
  console.log(`  Config:  ${getConfigPath()}`);
  console.log();
}

export async function providerShow(name: string): Promise<void> {
  const config = await loadConfig();
  const profile = config.providers[name];

  if (!profile) {
    console.error(`Error: Provider "${name}" not found.`);
    console.error('Run `gity provider list` to see available providers.');
    process.exit(1);
  }

  console.log();
  console.log(`  Provider: ${name}`);
  console.log(`  Type:     ${profile.type}`);
  console.log(`  Model:    ${profile.model}`);
  console.log(`  URL:      ${profile.baseUrl}`);

  if ('apiKeyEnv' in profile && typeof (profile as { apiKeyEnv?: string }).apiKeyEnv === 'string') {
    const key = getProviderApiKey(profile);
    if (key && key.length > 0) {
      console.log(`  API key:  (found in env ${profile.apiKeyEnv})`);
    } else {
      console.log(`  API key:  (env var ${profile.apiKeyEnv} not set)`);
    }
  } else {
    console.log(`  API key:  (not required)`);
  }

  const validation = validateProviderProfile(profile);
  if (!validation.valid) {
    console.log();
    console.log('  Validation issues:');
    for (const err of validation.errors) {
      console.log(`    - ${err}`);
    }
  }

  console.log();
  console.log(`  Config:    ${getConfigPath()}`);
  console.log();
}

export async function providerAdd(args: {
  name: string;
  type: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}): Promise<void> {
  const config = await loadConfig();
  const { name, type: typeStr, model, baseUrl, apiKeyEnv } = args;

  // Validate type
  const typeResult = ProviderTypeSchema.safeParse(typeStr);
  if (!typeResult.success) {
    console.error(`Error: Invalid provider type "${typeStr}". Must be one of: ${ProviderTypeSchema.options.join(', ')}`);
    process.exit(1);
  }

  const type = typeResult.data as ProviderType;

  // Build base profile with defaults
  const defaultUrls: Record<ProviderType, string> = {
    ollama: 'http://localhost:11434',
    lmstudio: 'http://localhost:1234/v1',
    claude: 'https://api.anthropic.com',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
  };

  const profile: ProviderProfile = {
    type,
    model: model || '',
    baseUrl: baseUrl || defaultUrls[type],
  } as ProviderProfile;

  // Add apiKeyEnv for cloud providers
  if (type === 'claude' || type === 'gemini') {
    (profile as { apiKeyEnv?: string }).apiKeyEnv = apiKeyEnv || (type === 'claude' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY');
  }

  // Validate
  const validation = validateProviderProfile(profile);
  if (!validation.valid) {
    console.error('Validation errors:');
    for (const err of validation.errors) {
      console.error(`  - ${err}`);
    }
    console.error('\nNote: API key errors are expected if the env var is not set.');
    console.error('You can set it later and re-test with `gity provider test ${name}`.');
  }

  config.providers[name] = profile;

  // Set as default if no default exists yet
  if (!config.defaultProvider) {
    config.defaultProvider = name;
  }

  await saveConfig(config);
  console.log();
  console.log(`Provider "${name}" added to ${getConfigPath()}`);
  console.log(`  Type:    ${profile.type}`);
  console.log(`  Model:   ${profile.model}`);
  console.log(`  URL:     ${profile.baseUrl}`);
  console.log();
}

export async function providerRemove(name: string): Promise<void> {
  const config = await loadConfig();

  if (!config.providers[name]) {
    console.error(`Error: Provider "${name}" not found.`);
    process.exit(1);
  }

  delete config.providers[name];

  // If this was the default, clear it
  if (config.defaultProvider === name) {
    config.defaultProvider = '';
  }

  await saveConfig(config);
  console.log();
  console.log(`Provider "${name}" removed from ${getConfigPath()}`);
  console.log();
}

export async function providerUse(name: string): Promise<void> {
  const config = await loadConfig();

  if (!config.providers[name]) {
    console.error(`Error: Provider "${name}" not found.`);
    console.error('Run `gity provider list` to see available providers.');
    process.exit(1);
  }

  config.defaultProvider = name;
  await saveConfig(config);
  console.log();
  console.log(`Default provider set to "${name}"`);
  console.log();
}

export async function providerTest(name?: string): Promise<void> {
  const config = await loadConfig();
  const targetName = name || config.defaultProvider;

  if (!targetName) {
    console.error('Error: No default provider configured.');
    console.error('Run `gity setup` or `gity provider use <name>` first.');
    process.exit(1);
  }

  const profile = config.providers[targetName];

  if (!profile) {
    console.error(`Error: Provider "${targetName}" not found.`);
    process.exit(1);
  }

  console.log();
  console.log(`Testing provider "${targetName}" (${profile.type}, model: ${profile.model})...`);
  console.log();

  // TODO: Stage 3 — actually test the connection
  // For now, report what we know:
  if (hasApiKey(profile)) {
    console.log(`  API key: found in env var ${(profile as { apiKeyEnv?: string }).apiKeyEnv}`);
  } else {
    const envVar = 'apiKeyEnv' in profile ? (profile as { apiKeyEnv?: string }).apiKeyEnv : 'N/A';
    console.log(`  API key: NOT found in env var ${envVar}`);
    console.log('  (Test will fail until you set the env var)');
  }

  console.log(`  URL:     ${profile.baseUrl}`);
  console.log(`  Model:   ${profile.model}`);
  console.log();
  console.log('Connection test not yet implemented. Coming in Stage 3.');
  console.log('Run `gity setup` to configure your provider interactively.');
  console.log();
}

export async function providerConfigShow(): Promise<void> {
  const config = await loadConfig();
  const configPath = getConfigPath();

  console.log();
  console.log(`Config path: ${configPath}`);
  console.log();

  if (Object.keys(config.providers).length === 0) {
    console.log('No providers configured.');
    console.log('Run `gity setup` to add one.');
    console.log();
    return;
  }

  console.log('Providers:');
  console.log();

  for (const [name, profile] of Object.entries(config.providers)) {
    const isDefault = name === config.defaultProvider;
    console.log(`  ${name}${isDefault ? ' (default)' : ''}:`);
    console.log(`    type:    ${profile.type}`);
    console.log(`    model:   ${profile.model}`);
    console.log(`    url:     ${profile.baseUrl}`);

    if ('apiKeyEnv' in profile && typeof (profile as { apiKeyEnv?: string }).apiKeyEnv === 'string') {
      const key = getProviderApiKey(profile);
      if (key && key.length > 0) {
        console.log(`    api key: (set in env ${profile.apiKeyEnv})`);
      } else {
        console.log(`    api key: (env var ${profile.apiKeyEnv} not set)`);
      }
    }
    console.log();
  }
}

export async function providerConfigPath(): Promise<void> {
  console.log(getConfigPath());
}
