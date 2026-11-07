import { DEFAULT_PULL_STRATEGY, describeApiKey, getConfigPath, loadConfig } from '../config.js';

/** Print the config as JSON with API keys shown masked (keys are read from env, never stored). */
export async function configShow(): Promise<void> {
  const config = await loadConfig();
  const providers = Object.fromEntries(
    Object.entries(config.providers).map(([name, p]) => [name, { ...p, apiKey: describeApiKey(p) }]),
  );
  console.log(`# ${getConfigPath()}`);
  console.log(
    JSON.stringify(
      {
        defaultProvider: config.defaultProvider ?? null,
        pullStrategy: config.pullStrategy ?? DEFAULT_PULL_STRATEGY,
        providers,
      },
      null,
      2,
    ),
  );
}

export function configPath(): void {
  console.log(getConfigPath());
}
