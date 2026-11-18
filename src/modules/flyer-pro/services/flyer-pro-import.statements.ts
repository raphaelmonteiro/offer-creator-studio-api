import type { EntityManager } from 'typeorm';
import { flyerProImportIdConflict } from '../domain/flyer-pro.errors';
import type { FlyerProImportEntry } from '../domain/flyer-pro-import.types';

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

/**
 * Grava o registro da importação do corpo, com o encarte da rota e o autor do token (`createdAt` pelo padrão da coluna).
 * `ON CONFLICT DO NOTHING` em vez de capturar o `23505`: a violação da chave primária abortaria a transação do `PATCH`
 * (que precisa continuar para devolver o 409 certo), e o `DO NOTHING` espera o outro `PATCH` do mesmo `id` confirmar ou
 * desfazer. Devolve `true` se gravou e `false` se o `id` já existia (deste encarte ou de outro).
 */
export async function insertImport(
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
