import { APIConnectionError } from 'openai';
import {
  PROVIDER_AUTH_CODE,
  PROVIDER_RETRY_AFTER_MAX_S,
  TerminalProviderError,
  TransientProviderError,
  withRetry,
} from './provider-errors';

/**
 * Classificação dos erros do SDK `openai` no padrão dos providers HTTP
 * (provider-errors.ts), para quem chama a OpenAI direto pelo SDK:
 *
 * - conta SEM CRÉDITO (`insufficient_quota`, `billing_hard_limit_reached`,
 *   `credit_balance_exhausted` em `code` ou `type`, qualquer status — a OpenAI
 *   responde 429) → `TerminalProviderError('quota')`: NUNCA re-tentar, como o
 *   402/403 do provider Gemini. Repetir só adia a falha (a tentativa de
 *   13/10/2026 reenviou a mesma chamada 9 vezes em 16 s: 3 do `withRetry` × 3
 *   do SDK);
 * - 429 de LIMITE DE TAXA (qualquer outro código), 5xx e falha de rede/timeout
 *   → `TransientProviderError` (o `withRetry` re-tenta com backoff), levando a
 *   espera pedida pela OpenAI (`retry-after-ms` / `retry-after`, até
 *   `PROVIDER_RETRY_AFTER_MAX_S`) — a camada do SDK que a respeitava está
 *   desligada;
 * - o resto (400, 401, 404...) passa como veio (terminal para o `withRetry`).
 *
 * O SDK re-tenta 429/5xx sozinho (2 vezes por padrão) ANTES de o erro chegar
 * aqui: quem usa esta classificação desliga essa camada com
 * `OPENAI_NO_SDK_RETRY` (`maxRetries: 0` por requisição) para o `withRetry`
 * ser o único que decide — e a quota sair na primeira resposta.
 */
export const OPENAI_QUOTA_ERROR_CODES: readonly string[] = [
  'insufficient_quota',
  'billing_hard_limit_reached',
  'credit_balance_exhausted',
];

/** Opções de requisição do SDK sem re-tentativas próprias (o `withRetry` decide). */
export const OPENAI_NO_SDK_RETRY = { maxRetries: 0 } as const;

interface OpenAiErrorShape {
  status?: number;
  headers?: unknown;
  code?: string | null;
  type?: string;
  error?: { code?: string | null; type?: string } | null;
  message?: string;
}

/** Código de quota/cobrança presente no erro (campo `code` ou `type`, no erro ou no corpo), ou null. */
export function openAiQuotaCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as OpenAiErrorShape;
  const fields = [e.code, e.type, e.error?.code, e.error?.type];
  for (const field of fields) {
    if (typeof field === 'string' && OPENAI_QUOTA_ERROR_CODES.includes(field)) return field;
  }
  return null;
}

export function isOpenAiQuotaError(err: unknown): boolean {
  return openAiQuotaCode(err) !== null;
}

function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value = (getter as (n: string) => unknown).call(headers, name);
    return typeof value === 'string' ? value : null;
  }
  const value = (headers as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

/**
 * Espera pedida pela OpenAI num 429/5xx, em segundos (`retry-after-ms`, senão
 * `retry-after` em segundos ou data HTTP), limitada a
 * `PROVIDER_RETRY_AFTER_MAX_S`; null sem cabeçalho legível.
 */
export function openAiRetryAfterSeconds(err: unknown, now: number = Date.now()): number | null {
  const headers = (err as OpenAiErrorShape | null)?.headers;
  let seconds: number | null = null;
  const ms = Number.parseFloat(headerValue(headers, 'retry-after-ms') ?? '');
  if (Number.isFinite(ms) && ms >= 0) {
    seconds = ms / 1000;
  } else {
    const raw = headerValue(headers, 'retry-after');
    if (raw != null && raw.trim() !== '') {
      const asNumber = Number(raw);
      if (Number.isFinite(asNumber) && asNumber >= 0) {
        seconds = asNumber;
      } else {
        const date = Date.parse(raw);
        if (Number.isFinite(date)) seconds = Math.max(0, (date - now) / 1000);
      }
    }
  }
  return seconds == null ? null : Math.min(seconds, PROVIDER_RETRY_AFTER_MAX_S);
}

/** Erro do SDK → erro classificado (ver o cabeçalho); erros já classificados passam como estão. */
export function classifyOpenAiError(err: unknown): unknown {
  if (err instanceof TerminalProviderError || err instanceof TransientProviderError) return err;
  const quota = openAiQuotaCode(err);
  if (quota) {
    return new TerminalProviderError(`OpenAI sem crédito (${quota}): conta sem saldo`, 'quota');
  }
  if (err instanceof APIConnectionError) {
    return new TransientProviderError(`Falha de rede OpenAI: ${err.message}`);
  }
  const status = (err as OpenAiErrorShape | null)?.status;
  if (status === 429 || (typeof status === 'number' && status >= 500)) {
    return new TransientProviderError(`HTTP ${status}`, openAiRetryAfterSeconds(err) ?? undefined);
  }
  return err;
}

/**
 * Classificação do modo estrito (change 28): devolve SEMPRE um erro classificado. Passa por `classifyOpenAiError`
 * (sem crédito é terminal `quota`; 429 de taxa, 5xx, rede e prazo são transitórios; erro já classificado passa como
 * veio); o que sobrar com status 4xx (400, 401, 403, 404...) é terminal; erro sem status (nem código de rede) é
 * transitório, para o job repetir em vez de desistir de um item que nunca foi conferido.
 */
export function classifyOpenAiErrorStrict(
  err: unknown,
): TransientProviderError | TerminalProviderError {
  const classified = classifyOpenAiError(err);
  if (classified instanceof TerminalProviderError || classified instanceof TransientProviderError) {
    return classified;
  }
  const message = (classified as Error | null)?.message ?? 'erro desconhecido';
  const status = (classified as OpenAiErrorShape | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const code = status === 401 || status === 403 ? PROVIDER_AUTH_CODE : undefined;
    return new TerminalProviderError(`OpenAI recusou o pedido (HTTP ${status}): ${message}`, code);
  }
  return new TransientProviderError(message);
}

/**
 * Chamada OpenAI com o `withRetry` do repositório como ÚNICA camada de
 * re-tentativa: a função deve passar `OPENAI_NO_SDK_RETRY` ao SDK. Quota é
 * terminal na primeira resposta; taxa/5xx/rede re-tentam com backoff
 * (`retryConnectionErrors: false` tira rede e prazo estourado da lista).
 */
export function withOpenAiRetry<T>(
  fn: () => Promise<T>,
  options?: { attempts?: number; baseDelayMs?: number; retryConnectionErrors?: boolean },
): Promise<T> {
  const { retryConnectionErrors = true, ...retry } = options ?? {};
  return withRetry(async () => {
    try {
      return await fn();
    } catch (err) {
      // Falha de rede e prazo estourado (`APIConnectionError`, `APIConnectionTimeoutError`) passam como vieram, sem
      // repetição, quando quem chama pede só 429 de taxa e 5xx (change 42, D-5): repetir um prazo é esperar duas vezes.
      if (!retryConnectionErrors && err instanceof APIConnectionError) throw err;
      throw classifyOpenAiError(err);
    }
  }, retry);
}
