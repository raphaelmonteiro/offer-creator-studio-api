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

/** Código estável: fornecedor sem saldo/cota (fal 403 de saldo, ElevenLabs 401/402 de cota, OpenAI, Gemini). */
export const PROVIDER_QUOTA_CODE = 'quota';
/** Código estável: chave do fornecedor inválida, revogada ou expirada (401/403 sem marcador de saldo). */
export const PROVIDER_AUTH_CODE = 'provider_auth';

/** Marcadores de saldo esgotado/cota excedida no corpo da resposta (texto cru, JSON inclusive). */
const QUOTA_BODY_PATTERNS: readonly RegExp[] = [
  /quota_exceeded/i,
  /exceeds your quota/i,
  /exhausted balance/i,
  /user is locked/i,
  /insufficient[_ ](quota|balance|funds|credits?)/i,
  /out of credits?/i,
  /payment[_ ]required/i,
];

export type HttpRejectionKind =
  | 'transient'
  | 'quota'
  | 'provider_auth'
  | 'content_policy'
  | 'provider_rejected';

/**
 * Classifica a resposta HTTP de erro de um fornecedor (design B1 da change
 * video-worker-confiabilidade). Em ordem: 5xx transitório; 402 cota; 401/403/429
 * com marcador de saldo no corpo = cota; 429 sem marcador transitório (limite de
 * taxa); 422 política de conteúdo; 401/403 sem marcador = chave inválida; demais
 * 4xx = recusa comum. Corpo desconhecido nunca vira `quota`.
 */
export function classifyHttpRejection(status: number, body: string): HttpRejectionKind {
  if (status >= 500) return 'transient';
  if (status === 402) return 'quota';
  const hasQuotaMarker = QUOTA_BODY_PATTERNS.some((pattern) => pattern.test(body));
  if ([401, 403, 429].includes(status) && hasQuotaMarker) return 'quota';
  if (status === 429) return 'transient';
  if (status === 422) return 'content_policy';
  if (status === 401 || status === 403) return 'provider_auth';
  return 'provider_rejected';
}

/** Erro tipado para uma resposta HTTP não-ok: lê Retry-After e (fora 5xx) o corpo. Usado pela base HTTP e pelo ElevenLabs. */
export async function providerErrorFromResponse(
  response: Response,
): Promise<TransientProviderError | TerminalProviderError> {
  const retryAfter = Number(response.headers.get('retry-after'));
  const body = response.status >= 500 ? '' : await response.text().catch(() => '');
  return providerErrorForRejection(
    response.status,
    body,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  );
}

/** Erro tipado a partir de status + corpo já lidos. */
export function providerErrorForRejection(
  status: number,
  body: string,
  retryAfterSeconds?: number,
): TransientProviderError | TerminalProviderError {
  const kind = classifyHttpRejection(status, body);
  if (kind === 'transient') return new TransientProviderError(`HTTP ${status}`, retryAfterSeconds);
  return new TerminalProviderError(`HTTP ${status}: ${body.slice(0, 300)}`, kind);
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
