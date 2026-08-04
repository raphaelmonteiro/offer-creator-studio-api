import { Logger } from '@nestjs/common';
import { TerminalProviderError, TransientProviderError } from './provider.types';

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
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after')) || undefined;
      throw new TransientProviderError(`HTTP ${response.status}`, retryAfter);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const code = response.status === 422 ? 'content_policy' : 'provider_rejected';
      throw new TerminalProviderError(`HTTP ${response.status}: ${body.slice(0, 300)}`, code);
    }
    return (await response.json()) as T;
  }
}
