import { Logger } from '@nestjs/common';
import {
  ProviderTimeoutError,
  providerErrorFromResponse,
  TransientProviderError,
} from './provider-errors';

/** Opções de uma chamada: o prazo (`timeoutMs`, 30 s) e se ele cobre também a leitura do corpo da resposta. */
export interface HttpProviderRequestInit extends RequestInit {
  timeoutMs?: number;
  /**
   * Padrão `false`: o prazo vale até os cabeçalhos chegarem e a leitura do corpo fica fora dele (o comportamento dos
   * provedores que já existem, cujo `withRetry` poderia repetir uma chamada paga se o corpo lento virasse falha
   * transitória). `true`: o prazo só termina depois do corpo lido (ou do corpo do erro), e o aborto durante a leitura vira
   * `ProviderTimeoutError`, como o aborto antes dos cabeçalhos (change 47, D-orq-267).
   */
  timeoutCoversBody?: boolean;
}

/** Base HTTP dos adapters: classifica erros em transiente × terminal e respeita Retry-After. */
export abstract class HttpProviderBase {
  protected abstract readonly logger: Logger;

  protected async request<T>(url: string, init: HttpProviderRequestInit = {}): Promise<T> {
    const { timeoutMs = 30_000, timeoutCoversBody = false, ...rest } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.send(url, rest, controller);
      if (!timeoutCoversBody) clearTimeout(timer);
      return await this.readBody<T>(response, timeoutCoversBody ? controller : undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  /** O `fetch` com o sinal do prazo; o aborto do próprio prazo (e não uma queda de rede) vira `ProviderTimeoutError`. */
  private async send(
    url: string,
    init: RequestInit,
    controller: AbortController,
  ): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const message = `Falha de rede: ${(err as Error).message}`;
      // O aborto foi do nosso prazo (e não uma queda de rede) só quando o sinal do próprio controller está abortado.
      throw controller.signal.aborted
        ? new ProviderTimeoutError(message)
        : new TransientProviderError(message);
    }
  }

  /**
   * Lê o JSON (ou classifica o erro). Com `covering`, o aborto do prazo durante a leitura vira `ProviderTimeoutError`: o
   * corpo de erro lido pela metade também (`providerErrorFromResponse` engole a falha da leitura e devolveria uma recusa
   * com corpo vazio).
   */
  private async readBody<T>(response: Response, covering?: AbortController): Promise<T> {
    try {
      if (!response.ok) throw await providerErrorFromResponse(response);
      return (await response.json()) as T;
    } catch (err) {
      if (covering?.signal.aborted) {
        throw new ProviderTimeoutError(
          'Falha de rede: prazo esgotado na leitura do corpo da resposta',
        );
      }
      throw err;
    }
  }
}
