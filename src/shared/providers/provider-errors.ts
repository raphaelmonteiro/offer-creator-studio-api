/**
 * Classes de erro + retry dos providers HTTP — extraídas de
 * modules/animations/providers/provider.types.ts para src/shared/ (mesmo
 * movimento de queue/state/credits/media-assets: infraestrutura neutra que
 * animations E commercials consomem sem se importarem — lint de boundary no
 * .eslintrc.js). `provider.types.ts` do animations reexporta daqui, então os
 * consumidores existentes não mudam.
 */

/** Erro transiente (5xx/429/timeout) — elegível a retry com backoff. */
export class TransientProviderError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** Erro terminal (política de conteúdo, input inválido) — NUNCA re-tentar. */
export class TerminalProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'provider_rejected',
  ) {
    super(message);
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 1000 }: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!(err instanceof TransientProviderError)) throw err;
      const delay =
        err.retryAfterSeconds != null
          ? err.retryAfterSeconds * 1000
          : baseDelayMs * 2 ** i + Math.random() * 250;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
