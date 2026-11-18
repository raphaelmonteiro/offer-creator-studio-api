import type { EntityManager } from 'typeorm';

/** Os comandos do campo `import` do `PATCH` (N4) sobre `flyer_pro_imports`: ler as conhecidas do encarte e gravar. */

/**
 * Dos ids dados, os que são de importação **deste encarte** (uma leitura só): é o conjunto que o validador dos itens
 * recebe. Uma importação de outro encarte, vivo ou excluído, não entra. Sem ids, nenhuma leitura.
 */
export async function findKnownImportIds(
  manager: EntityManager,
  documentId: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows: Array<{ id: string }> = await manager.query(
    `SELECT "id" FROM "flyer_pro_imports" WHERE "documentId" = $1 AND "id" = ANY($2::uuid[])`,
    [documentId, ids],
  );
  return new Set(rows.map((row) => row.id));
}
