import type { FlyerProDocument } from '../entities/flyer-pro-document.entity';

/**
 * O `UPDATE` do encarte montado à mão: só as colunas dadas, nenhuma outra (um `UPDATE` pelo `UpdateQueryBuilder`
 * acrescentaria `updatedAt` se a coluna fosse `@UpdateDateColumn`). Os nomes das colunas são só os do tipo, nunca texto
 * de pedido. `pagesFrozen` só volta a `false` por aqui, quando uma importação "Substituir" é gravada; quem o liga é o
 * SQL do cursor (`flyer-pro-cursor.service.ts`).
 */
type PlainColumn =
  | 'name'
  | 'clientId'
  | 'sceneId'
  | 'format'
  | 'pageCount'
  | 'pagesFrozen'
  | 'templateSnapshot'
  | 'frame'
  | 'structure'
  | 'card'
  | 'assembly'
  | 'exportPrefs'
  | 'layoutSnapshot'
  | 'layoutDigest'
  | 'renderDigest'
  | 'schemaVersion'
  | 'engineVersion'
  | 'revision'
  | 'lastMutationId'
  | 'updatedByUserId';

export type DocumentColumn = PlainColumn | 'updatedAt';

/** As colunas a gravar; `updatedAt` vai como texto do banco (o carimbo, com microssegundos). */
export type DocumentColumns = Partial<Pick<FlyerProDocument, PlainColumn>> & { updatedAt?: string };

const JSONB_COLUMNS: ReadonlySet<string> = new Set([
  'templateSnapshot',
  'frame',
  'structure',
  'card',
  'assembly',
  'exportPrefs',
  'layoutSnapshot',
]);

/** O valor como o parâmetro do `pg`: objeto jsonb vira texto JSON, o resto segue como veio. */
function paramOf(column: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  return JSONB_COLUMNS.has(column) ? JSON.stringify(value) : value;
}

function castOf(column: string): string {
  if (JSONB_COLUMNS.has(column)) return '::jsonb';
  return column === 'updatedAt' ? '::timestamptz' : '';
}

export interface DocumentUpdate {
  sql: string;
  params: unknown[];
}

/** `UPDATE "flyer_pro_documents" SET ... WHERE "id" = $1 AND "deletedAt" IS NULL [RETURNING ...]`; `$1` é o id. */
export function documentUpdate(
  id: string,
  columns: DocumentColumns,
  returning: DocumentColumn[] = [],
): DocumentUpdate {
  const names = Object.keys(columns);
  const sets = names.map((name, index) => `"${name}" = $${index + 2}${castOf(name)}`);
  const tail = returning.length
    ? ` RETURNING ${returning.map((name) => `"${name}"`).join(', ')}`
    : '';
  return {
    sql: `UPDATE "flyer_pro_documents" SET ${sets.join(', ')} WHERE "id" = $1 AND "deletedAt" IS NULL${tail}`,
    params: [id, ...names.map((name) => paramOf(name, columns[name as DocumentColumn]))],
  };
}
