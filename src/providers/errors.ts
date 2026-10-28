export class ProviderError extends Error {
  override name = 'ProviderError';

  constructor(message: string, public readonly statusCode?: number) {
    super(message);
  }
}
