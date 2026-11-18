import type { WriteContext } from './flyer-pro-enrich.item-write';
import type { EnrichItemRow, ItemWrite } from './flyer-pro-enrich.types';

/** As colunas que o `UPDATE` grava, lidas do `SET` e dos parâmetros (jsonb já em objeto). */
export function columnsOf(write: ItemWrite): Record<string, unknown> {
  const set = write.sql.slice(write.sql.indexOf('SET') + 3, write.sql.indexOf('WHERE'));
  const columns: Record<string, unknown> = {};
  for (const [, name, index] of set.matchAll(/"(\w+)" = \$(\d+)/g)) {
    const value = write.params[Number(index) - 1];
    columns[name] = typeof value === 'string' && value.startsWith('{') ? JSON.parse(value) : value;
  }
  return columns;
}

/** O contexto de uma gravação de teste, com o `autoApply` dado. */
export const writeContext = (
  autoApply: boolean,
  over: Partial<WriteContext> = {},
): WriteContext => ({
  stamp: '2026-11-18T10:00:00.000Z',
  jobId: 'job-1',
  documentId: 'doc-1',
  autoApply,
  onlyMissing: false,
  ...over,
});

/** Um item lido do banco, só com o que as escritas conferem. */
export const itemRow = (over: Partial<EnrichItemRow> = {}): EnrichItemRow =>
  ({
    id: 'i1',
    name: 'X',
    category: null,
    categorySource: null,
    position: 1,
    ...over,
  }) as EnrichItemRow;
