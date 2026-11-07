import type { ProviderProfile } from '../config.js';
import type { Provider } from '../types.js';
import { ClaudeProvider } from './claude.js';
import { ProviderError } from './errors.js';
import { GeminiProvider } from './gemini.js';
import type { HttpRequestOptions } from './http.js';
import { LmStudioProvider } from './lmstudio.js';
import { OllamaProvider } from './ollama.js';

export type { Provider } from '../types.js';
export { ClaudeProvider } from './claude.js';
export { ProviderError } from './errors.js';
export { GeminiProvider } from './gemini.js';
export { fetchWithRetry, type HttpRequestOptions } from './http.js';
export { LmStudioProvider } from './lmstudio.js';
export { OllamaProvider } from './ollama.js';

export interface ProviderFactoryOptions extends HttpRequestOptions {
  env?: NodeJS.ProcessEnv;
}

export function createProvider(profile: ProviderProfile, options: ProviderFactoryOptions = {}): Provider {
  switch (profile.type) {
    case 'ollama':
      return new OllamaProvider(profile, options);
    case 'lmstudio':
      return new LmStudioProvider(profile, options);
    case 'claude':
      return new ClaudeProvider(profile, options);
    case 'gemini':
      return new GeminiProvider(profile, options);
  }
}
