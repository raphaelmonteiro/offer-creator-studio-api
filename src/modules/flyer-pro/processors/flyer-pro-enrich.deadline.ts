import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import type { BatchFailure } from './flyer-pro-enrich.committer';

/** O prazo da chamada ao provedor estourou: falha transitória `AI_TIMEOUT`. */
export class ProviderDeadlineError extends Error {
  constructor(public readonly deadlineMs: number) {
    super(`A chamada ao provedor passou do prazo de ${deadlineMs} ms`);
  }
}

/**
 * Corre a chamada contra o prazo; o que chegar depois do prazo é descartado (e a rejeição tardia é engolida). Falha ou
 * prazo estourado abortam `controller`: o provedor real cancela as chamadas em andamento em vez de deixá-las correr
 * pagas (o lote será repetido, ou o job termina).
 */
export async function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderDeadlineError(deadlineMs)), deadlineMs);
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** A falha do provedor (ou do prazo) como o job a registra; `null` para qualquer outro erro, que vira `INTERNAL`. */
export function classifyBatchError(error: unknown): BatchFailure | null {
  if (error instanceof ProviderDeadlineError) return { code: 'AI_TIMEOUT', terminal: false };
  if (error instanceof TransientProviderError)
    return { code: 'AI_PROVIDER_ERROR', terminal: false };
  if (error instanceof TerminalProviderError) return { code: 'AI_PROVIDER_ERROR', terminal: true };
  return null;
}
