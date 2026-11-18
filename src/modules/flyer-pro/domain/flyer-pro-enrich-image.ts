import type {
  ImageCandidateVerdict,
  ImageVerdict,
  EnrichItemInput,
} from '../providers/flyer-pro-enrich.port';
import { searchNameOf } from './flyer-pro-enrich-input';
import type { EnrichResult } from './flyer-pro-job.types';
import type { PhaseCounts } from './flyer-pro-enrich-rules';

/**
 * As regras puras da fase de fotos do provedor real (U2.6): o pedido à busca de fotos, a tradução da resposta dela
 * (precedência `matches`, `pending`, `reviewCandidates`, nenhum) para o veredito da porta e as contagens da fase e da
 * passada do EAN. Sem banco e sem serviço; as tabelas estão no `design.md`.
 */

/** No máximo 3 candidatas por item (A-12). */
export const MAX_CANDIDATES = 3;

/**
 * As passadas do EAN pendente (`image_ean_retry`): no máximo 3 por job, contando todas as rodadas da conferência final
 * (A-14), com a espera de 30, 60 e 120 s antes de cada uma. O maior atraso (120 s) fica abaixo dos 180 s de `stalled` e
 * dos 300 s em que o reconciliador republica um lote não assumido.
 */
export const EAN_RETRY_DELAYS_SECONDS: readonly number[] = [30, 60, 120];
export const EAN_RETRY_MAX_PASSES = EAN_RETRY_DELAYS_SECONDS.length;

/** Ainda cabe outra passada? `usedPasses` é quantas o job já começou. */
export const canRetryEan = (usedPasses: number): boolean => usedPasses < EAN_RETRY_MAX_PASSES;

/** A espera antes da passada de número `pass` (1 a 3). */
export const eanRetryDelaySeconds = (pass: number): number =>
  EAN_RETRY_DELAYS_SECONDS[pass - 1] ?? 0;

/** A medida da foto como a fase a leu; `null` quando não deu para ler (a foto vai para revisão). */
export interface PhotoSize {
  width: number;
  height: number;
}

/** O que o job lê da resposta da busca de fotos (`FlyerMatchResult`, sem importá-la). */
export interface ImageSearchAnswer {
  matches: Array<{
    productId: string;
    imageId: string;
    imageUrl: string;
    score: number;
    reasons: string[];
    isClientPreferred: boolean;
  }>;
  reviewCandidates: Array<{
    productId: string;
    candidates: Array<{
      imageId: string;
      url: string;
      thumbnailUrl: string | null;
      score: number;
      reasons: string[];
      isClientPreferred: boolean;
    }>;
  }>;
  pending: string[];
  eanStatus: Array<{ productId: string; status: string }>;
}

/** O pedido à busca de fotos: o nome da planilha quando há (nunca vazio), a categoria, a unidade e o EAN do item. */
export function imageSearchRequest(items: EnrichItemInput[]) {
  return items.map((item) => ({
    id: item.id,
    name: searchNameOf(item),
    category: item.category ?? null,
    unit: item.unit ?? null,
    ean: item.ean ?? null,
  }));
}

/** A foto de `matches` como candidata: a busca não traz a miniatura dela (A-12). */
const photoOf = (match: ImageSearchAnswer['matches'][number]): ImageCandidateVerdict => ({
  galleryImageId: match.imageId,
  url: match.imageUrl,
  thumbnailUrl: null,
  score: match.score,
  reasons: match.reasons,
  isClientPreferred: match.isClientPreferred,
});

const candidatesOf = (
  entry: ImageSearchAnswer['reviewCandidates'][number] | undefined,
): ImageCandidateVerdict[] =>
  (entry?.candidates ?? []).slice(0, MAX_CANDIDATES).map((candidate) => ({
    galleryImageId: candidate.imageId,
    url: candidate.url,
    thumbnailUrl: candidate.thumbnailUrl ?? null,
    score: candidate.score,
    reasons: candidate.reasons,
    isClientPreferred: candidate.isClientPreferred,
  }));

/** O que a fase sabe além da resposta: a medida de cada foto de `matches` e se a busca por nome rodou. */
export interface ImageContext {
  sizes: Map<string, PhotoSize | null>;
  nameSearch: boolean;
}

/**
 * A resposta da busca para um item como veredito da porta. Em `matches` com a medida lida, aplica; sem a medida, a foto
 * vai para revisão como única candidata. Sem `matches`, o EAN em consulta (`pending`, com as candidatas pelo nome se
 * vieram) vem antes das candidatas; sem nada, "não encontrada" só vale com a busca por nome disponível, senão o item
 * continua como estava (`unanswered`).
 */
export function imageVerdictOf(
  item: Pick<EnrichItemInput, 'id'>,
  answer: ImageSearchAnswer,
  context: ImageContext,
): ImageVerdict {
  const itemId = item.id;
  const eanStatus = answer.eanStatus.find((entry) => entry.productId === itemId)?.status ?? null;
  const match = answer.matches.find((entry) => entry.productId === itemId);
  const reviewed = answer.reviewCandidates.find((entry) => entry.productId === itemId);
  if (match) {
    const size = context.sizes.get(itemId) ?? null;
    const photo = photoOf(match);
    return size
      ? { itemId, action: 'apply', photo: { ...photo, ...size }, eanStatus }
      : { itemId, action: 'review', candidates: [photo], eanStatus };
  }
  if (answer.pending.includes(itemId)) {
    return { itemId, action: 'pending', candidates: candidatesOf(reviewed) };
  }
  if (reviewed) return { itemId, action: 'review', candidates: candidatesOf(reviewed), eanStatus };
  return context.nameSearch
    ? { itemId, action: 'not_found', eanStatus }
    : { itemId, action: 'unanswered' };
}

/**
 * As contagens de um lote da passada do EAN (`image_ean_retry`): o item que sai de `ean_pending` entra em `applied`,
 * `review` ou `notFound` e sai de `eanPending`, sem contar de novo em `visited` (A-14, D-2 (a)).
 */
export function retryCounts(counts: PhaseCounts): PhaseCounts {
  const left = (counts.applied ?? 0) + (counts.review ?? 0) + (counts.notFound ?? 0);
  return { ...counts, visited: 0, eanPending: -left };
}

/**
 * `result.image_match` com os dois campos opcionais da fase: `nameSearchUnavailable` (liga e não desliga: ausente com a
 * busca disponível) e `eanBudgetBlocked` (soma; ausente enquanto nenhum item foi gravado com esse estado).
 */
export function withImageExtras(
  result: EnrichResult,
  extras: { nameSearchUnavailable: boolean; eanBudgetBlocked: number },
): EnrichResult {
  const current = result.image_match;
  if (!current) return result;
  const blocked = (current.eanBudgetBlocked ?? 0) + extras.eanBudgetBlocked;
  return {
    ...result,
    image_match: {
      ...current,
      ...(extras.nameSearchUnavailable || current.nameSearchUnavailable
        ? { nameSearchUnavailable: true as const }
        : {}),
      ...(blocked > 0 ? { eanBudgetBlocked: blocked } : {}),
    },
  };
}
