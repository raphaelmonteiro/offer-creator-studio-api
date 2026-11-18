import { fitReasons } from '../domain/flyer-pro-enrich-review';
import { imageWriteConditionSql } from '../domain/flyer-pro-enrich-criteria';
import { MAX_CANDIDATES } from '../domain/flyer-pro-enrich-image';
import type {
  ImageApply,
  ImageCandidateVerdict,
  ImageEanStatus,
  ImageVerdict,
} from '../providers/flyer-pro-enrich.port';
import { Guard, itemWrite, review, WriteContext } from './flyer-pro-enrich.item-write';
import type { EnrichItemRow, ItemWrite } from './flyer-pro-enrich.types';

/**
 * O que o job escreve na foto do item (tabela "veredito → o que o job grava" do `design.md`): a foto aplicada, a revisão
 * com as candidatas, o EAN em consulta e "não encontrada". A foto do job não é registrada na Galeria.
 */

const NO_PHOTO = {
  galleryImageId: null,
  imageUrl: null,
  imageWidth: null,
  imageHeight: null,
  imageOrigin: null,
};

/** A foto aplicada, como a revisão a guarda. */
interface AppliedPhoto {
  score: number;
  reasons: string[];
  isClientPreferred: boolean;
}

/** A revisão de IA da foto, no tamanho que cabe em 4 KB (motivos cortados, nunca as candidatas). */
function imageReviewOf(
  ctx: WriteContext,
  extra: {
    eanStatus: ImageEanStatus;
    applied: AppliedPhoto | null;
    suggestion: { status: 'pending'; candidates: ImageCandidateVerdict[] } | null;
  },
) {
  const candidates = extra.suggestion?.candidates.slice(0, MAX_CANDIDATES) ?? [];
  const suggestion = extra.suggestion ? { ...extra.suggestion, candidates } : null;
  return fitReasons(review(ctx, { ...extra, suggestion }));
}

/** As colunas de uma foto aplicada pelo job: a imagem da Galeria, a origem `match` e a revisão com o placar. */
function appliedPhotoColumns(verdict: ImageApply, ctx: WriteContext) {
  const { photo } = verdict;
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
    imageReview: imageReviewOf(ctx, {
      eanStatus: verdict.eanStatus ?? null,
      applied,
      suggestion: null,
    }),
  };
}

/** `budget_blocked` conta também em `eanBudgetBlocked` (o item gravado com o EAN sem crédito). */
const alsoOf = (eanStatus: ImageEanStatus | undefined): ItemWrite['also'] =>
  eanStatus === 'budget_blocked' ? 'eanBudgetBlocked' : undefined;

/** Os dois `UPDATE` que quase toda foto usa: um com as colunas dadas e um de revisão (sem foto, candidatas pendentes). */
interface ImageWriter {
  write(
    count: ItemWrite['count'],
    columns: Record<string, unknown>,
    eanStatus?: ImageEanStatus,
  ): ItemWrite;
  review(candidates: ImageCandidateVerdict[], eanStatus: ImageEanStatus): ItemWrite;
}

function writerOf(item: EnrichItemRow, ctx: WriteContext): ImageWriter {
  const guard: Guard = () => imageWriteConditionSql(ctx.onlyMissing, ctx.retry);
  const write: ImageWriter['write'] = (count, columns, eanStatus) =>
    itemWrite(ctx, { itemId: item.id, count, also: alsoOf(eanStatus) }, columns, guard);
  const review: ImageWriter['review'] = (candidates, eanStatus) => {
    const suggestion = { status: 'pending' as const, candidates };
    const imageReview = imageReviewOf(ctx, { eanStatus, applied: null, suggestion });
    return write('review', { ...NO_PHOTO, imageStatus: 'review', imageReview }, eanStatus);
  };
  return { write, review };
}

/** Nada achado com a busca por nome disponível: sem foto, `applied` e `suggestion` nulos. */
function notFoundWrite(writer: ImageWriter, ctx: WriteContext, eanStatus: ImageEanStatus) {
  const imageReview = imageReviewOf(ctx, { eanStatus, applied: null, suggestion: null });
  return writer.write(
    'notFound',
    { ...NO_PHOTO, imageStatus: 'not_found', imageReview },
    eanStatus,
  );
}

/** EAN em consulta: `ean_pending` sem foto, com as candidatas pelo nome guardadas se vieram. */
function pendingWrite(writer: ImageWriter, ctx: WriteContext, candidates: ImageCandidateVerdict[]) {
  const suggestion = candidates.length ? { status: 'pending' as const, candidates } : null;
  const imageReview = imageReviewOf(ctx, { eanStatus: 'pending', applied: null, suggestion });
  return writer.write('eanPending', { ...NO_PHOTO, imageStatus: 'ean_pending', imageReview });
}

/** O veredito de fotos como o `UPDATE` do item; `null` quando o item continua como estava. */
export function planImage(
  item: EnrichItemRow,
  verdict: ImageVerdict,
  ctx: WriteContext,
): ItemWrite | null {
  if (verdict.action === 'unanswered') return null;
  if (verdict.action === 'pending' && ctx.retry) return null;
  const writer = writerOf(item, ctx);
  if (verdict.action === 'pending') return pendingWrite(writer, ctx, verdict.candidates);
  const eanStatus = verdict.eanStatus ?? null;
  if (verdict.action === 'not_found') return notFoundWrite(writer, ctx, eanStatus);
  if (verdict.action === 'apply' && ctx.autoApply) {
    return writer.write('applied', appliedPhotoColumns(verdict, ctx), eanStatus);
  }
  return writer.review(
    verdict.action === 'review' ? verdict.candidates : [verdict.photo],
    eanStatus,
  );
}
