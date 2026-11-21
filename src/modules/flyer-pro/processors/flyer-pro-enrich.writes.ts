import type { EntityManager } from 'typeorm';
import {
  categoryWriteConditionSql,
  spellWriteConditionSql,
} from '../domain/flyer-pro-enrich-criteria';
import type { PhaseCounts } from '../domain/flyer-pro-enrich-rules';
import { canonicalCategory, keepsCurrentCategory } from '../domain/flyer-pro-enrich-category';
import { fitCategoryReview } from '../domain/flyer-pro-enrich-review';
import type {
  CategoryChoice,
  CategoryVerdict,
  SpellVerdict,
} from '../providers/flyer-pro-enrich.port';
import { Guard, itemWrite, review, WriteContext } from './flyer-pro-enrich.item-write';
import { planImage } from './flyer-pro-enrich.writes.image';
import type { EnrichItemRow, ItemWrite, PhaseWork } from './flyer-pro-enrich.types';

/** O que o job escreve em cada item, por fase (o `UPDATE` em si é de `flyer-pro-enrich.item-write.ts`). */

/** Aplica a categoria (certeza, `autoApply` ligado, fora da planilha) ou a deixa como sugestão pendente. */
function categoryWriteOf(
  item: EnrichItemRow,
  choice: { verdict: CategoryChoice; category: string },
  ctx: WriteContext,
  guard: Guard,
): ItemWrite {
  const { verdict, category } = choice;
  const target = (count: ItemWrite['count']) => ({ itemId: item.id, count });
  const suggestion = { category, confidence: verdict.confidence, why: verdict.why ?? null };
  if (verdict.action === 'apply' && ctx.autoApply && item.categorySource !== 'import') {
    const accepted = { ...suggestion, status: 'accepted', auto: true, decidedAt: ctx.stamp };
    return itemWrite(
      ctx,
      target('applied'),
      {
        category,
        categorySource: 'ai',
        categoryReview: fitCategoryReview(review(ctx, { suggestion: accepted })),
      },
      guard,
    );
  }
  const pending = { ...suggestion, status: 'pending' };
  return itemWrite(
    ctx,
    target('suggested'),
    { categoryReview: fitCategoryReview(review(ctx, { suggestion: pending })) },
    guard,
  );
}

function planCategory(
  item: EnrichItemRow,
  verdict: CategoryVerdict,
  ctx: WriteContext,
): ItemWrite | null {
  if (verdict.action === 'unanswered') return null;
  // Estado lido: a mesma categoria com a mesma origem (ou as duas nulas) ainda vale na hora de gravar, e a sugestão não
  // foi recusada nem bloqueada por pessoa no meio do lote.
  const guard: Guard = (p) =>
    `"category" IS NOT DISTINCT FROM ${p(item.category)} AND "categorySource" IS NOT DISTINCT FROM ${p(item.categorySource)} AND ${categoryWriteConditionSql}`;
  const nothing = () =>
    itemWrite(
      ctx,
      { itemId: item.id, count: 'unchanged' },
      { categoryReview: review(ctx, { suggestion: null }) },
      guard,
    );
  if (verdict.action === 'none') return nothing();
  const choice = verdict as CategoryChoice;
  const category = canonicalCategory(choice.category);
  if (!category) return null;
  if (keepsCurrentCategory(item, { ...choice, category }, ctx.autoApply)) return nothing();
  return categoryWriteOf(item, { verdict: choice, category }, ctx, guard);
}

function planSpelling(
  item: EnrichItemRow,
  verdict: SpellVerdict,
  ctx: WriteContext,
): ItemWrite | null {
  if (verdict.action === 'unanswered') return null;
  const guard: Guard = (p) => `"name" = ${p(item.name)} AND ${spellWriteConditionSql}`;
  const fixes = verdict.action === 'suggest' && verdict.value !== item.name;
  const suggestion = fixes
    ? { value: (verdict as { value: string }).value, status: 'pending' }
    : null;
  const spellReview = review(ctx, { checkedName: item.name, suggestion });
  const target = { itemId: item.id, count: fixes ? ('suggested' as const) : ('clean' as const) };
  return itemWrite(ctx, target, { spellReview }, guard);
}

/** Os itens do lote pelo `id`, na ordem; item que o provedor não respondeu fica sem resposta (`unanswered`). */
function verdictFor<V extends { itemId: string }>(verdicts: V[], itemId: string): V | undefined {
  return verdicts.find((verdict) => verdict.itemId === itemId);
}

/** As escritas do lote: uma por item que o provedor respondeu; o item sem resposta continua "falta fazer". */
export function planWrites(work: PhaseWork, ctx: WriteContext): ItemWrite[] {
  const writes: Array<ItemWrite | null> = work.items.map((item) => {
    if (work.phase === 'categorize') {
      const verdict = verdictFor(work.verdicts, item.id);
      return verdict ? planCategory(item, verdict, ctx) : null;
    }
    if (work.phase === 'spellcheck') {
      const verdict = verdictFor(work.verdicts, item.id);
      return verdict ? planSpelling(item, verdict, ctx) : null;
    }
    const verdict = verdictFor(work.verdicts, item.id);
    return verdict ? planImage(item, verdict, ctx) : null;
  });
  return writes.filter((write): write is ItemWrite => write !== null);
}

/** Aplica os `UPDATE` do lote; só o que afetou a linha conta (a condição do estado lido falhou: nada é gravado). */
export async function applyWrites(
  manager: EntityManager,
  writes: ItemWrite[],
): Promise<PhaseCounts> {
  const counts: PhaseCounts = {};
  for (const write of writes) {
    const [rows] = await manager.query(write.sql, write.params);
    if (!rows?.length) continue;
    counts[write.count] = (counts[write.count] ?? 0) + 1;
    if (write.also) counts[write.also] = (counts[write.also] ?? 0) + 1;
  }
  return counts;
}
