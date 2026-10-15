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

/** Códigos de erro de rede ANTES de a requisição chegar ao servidor (sem geração possível). */
const PRE_REQUEST_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/** Códigos (`code`) do erro do fetch e das suas causas (`cause`, `AggregateError.errors`). */
export function networkErrorCodes(err: unknown): string[] {
  const codes: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 4) return;
    const v = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof v.code === 'string') codes.push(v.code);
    if (Array.isArray(v.errors)) v.errors.forEach((e) => visit(e, depth + 1));
    visit(v.cause, depth + 1);
  };
  visit(err, 0);
  return codes;
}

/**
 * A falha do `fetch` aconteceu antes de a requisição ser entregue (conexão
 * recusada, DNS, timeout de CONEXÃO)? Só aí o retry de uma chamada PAGA é
 * seguro: ElevenLabs e Gemini não têm chave de idempotência, então uma
 * requisição entregue cuja resposta se perdeu (socket fechado, reset, timeout
 * de resposta, ou um `fetch failed` sem código) pode ter sido gerada e
 * cobrada — achado 2 da 3.7 (TTS) e achado 1 da execução real da 2.6 (kit).
 */
export function isPreRequestNetworkError(err: unknown): boolean {
  const codes = networkErrorCodes(err);
  return codes.length > 0 && codes.every((code) => PRE_REQUEST_NETWORK_CODES.has(code));
}

/** Tentativas padrão do `withRetry` (base do cálculo de expiração dos jobs do kit). */
export const PROVIDER_RETRY_ATTEMPTS = 3;

/**
 * Teto da espera pedida pelo fornecedor (Retry-After) entre tentativas: um
 * valor enorme (ou malformado) não segura o job além da expiração da fila.
 */
export const PROVIDER_RETRY_AFTER_MAX_S = 60;

export async function withRetry<T>(
  fn: () => Promise<T>,
  {
    attempts = PROVIDER_RETRY_ATTEMPTS,
    baseDelayMs = 1000,
    onRetry,
  }: {
    attempts?: number;
    baseDelayMs?: number;
    /** Chamado antes de cada nova tentativa (log do retry: o worker não registrava nenhum). */
    onRetry?: (err: TransientProviderError, nextAttempt: number, delayMs: number) => void;
  } = {},
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!(err instanceof TransientProviderError)) throw err;
      // sem espera depois da última tentativa: ninguém mais vai chamar
      if (i === attempts - 1) break;
      const delay =
        err.retryAfterSeconds != null &&
        Number.isFinite(err.retryAfterSeconds) &&
        err.retryAfterSeconds >= 0
          ? Math.min(err.retryAfterSeconds, PROVIDER_RETRY_AFTER_MAX_S) * 1000
          : baseDelayMs * 2 ** i + Math.random() * 250;
      onRetry?.(err, i + 2, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
