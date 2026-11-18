import type { EntityManager } from 'typeorm';
import {
  categoryWriteConditionSql,
  imageWriteConditionSql,
  spellWriteConditionSql,
} from '../domain/flyer-pro-enrich-criteria';
import type { PhaseCounts } from '../domain/flyer-pro-enrich-rules';
import { canonicalCategory, keepsCurrentCategory } from '../domain/flyer-pro-enrich-category';
import { fitCategoryReview } from '../domain/flyer-pro-enrich-review';
import type {
  CategoryChoice,
  CategoryVerdict,
  ImageApply,
  ImageCandidateVerdict,
  ImageVerdict,
  SpellVerdict,
} from '../providers/flyer-pro-enrich.port';
import type { EnrichItemRow, ItemWrite, PhaseWork } from './flyer-pro-enrich.types';

/**
 * O que o job escreve em cada item (`a3-job-enriquecimento.html#s8`): um `UPDATE` de um comando só por item,
 * condicionado ao estado lido no início do lote, com o carimbo do lote em `updatedAt`. Nunca `name`, `price`, `unit`,
 * `ean`, `position`, `sourceName`, `imported`, `isAlcoholic` nem `importId`; nunca `revision` do encarte.
 */

/** O contexto de uma gravação: o carimbo do banco lido depois das travas e os parâmetros do job. */
export interface WriteContext {
  stamp: string;
  jobId: string;
  documentId: string;
  autoApply: boolean;
  /** O critério de `onlyMissing` que vale nesta rodada (da segunda em diante, sempre ligado). */
  onlyMissing: boolean;
}

const JSONB_COLUMNS: ReadonlySet<string> = new Set([
  'categoryReview',
  'spellReview',
  'imageReview',
]);
/** Revisão de IA do item: no máximo 4 KB. */
const REVIEW_MAX_BYTES = 4096;
const MAX_CANDIDATES = 3;

type Guard = (param: (value: unknown) => string) => string;

/** `UPDATE` do item só nas colunas dadas, com o carimbo, condicionado ao estado lido (`guard`); devolve o `id` se mudou. */
function itemWrite(
  ctx: WriteContext,
  target: { itemId: string; count: ItemWrite['count'] },
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
  return { sql, params, count: target.count };
}

const review = <E extends object>(ctx: WriteContext, extra: E) => ({
  checkedAt: ctx.stamp,
  jobId: ctx.jobId,
  ...extra,
});

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

const NO_PHOTO = {
  galleryImageId: null,
  imageUrl: null,
  imageWidth: null,
  imageHeight: null,
  imageOrigin: null,
};

/** Candidata no tamanho que a revisão aceita: motivos curtos primeiro, sem motivo se ainda passar de 4 KB. */
function fitCandidates(candidates: ImageCandidateVerdict[]): ImageCandidateVerdict[] {
  const picked = candidates.slice(0, MAX_CANDIDATES);
  const fits = (list: ImageCandidateVerdict[]) => JSON.stringify(list).length <= REVIEW_MAX_BYTES;
  const short = picked.map((candidate) => ({
    ...candidate,
    reasons: candidate.reasons.slice(0, 2),
  }));
  if (fits(short)) return short;
  return picked.map((candidate) => ({ ...candidate, reasons: [] }));
}

/** A revisão de IA da foto: sem EAN nesta change, mais o que a decisão acrescenta. */
const imageReviewOf = (ctx: WriteContext, extra: object) =>
  review(ctx, { eanStatus: null, ...extra });

/** As colunas de uma foto aplicada pelo job: a imagem da Galeria, a origem `match` e a revisão com o placar. */
function appliedPhotoColumns(photo: ImageApply['photo'], ctx: WriteContext) {
  const applied = {
    score: photo.score,
    reasons: photo.reasons,
    isClientPreferred: photo.isClientPreferred,
  };
  return {
    galleryImageId: photo.galleryImageId,
    imageUrl: photo.url,
    imageWidth: photo.width,
    imageHeight: photo.height,
    imageOrigin: 'match',
    imageStatus: 'applied',
    imageReview: imageReviewOf(ctx, { applied, suggestion: null }),
  };
}

function planImage(
  item: EnrichItemRow,
  verdict: ImageVerdict,
  ctx: WriteContext,
): ItemWrite | null {
  if (verdict.action === 'unanswered') return null;
  const guard: Guard = () => imageWriteConditionSql(ctx.onlyMissing);
  const target = (count: ItemWrite['count']) => ({ itemId: item.id, count });
  if (verdict.action === 'not_found') {
    const imageReview = imageReviewOf(ctx, { applied: null, suggestion: null });
    return itemWrite(
      ctx,
      target('notFound'),
      { ...NO_PHOTO, imageStatus: 'not_found', imageReview },
      guard,
    );
  }
  const photo = (verdict as ImageApply).photo;
  if (verdict.action === 'apply' && ctx.autoApply) {
    return itemWrite(ctx, target('applied'), appliedPhotoColumns(photo, ctx), guard);
  }
  const candidates = verdict.action === 'review' ? verdict.candidates : [photo];
  const pending = { status: 'pending', candidates: fitCandidates(candidates) };
  const imageReview = imageReviewOf(ctx, { applied: null, suggestion: pending });
  return itemWrite(
    ctx,
    target('review'),
    { ...NO_PHOTO, imageStatus: 'review', imageReview },
    guard,
  );
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
    if (rows?.length) counts[write.count] = (counts[write.count] ?? 0) + 1;
  }
  return counts;
}
