import type { ItemWrite } from './flyer-pro-enrich.types';

/**
 * O `UPDATE` de um item do job (`a3-job-enriquecimento.html#s8`): um comando só, condicionado ao estado lido no início do
 * lote, com o carimbo do lote em `updatedAt`. Nunca `name`, `price`, `unit`, `ean`, `position`, `sourceName`,
 * `imported`, `isAlcoholic` nem `importId`; nunca `revision` do encarte.
 */

/** O contexto de uma gravação: o carimbo do banco lido depois das travas e os parâmetros do job. */
export interface WriteContext {
  stamp: string;
  jobId: string;
  documentId: string;
  autoApply: boolean;
  /** O critério de `onlyMissing` que vale nesta rodada (da segunda em diante, sempre ligado). */
  onlyMissing: boolean;
  /** A escrita é de uma passada do EAN pendente (`image_ean_retry`): o item ainda pendente não recebe escrita. */
  retry?: boolean;
}

const JSONB_COLUMNS: ReadonlySet<string> = new Set([
  'categoryReview',
  'spellReview',
  'imageReview',
]);
export type Guard = (param: (value: unknown) => string) => string;

/** `UPDATE` do item só nas colunas dadas, com o carimbo, condicionado ao estado lido (`guard`); devolve o `id` se mudou. */
export function itemWrite(
  ctx: WriteContext,
  target: { itemId: string; count: ItemWrite['count']; also?: ItemWrite['also'] },
  columns: Record<string, unknown>,
  guard: Guard,
): ItemWrite {
  const params: unknown[] = [];
  const param = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const sets = Object.entries(columns).map(([name, value]) => {
    const jsonb = JSONB_COLUMNS.has(name);
    const bound = jsonb && value !== null ? JSON.stringify(value) : value;
    return `"${name}" = ${param(bound)}${jsonb ? '::jsonb' : ''}`;
  });
  sets.push(`"updatedAt" = ${param(ctx.stamp)}::timestamptz`);
  const sql = `UPDATE "flyer_pro_items" SET ${sets.join(', ')}
    WHERE "id" = ${param(target.itemId)} AND "documentId" = ${param(ctx.documentId)} AND ${guard(param)}
    RETURNING "id"`;
  return { sql, params, count: target.count, also: target.also };
}

export const review = <E extends object>(ctx: WriteContext, extra: E) => ({
  checkedAt: ctx.stamp,
  jobId: ctx.jobId,
  ...extra,
});
