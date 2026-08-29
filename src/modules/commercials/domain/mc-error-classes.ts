import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';

/**
 * Classes de erro do pipeline (plano-comerciais §6.4) — função pura de
 * classificação + política de retry/estorno POR CLASSE, aplicada por todos os
 * processors. Fonte única: mudar a política é mudar este arquivo.
 *
 * | Classe            | Política                                                            |
 * |-------------------|---------------------------------------------------------------------|
 * | transient         | retry 3× com backoff via fila; esgotou → terminal + estorno do step |
 * | content_policy    | terminal SEM retry; estorno; cena failed; projeto needs_attention   |
 * | validation        | terminal SEM retry (input/resposta inválida); mesmo fluxo acima     |
 * | provider_timeout  | terminal (teto duro do poll); estorno                               |
 * | quota             | terminal + evento admin_alert (NÃO liga mc_paused automático)       |
 * | internal          | retry 1×; depois terminal SEM estorno automático (reconciliação)    |
 */
export type McErrorClass =
  | 'transient'
  | 'content_policy'
  | 'validation'
  | 'provider_timeout'
  | 'quota'
  | 'internal';

/** Nº MÁXIMO de execuções (1ª tentativa inclusa) antes do failed terminal. */
export const MC_MAX_EXECUTIONS: Record<McErrorClass, number> = {
  transient: 4, // 1ª execução + 3 retries (plano §6.4)
  internal: 2, // 1ª execução + 1 retry
  content_policy: 1,
  validation: 1,
  provider_timeout: 1,
  quota: 1,
};

/** Backoff dos retries via fila (startAfterSeconds), indexado por nº de execuções já feitas. */
export const MC_RETRY_BACKOFF_S = [15, 30, 60] as const;

export function mcRetryDelayS(executionsSoFar: number): number {
  const index = Math.max(0, Math.min(executionsSoFar - 1, MC_RETRY_BACKOFF_S.length - 1));
  return MC_RETRY_BACKOFF_S[index];
}

/**
 * Classificação: erros dos providers do shared já vêm tipados
 * (Transient/Terminal + code); qualquer outra exceção é `internal`.
 */
export function classifyMcError(err: unknown): McErrorClass {
  if (err instanceof TransientProviderError) return 'transient';
  if (err instanceof TerminalProviderError) {
    if (err.code === 'content_policy') return 'content_policy';
    if (err.code === 'quota') return 'quota';
    return 'validation';
  }
  return 'internal';
}

/** true = re-enfileira (failed → queued) em vez de falhar terminal. */
export function mcShouldRetry(errorClass: McErrorClass, executionsSoFar: number): boolean {
  return executionsSoFar < MC_MAX_EXECUTIONS[errorClass];
}

/**
 * Estorno automático do step no failed terminal (plano §6.4): todas as
 * classes EXCETO `internal` (falha nossa → reconciliação admin, não estorno
 * silencioso que mascare bug de cobrança).
 */
export function mcRefundsOnTerminal(errorClass: McErrorClass): boolean {
  return errorClass !== 'internal';
}

/** Código curto e estável do erro para errorCode/UI (cap de 40 chars da coluna). */
export function mcErrorCode(err: unknown, fallback: string): string {
  if (err instanceof TerminalProviderError) return err.code.slice(0, 40);
  if (err instanceof TransientProviderError) return 'provider_transient';
  return fallback.slice(0, 40);
}
