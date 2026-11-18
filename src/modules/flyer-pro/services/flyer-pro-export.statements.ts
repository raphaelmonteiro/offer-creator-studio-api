import type { EntityManager } from 'typeorm';
import type { FlyerProExportEntry } from '../domain/flyer-pro.types';
import type { FlyerProExportRow } from '../views/flyer-pro-export.view';

/** Os comandos sobre `flyer_pro_exports`: o registro (N8) e o histórico (N9). */

/** A leitura de uma exportação com o nome de quem exportou (`LEFT JOIN`: nulo se o usuário não existe mais). */
const SELECT_WITH_AUTHOR = `SELECT e.*, u."name" AS "createdByName"
       FROM "flyer_pro_exports" e
       LEFT JOIN "users" u ON u."id" = e."createdByUserId"`;

/**
 * Grava o registro do corpo, com o encarte da rota e o autor do token (`createdAt` pelo padrão da coluna; `filePath` e
 * `fileState` ficam nulo e `not_stored`, porque nenhum arquivo é guardado). `ON CONFLICT DO NOTHING` em vez de capturar
 * o `23505`: o `DO NOTHING` espera o outro registro do mesmo `id` confirmar ou desfazer, e a releitura devolve a linha
 * que ficou. Devolve `true` se gravou e `false` se o `id` já existia (deste encarte ou de outro).
 */
export async function insertExportIfAbsent(
  manager: EntityManager,
  documentId: string,
  userId: string,
  entry: FlyerProExportEntry,
): Promise<boolean> {
  const rows: Array<{ id: string }> = await manager.query(
    `INSERT INTO "flyer_pro_exports"
       ("id", "documentId", "documentRevision", "engineVersion", "renderDigest", "format", "options",
        "fileName", "fileSize", "preflight", "createdByUserId")
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11)
     ON CONFLICT ("id") DO NOTHING RETURNING "id"`,
    [
      entry.id,
      documentId,
      entry.documentRevision,
      entry.engineVersion,
      entry.renderDigest,
      entry.format,
      JSON.stringify(entry.options),
      entry.fileName,
      entry.fileSize ?? null,
      entry.preflight ? JSON.stringify(entry.preflight) : null,
      userId,
    ],
  );
  return rows.length > 0;
}

/**
 * A exportação com esse `id`, de qualquer encarte, vivo ou excluído logicamente (a leitura não filtra `deletedAt`):
 * quem chama compara o `documentId` para decidir entre repetição (200) e conflito (409). Sem a linha, `undefined`.
 */
export async function findExportRow(
  manager: EntityManager,
  id: string,
): Promise<FlyerProExportRow | undefined> {
  const [row]: FlyerProExportRow[] = await manager.query(
    `${SELECT_WITH_AUTHOR} WHERE e."id" = $1`,
    [id],
  );
  return row;
}

/** Quantas exportações o encarte tem (o total da paginação). */
export async function countExports(manager: EntityManager, documentId: string): Promise<number> {
  const [{ total }] = await manager.query(
    `SELECT count(*)::int AS total FROM "flyer_pro_exports" WHERE "documentId" = $1`,
    [documentId],
  );
  return total;
}

/**
 * Uma página do histórico: da mais recente para a mais antiga, com `id` decrescente no empate para a página não trocar
 * de lugar entre duas chamadas.
 */
export function pageOfExports(
  manager: EntityManager,
  documentId: string,
  page: { limit: number; offset: number },
): Promise<FlyerProExportRow[]> {
  return manager.query(
    `${SELECT_WITH_AUTHOR}
      WHERE e."documentId" = $1
      ORDER BY e."createdAt" DESC, e."id" DESC
      LIMIT $2 OFFSET $3`,
    [documentId, page.limit, page.offset],
  );
}
