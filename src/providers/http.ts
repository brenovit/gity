import { ProviderError } from './errors.js';

export interface HttpRequestOptions {
  /** Per-request timeout in ms (default 60_000). */
  timeoutMs?: number;
  /** Maximum retry attempts on network/transient errors (default 2). */
  maxRetries?: number;
  /** Base backoff delay in ms (default 250). */
  retryDelayMs?: number;
  /** Custom sleep function (used by tests to avoid real waits). */
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Custom fetch function. */
  fetchFn?: typeof fetch;
}

export const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_DELAY_MS = 250;

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

function isAbortLikeError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Execute an HTTP request with per-request `AbortSignal.timeout` and exponential backoff retries
 * for transient network failures or retryable HTTP status codes (408, 429, 500, 502, 503, 504).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: HttpRequestOptions & { providerLabel: string; signal?: AbortSignal },
): Promise<Response> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const sleepFn = options.sleepFn ?? defaultSleep;
  const callerSignal = options.signal;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (callerSignal?.aborted) {
      throw callerSignal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' });
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;

    try {
      const res = await fetchFn(url, {
        ...init,
        signal: combinedSignal,
      });

      if (!res.ok && RETRYABLE_STATUS_CODES.has(res.status) && attempt < maxRetries) {
        const delay = retryDelayMs * 2 ** attempt;
        await sleepFn(delay, callerSignal);
        continue;
      }

      return res;
    } catch (err) {
      if (callerSignal?.aborted) {
        throw callerSignal.reason ?? (isAbortLikeError(err) ? err : Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      }
      if (timeoutSignal.aborted || (err instanceof Error && err.name === 'TimeoutError')) {
        if (attempt < maxRetries) {
          const delay = retryDelayMs * 2 ** attempt;
          await sleepFn(delay, callerSignal);
          continue;
        }
        const timeoutErr = new ProviderError(
          `Request to ${options.providerLabel} at ${url} timed out after ${timeoutMs}ms`,
        );
        timeoutErr.name = 'TimeoutError';
        throw timeoutErr;
      }
      if (isAbortLikeError(err)) {
        throw err;
      }
      if (attempt < maxRetries) {
        const delay = retryDelayMs * 2 ** attempt;
        await sleepFn(delay, callerSignal);
        continue;
      }
      throw new ProviderError(
        `Failed to connect to ${options.providerLabel} at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  throw new ProviderError(`Failed to connect to ${options.providerLabel} at ${url}`);
}

/**
 * Iterate over newline-delimited lines from a `ReadableStream<Uint8Array>`.
 */
export async function* readLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      if (signal?.aborted) {
        throw signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' });
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
        buffer = buffer.slice(newlineIdx + 1);
        yield line;
        newlineIdx = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      yield buffer.replace(/\r$/, '');
    }
  } finally {
    reader.releaseLock();
  }
}

