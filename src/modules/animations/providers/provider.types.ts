export interface ProviderSubmitResult {
  providerJobId: string;
}

export type ProviderJobState = 'processing' | 'succeeded' | 'failed';

export interface ProviderStatusResult {
  state: ProviderJobState;
  /** URL do resultado quando succeeded (vídeo/áudio/imagem). */
  outputUrl?: string;
  errorCode?: string;
  errorMessage?: string;
  costUsd?: number;
}

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
