import type { AiInvocationUsage } from '../../ai/utils/ai-usage';
import type { EnrichCursor } from './flyer-pro-job.types';

/**
 * O custo do job (A-9): a soma do custo de LLM entregue pelo uso de cada chamada (categorização, ortografia e leitura do
 * nome; embedding e DotCompany ficam fora). Custo desconhecido (modelo sem preço, ou chamada sem uso) deixa `costUsd`
 * nulo até o fim do job, nunca zero: a marca fica em `cursor.costUnknown`, porque a coluna nula também é "nada somado
 * ainda". Lote sem chamada paga (nomes no cache) soma 0, que é custo conhecido.
 */

const MICRO = 1_000_000;

/** O custo do job depois de somar o uso de uma chamada, e se ele já é desconhecido para sempre. */
export interface JobCost {
  costUsd: number | null;
  unknown: boolean;
}

export function addCost(
  current: { costUsd: number | null; cursor: Pick<EnrichCursor, 'costUnknown'> | null },
  usage: Pick<AiInvocationUsage, 'costUsd'> | null | undefined,
): JobCost {
  if (current.cursor?.costUnknown) return { costUsd: null, unknown: true };
  if (!usage) return { costUsd: current.costUsd ?? null, unknown: false };
  if (usage.costUsd === null || usage.costUsd === undefined)
    return { costUsd: null, unknown: true };
  return {
    costUsd: Math.round(((current.costUsd ?? 0) + usage.costUsd) * MICRO) / MICRO,
    unknown: false,
  };
}

/** O cursor com a marca de custo desconhecido ligada (e nunca desligada). */
export const withCostMark = (cursor: EnrichCursor, unknown: boolean): EnrichCursor =>
  unknown ? { ...cursor, costUnknown: true } : cursor;
