import { EntityManager, In } from 'typeorm';
import { DerivedItemFields } from '../domain/flyer-pro-item-derive';
import { ITEM_FIELD_KEYS, ItemFields } from '../domain/flyer-pro-item.types';
import { FlyerProItem } from '../entities/flyer-pro-item.entity';

/** Os comandos do ramo `items` do `PATCH` sobre `flyer_pro_items`: ler, apagar, gravar em lote e contar. */

/** A linha do item pronta para gravar: o que o cliente escreve (mesclado) e o que o servidor derivou. */
export type ItemRow = ItemFields &
  DerivedItemFields & { id: string; documentId: string; importId?: string | null };

const DERIVED_KEYS = [
  'categorySource',
  'categoryReview',
  'imageStatus',
  'imageReview',
  'spellReview',
] as const;

/** As colunas que um `PATCH` escreve em item existente; `id`, `documentId`, `importId` e `createdAt` ficam como estão. */
const WRITE_COLUMNS: readonly string[] = [...ITEM_FIELD_KEYS, ...DERIVED_KEYS];

const quoted = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(', ');

/** Cada linha vira um registro do jsonb; ausente vira nulo, e o `jsonb_populate_recordset` o lê pelo nome da coluna. */
const asRecords = (rows: ItemRow[]): string =>
  JSON.stringify(
    rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v ?? null]))),
  );

const FROM_RECORDS = `FROM jsonb_populate_recordset(NULL::"flyer_pro_items", $1::jsonb) AS r`;

/** Os itens de ids dados, de qualquer encarte (ou só do encarte dado), na ordem de `ids`; os que não existem ficam de fora. */
export async function findItems(
  manager: EntityManager,
  ids: string[],
  documentId?: string,
): Promise<FlyerProItem[]> {
  if (ids.length === 0) return [];
  const found = await manager.find(FlyerProItem, {
    where: { id: In(ids), ...(documentId ? { documentId } : {}) },
  });
  const byId = new Map(found.map((item) => [item.id, item]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)] : []));
}

/** Apaga os ids dados que são do encarte; devolve os realmente apagados. O `query` do `DELETE` devolve `[linhas, n]`. */
export async function deleteItems(
  manager: EntityManager,
  documentId: string,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const [rows] = await manager.query(
    `DELETE FROM "flyer_pro_items" WHERE "documentId" = $1 AND "id" = ANY($2::uuid[]) RETURNING "id"`,
    [documentId, ids],
  );
  return rows.map((row: { id: string }) => row.id);
}

/** `replaceAll`: apaga os itens do encarte que não estão em `keepIds` (lista vazia apaga todos); devolve os apagados. */
export async function deleteItemsExcept(
  manager: EntityManager,
  documentId: string,
  keepIds: string[],
): Promise<string[]> {
  const [rows] = await manager.query(
    `DELETE FROM "flyer_pro_items" WHERE "documentId" = $1 AND NOT ("id" = ANY($2::uuid[])) RETURNING "id"`,
    [documentId, keepIds],
  );
  return rows.map((row: { id: string }) => row.id);
}

/** Insere os itens novos de uma vez, com `importId`; `createdAt` e `updatedAt` levam o carimbo da gravação. */
export async function insertItems(manager: EntityManager, rows: ItemRow[], stamp: string) {
  if (rows.length === 0) return;
  const columns = ['id', 'documentId', 'importId', ...WRITE_COLUMNS];
  await manager.query(
    `INSERT INTO "flyer_pro_items" (${quoted([...columns, 'createdAt', 'updatedAt'])})
     SELECT ${columns.map((name) => `r."${name}"`).join(', ')}, $2::timestamptz, $2::timestamptz ${FROM_RECORDS}`,
    [asRecords(rows), stamp],
  );
}

/** Atualiza os itens existentes do encarte de uma vez, com o carimbo em `updatedAt`. */
export async function updateItems(
  manager: EntityManager,
  documentId: string,
  rows: ItemRow[],
  stamp: string,
) {
  if (rows.length === 0) return;
  const sets = WRITE_COLUMNS.map((name) => `"${name}" = r."${name}"`).join(', ');
  await manager.query(
    `UPDATE "flyer_pro_items" AS i SET ${sets}, "updatedAt" = $2::timestamptz ${FROM_RECORDS}
      WHERE i."id" = r."id" AND i."documentId" = $3`,
    [asRecords(rows), stamp, documentId],
  );
}

export async function countItems(manager: EntityManager, documentId: string): Promise<number> {
  const [{ total }] = await manager.query(
    `SELECT count(*)::int AS total FROM "flyer_pro_items" WHERE "documentId" = $1`,
    [documentId],
  );
  return total;
}
