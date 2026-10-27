import { Logger } from '@nestjs/common';
import { providerErrorFromResponse, TransientProviderError } from './provider-errors';

/** Base HTTP dos adapters: classifica erros em transiente × terminal e respeita Retry-After. */
export abstract class HttpProviderBase {
  protected abstract readonly logger: Logger;

  protected async request<T>(
    url: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const { timeoutMs = 30_000, ...rest } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { ...rest, signal: controller.signal });
    } catch (err) {
      throw new TransientProviderError(`Falha de rede: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw await providerErrorFromResponse(response);
    return (await response.json()) as T;
  }
}
