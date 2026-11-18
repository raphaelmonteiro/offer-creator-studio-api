import type { EntityManager } from 'typeorm';
import { flyerProImportIdConflict } from '../domain/flyer-pro.errors';
import type { FlyerProImportEntry } from '../domain/flyer-pro-import.types';
import type { FlyerProImportRow } from '../views/flyer-pro-import.view';

/** Os comandos sobre `flyer_pro_imports`: o campo `import` do `PATCH` (N4) e o histórico (N13). */

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

/**
 * Grava o registro da importação do corpo, com o encarte da rota e o autor do token (`createdAt` pelo padrão da coluna).
 * `ON CONFLICT DO NOTHING` em vez de capturar o `23505`: a violação da chave primária abortaria a transação do `PATCH`
 * (que precisa continuar para devolver o 409 certo), e o `DO NOTHING` espera o outro `PATCH` do mesmo `id` confirmar ou
 * desfazer. Devolve `true` se gravou e `false` se o `id` já existia (deste encarte ou de outro).
 */
export async function insertImportIfAbsent(
  manager: EntityManager,
  documentId: string,
  userId: string,
  entry: FlyerProImportEntry,
): Promise<boolean> {
  const rows: Array<{ id: string }> = await manager.query(
    `INSERT INTO "flyer_pro_imports"
       ("id", "documentId", "fileName", "fileKind", "fileHash", "detectedFormat", "mode",
        "rowCount", "acceptedCount", "rejected", "createdByUserId")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
     ON CONFLICT ("id") DO NOTHING RETURNING "id"`,
    [
      entry.id,
      documentId,
      entry.fileName,
      entry.fileKind,
      entry.fileHash,
      entry.detectedFormat ?? null,
      entry.mode,
      entry.rowCount,
      entry.acceptedCount,
      JSON.stringify(entry.rejected),
      userId,
    ],
  );
  return rows.length > 0;
}

/**
 * Um `id` que já existia só vale se a importação é deste encarte (reenvio: não grava de novo); de outro encarte, vivo ou
 * excluído logicamente (a leitura não filtra `deletedAt`), é 409. A transação desfaz o `PATCH` inteiro.
 */
export async function assertImportOfDocument(
  manager: EntityManager,
  documentId: string,
  importId: string,
): Promise<void> {
  const [owner]: Array<{ documentId: string }> = await manager.query(
    `SELECT "documentId" FROM "flyer_pro_imports" WHERE "id" = $1`,
    [importId],
  );
  if (owner && owner.documentId !== documentId) throw flyerProImportIdConflict(importId);
}

/** O filtro do histórico: as importações do encarte e, com `fileHash`, só as desse arquivo (comparação exata). */
function historyWhere(documentId: string, fileHash?: string) {
  const params: unknown[] = [documentId];
  let where = `i."documentId" = $1`;
  if (fileHash) {
    params.push(fileHash);
    where += ` AND i."fileHash" = $2`;
  }
  return { where, params };
}

/** Quantas importações o filtro traz (o total da paginação). */
export async function countImports(
  manager: EntityManager,
  documentId: string,
  fileHash?: string,
): Promise<number> {
  const { where, params } = historyWhere(documentId, fileHash);
  const [{ total }] = await manager.query(
    `SELECT count(*)::int AS total FROM "flyer_pro_imports" i WHERE ${where}`,
    params,
  );
  return total;
}

/**
 * Uma página do histórico: da mais recente para a mais antiga, com `id` decrescente no empate para a página não trocar
 * de lugar entre duas chamadas, e o nome de quem importou por `LEFT JOIN` (nulo se o usuário não existe mais).
 */
export function pageOfImports(
  manager: EntityManager,
  filter: { documentId: string; fileHash?: string },
  page: { limit: number; offset: number },
): Promise<FlyerProImportRow[]> {
  const { where, params } = historyWhere(filter.documentId, filter.fileHash);
  return manager.query(
    `SELECT i.*, u."name" AS "createdByName"
       FROM "flyer_pro_imports" i
       LEFT JOIN "users" u ON u."id" = i."createdByUserId"
      WHERE ${where}
      ORDER BY i."createdAt" DESC, i."id" DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, page.limit, page.offset],
  );
}
