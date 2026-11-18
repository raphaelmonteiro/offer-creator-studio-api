import type { FlyerProImportEntry } from './flyer-pro-import.types';
import type { FlyerProImportIssue } from './flyer-pro.errors';

/**
 * As regras de valor do registro da importação, puras (A-5): só as contagens. O servidor não as compara com os itens
 * do corpo nem o tamanho de `rejected` com `rowCount - acceptedCount`. A forma já foi conferida pelo DTO (400).
 */
export function importIssues(
  entry: Pick<FlyerProImportEntry, 'rowCount' | 'acceptedCount'>,
): FlyerProImportIssue[] {
  if (entry.acceptedCount > entry.rowCount) {
    return [{ field: 'acceptedCount', code: 'COUNT_MISMATCH' }];
  }
  if (entry.acceptedCount === 0) return [{ field: 'acceptedCount', code: 'EMPTY' }];
  return [];
}
