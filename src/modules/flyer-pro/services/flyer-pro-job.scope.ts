import type { EntityManager } from 'typeorm';
import { criterionSql } from '../domain/flyer-pro-enrich-criteria';
import type { EnrichPhase, EnrichStep } from '../domain/flyer-pro-job.types';

/**
 * O escopo de um job (os itens do encarte e, com `itemIds`, só os citados) e a conta de quantos itens se encaixam no
 * critério de cada fase. A mesma conta dá o `total` na criação e a conferência final.
 */

/** O escopo: `null` é "todos os itens do encarte"; a lista já só traz ids que são do encarte. */
export type ItemScope = string[] | null;

/** Os ids pedidos que são itens do encarte, sem repetição e na ordem do pedido; ids de outro encarte somem. */
export async function itemsOfDocument(
  manager: EntityManager,
  documentId: string,
  requested: string[],
): Promise<string[]> {
  if (requested.length === 0) return [];
  const rows: Array<{ id: string }> = await manager.query(
    `SELECT id FROM flyer_pro_items WHERE "documentId" = $1 AND id = ANY($2::uuid[])`,
    [documentId, requested],
  );
  const own = new Set(rows.map((row) => row.id));
  return [...new Set(requested)].filter((id) => own.has(id));
}

/** O encarte tem pelo menos um item? */
export async function hasItems(manager: EntityManager, documentId: string): Promise<boolean> {
  const rows = await manager.query(
    `SELECT 1 FROM flyer_pro_items WHERE "documentId" = $1 LIMIT 1`,
    [documentId],
  );
  return rows.length > 0;
}

/** Quantos itens do escopo se encaixam no critério da fase (com o critério de `onlyMissing` dado). */
export async function countEligible(
  manager: EntityManager,
  input: { documentId: string; scope: ItemScope; phase: EnrichPhase; onlyMissing: boolean },
): Promise<number> {
  const params: unknown[] = [input.documentId];
  let scopeSql = '';
  if (input.scope) {
    params.push(input.scope);
    scopeSql = `AND id = ANY($2::uuid[])`;
  }
  const [{ n }] = await manager.query(
    `SELECT count(*)::int AS n FROM flyer_pro_items
      WHERE "documentId" = $1 ${scopeSql} AND ${criterionSql(input.phase, input.onlyMissing)}`,
    params,
  );
  return n;
}

/** O `total` do job: a soma, por fase pedida, dos itens do escopo que se encaixam no critério dela. */
export async function totalOf(
  manager: EntityManager,
  input: {
    documentId: string;
    scope: ItemScope;
    steps: readonly EnrichStep[];
    onlyMissing: boolean;
  },
): Promise<number> {
  let total = 0;
  for (const phase of input.steps) total += await countEligible(manager, { ...input, phase });
  return total;
}
