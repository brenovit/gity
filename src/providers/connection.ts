import { z } from 'zod';
import { getApiKey, getApiKeyEnv, type ProviderProfile } from '../config.js';

export interface ConnectionResult {
  ok: boolean;
  latencyMs: number;
  /** Models reported by the provider (empty if unavailable). */
  models: string[];
  /** Whether the configured model appears in `models` (undefined if not checked). */
  modelFound?: boolean;
  /** Error message when `ok` is false. */
  error?: string;
}

export interface ConnectionOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

const OllamaTags = z.object({ models: z.array(z.object({ name: z.string() })) });
const OpenAiModels = z.object({ data: z.array(z.object({ id: z.string() })) });
const GeminiModels = z.object({ models: z.array(z.object({ name: z.string() })).default([]) });

interface Endpoint {
  url: string;
  headers: Record<string, string>;
  parse: (body: unknown) => string[];
}

function endpointFor(profile: ProviderProfile, apiKey: string | undefined): Endpoint {
  switch (profile.type) {
    case 'ollama':
      return {
        url: `${profile.baseUrl}/api/tags`,
        headers: {},
        parse: (b) => OllamaTags.parse(b).models.map((m) => m.name),
      };
    case 'lmstudio':
      return {
        url: `${profile.baseUrl}/models`,
        headers: {},
        parse: (b) => OpenAiModels.parse(b).data.map((m) => m.id),
      };
    case 'claude':
      return {
        url: `${profile.baseUrl}/v1/models?limit=1000`,
        headers: { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' },
        parse: (b) => OpenAiModels.parse(b).data.map((m) => m.id),
      };
    case 'gemini':
      return {
        url: `${profile.baseUrl}/models?pageSize=1000`,
        headers: { 'x-goog-api-key': apiKey ?? '' },
        parse: (b) => GeminiModels.parse(b).models.map((m) => m.name.replace(/^models\//, '')),
      };
  }
}

/** Ollama tags may carry an implicit `:latest` suffix. */
function matchesModel(profile: ProviderProfile, available: string): boolean {
  if (available === profile.model) return true;
  return profile.type === 'ollama' && available === `${profile.model}:latest`;
}

/**
 * Check that a provider is reachable and authenticated by listing its models.
 * Does not send any prompt (chat is covered by the provider adapters).
 */
export async function testConnection(
  profile: ProviderProfile,
  opts: ConnectionOptions = {},
): Promise<ConnectionResult> {
  const { timeoutMs = 5000, fetchFn = fetch, env = process.env } = opts;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  const envVar = getApiKeyEnv(profile);
  const apiKey = getApiKey(profile, env);
  if (envVar && !apiKey) {
    return { ok: false, latencyMs: 0, models: [], error: `Environment variable ${envVar} is not set` };
  }

  const endpoint = endpointFor(profile, apiKey);
  try {
    const res = await fetchFn(endpoint.url, {
      headers: { accept: 'application/json', ...endpoint.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? ' (check your API key)' : '';
      return { ok: false, latencyMs: elapsed(), models: [], error: `HTTP ${res.status} ${res.statusText}${hint}` };
    }
    const models = endpoint.parse(await res.json());
    return {
      ok: true,
      latencyMs: elapsed(),
      models,
      modelFound: models.some((m) => matchesModel(profile, m)),
    };
  } catch (err) {
    return { ok: false, latencyMs: elapsed(), models: [], error: describeError(err, profile.baseUrl, timeoutMs) };
  }
}

function describeError(err: unknown, baseUrl: string, timeoutMs: number): string {
  if (err instanceof z.ZodError) return 'Unexpected response format from provider';
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return `Timed out after ${timeoutMs}ms connecting to ${baseUrl}`;
    if (err instanceof SyntaxError) return 'Provider returned invalid JSON';
    const cause = err.cause instanceof Error ? err.cause.message : '';
    if (/ECONNREFUSED/.test(cause)) return `Connection refused at ${baseUrl} (is the server running?)`;
    return cause ? `${err.message}: ${cause}` : err.message;
  }
  return String(err);
}
