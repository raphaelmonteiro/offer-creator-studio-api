import { EntityManager, In } from 'typeorm';
import type { StructureExampleRow } from '../domain/read-structure-example';
import { flyerProNotFound } from '../domain/flyer-pro.errors';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import type { FlyerProFormat } from '../domain/flyer-pro.types';
import type { StructureItemRow } from '../domain/structure-suggestion.types';
import { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import { FlyerProItem } from '../entities/flyer-pro-item.entity';

/** As leituras da sugestão de estrutura (N19): só `SELECT`, nada é gravado. */

export interface StructureDocumentRow {
  id: string;
  name: string;
  format: FlyerProFormat;
  clientId: string;
}

/** O encarte vivo (excluído conta como inexistente): 404 `FLYER_PRO_NOT_FOUND`. Só as colunas que a sugestão usa. */
export async function readLiveDocument(
  manager: EntityManager,
  id: string,
): Promise<StructureDocumentRow> {
  const document = await manager.findOne(FlyerProDocument, {
    where: { id },
    select: { id: true, name: true, format: true, clientId: true },
  });
  if (!document) throw flyerProNotFound();
  const { name, format, clientId } = document;
  return { id, name, format, clientId };
}

/** Os ids do pedido que são itens do encarte, com o que o provedor lê do banco; o que não é do encarte não volta. */
export async function readItemsOf(
  manager: EntityManager,
  documentId: string,
  ids: string[],
): Promise<StructureItemRow[]> {
  const rows = await manager.find(FlyerProItem, {
    where: { documentId, id: In(ids) },
    select: { id: true, name: true, price: true, unit: true, category: true, imageUrl: true },
  });
  return rows.map(({ id, name, price, unit, category, imageUrl }) => ({
    id,
    name,
    price,
    unit,
    category,
    imageUrl,
  }));
}

/**
 * Os encartes anteriores do mesmo cliente que chegaram à Montagem (`pagesFrozen`), do mais recente para o mais antigo,
 * pelo índice `IDX_flyer_pro_documents_client`. É a única leitura de fatia do servidor; quem a lê é o leitor tolerante.
 */
const EXAMPLES_SQL = `SELECT "format", "pageCount", "schemaVersion", "structure"
  FROM "flyer_pro_documents"
 WHERE "clientId" = $1 AND "id" <> $2 AND "deletedAt" IS NULL AND "pagesFrozen" = true
 ORDER BY "updatedAt" DESC
 LIMIT $3`;

export function readExampleRows(
  manager: EntityManager,
  document: StructureDocumentRow,
): Promise<StructureExampleRow[]> {
  return manager.query(EXAMPLES_SQL, [
    document.clientId,
    document.id,
    FLYER_PRO_LIMITS.structureExamplesReadMax,
  ]);
}
