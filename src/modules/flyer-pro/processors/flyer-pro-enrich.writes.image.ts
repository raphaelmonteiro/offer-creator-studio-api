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

/** O veredito de fotos como o `UPDATE` do item; `null` quando o item continua como estava. */
export function planImage(
  item: EnrichItemRow,
  verdict: ImageVerdict,
  ctx: WriteContext,
): ItemWrite | null {
  if (verdict.action === 'unanswered') return null;
  if (verdict.action === 'pending' && ctx.retry) return null;
  const guard: Guard = () => imageWriteConditionSql(ctx.onlyMissing, ctx.retry);
  const write = (
    count: ItemWrite['count'],
    columns: Record<string, unknown>,
    eanStatus?: ImageEanStatus,
  ) => itemWrite(ctx, { itemId: item.id, count, also: alsoOf(eanStatus) }, columns, guard);
  const reviewWrite = (candidates: ImageCandidateVerdict[], eanStatus: ImageEanStatus) =>
    write(
      'review',
      {
        ...NO_PHOTO,
        imageStatus: 'review',
        imageReview: imageReviewOf(ctx, {
          eanStatus,
          applied: null,
          suggestion: { status: 'pending', candidates },
        }),
      },
      eanStatus,
    );

  if (verdict.action === 'not_found') {
    const eanStatus = verdict.eanStatus ?? null;
    const imageReview = imageReviewOf(ctx, { eanStatus, applied: null, suggestion: null });
    return write('notFound', { ...NO_PHOTO, imageStatus: 'not_found', imageReview }, eanStatus);
  }
  if (verdict.action === 'pending') {
    const suggestion = verdict.candidates.length
      ? { status: 'pending' as const, candidates: verdict.candidates }
      : null;
    const imageReview = imageReviewOf(ctx, { eanStatus: 'pending', applied: null, suggestion });
    return write('eanPending', { ...NO_PHOTO, imageStatus: 'ean_pending', imageReview });
  }
  const eanStatus = verdict.eanStatus ?? null;
  if (verdict.action === 'apply' && ctx.autoApply) {
    return write('applied', appliedPhotoColumns(verdict, ctx), eanStatus);
  }
  const candidates = verdict.action === 'review' ? verdict.candidates : [verdict.photo];
  return reviewWrite(candidates, eanStatus);
}
