import {
  decide,
  DecisionContext,
  ItemReview,
  pendingSuggestion,
  supersede,
} from './flyer-pro-item-review';
import { IMAGE_GROUP_KEYS, ItemDraft } from './flyer-pro-item.types';
import { isSent } from './flyer-pro-presence';

/**
 * O que só o servidor escreve em cada item (`categorySource`, `imageStatus` e as três revisões), derivado do item
 * mesclado, do gravado e das decisões, pela tabela de `a2-api.html#s5-4`. Puro. Decisão só vale com sugestão pendente
 * (sem ela é ignorada, o que tolera o reenvio e a corrida com o job); `decidedAt` é o carimbo da gravação.
 */
export interface DerivedItemFields {
  categorySource: string | null;
  imageStatus: string;
  categoryReview: ItemReview;
  imageReview: ItemReview;
  spellReview: ItemReview;
}

type CategoryFields = Pick<DerivedItemFields, 'categorySource' | 'categoryReview'>;

/** Item novo: a origem vem de `imported` (importação) ou da mão do operador; sem categoria, nenhuma. */
function newItemCategory(draft: ItemDraft): CategoryFields {
  const { category, imported } = draft.merged;
  const source = category ? (imported ? 'import' : 'user') : null;
  return { categorySource: source, categoryReview: null };
}

/** O aceite: com a categoria sugerida vale a escolha da IA; com outra (D-1 (a)) é troca à mão e a sugestão some. */
function acceptedCategory(draft: ItemDraft, review: NonNullable<ItemReview>, ctx: DecisionContext) {
  const suggested = pendingSuggestion(review).category;
  return draft.entry.category === suggested
    ? { categorySource: 'ai', categoryReview: decide(review, 'accepted', ctx) }
    : { categorySource: 'user', categoryReview: supersede(review, ctx) };
}

/** Recusa e bloqueio não mudam `category`; se a categoria mudou na mesma gravação, a origem é a mão do operador. */
function closedCategory(
  draft: ItemDraft,
  review: NonNullable<ItemReview>,
  ctx: DecisionContext,
): CategoryFields {
  const { entry, stored } = draft;
  const blocked = entry.categoryDecision === 'blocked';
  return {
    categorySource: categoryChanged(draft) ? 'user' : (stored.categorySource ?? null),
    categoryReview: blocked
      ? decide(review, 'blocked', ctx, entry.categoryDecisionReason)
      : decide(review, 'rejected', ctx),
  };
}

const categoryChanged = ({ entry, stored }: ItemDraft): boolean =>
  entry.category !== undefined && (entry.category ?? null) !== (stored.category ?? null);

export function deriveCategory(draft: ItemDraft, ctx: DecisionContext): CategoryFields {
  const { entry, stored } = draft;
  if (!stored) return newItemCategory(draft);
  const review = stored.categoryReview ?? null;
  const pending = pendingSuggestion(review) ? entry.categoryDecision : undefined;
  if (pending === 'accept') return acceptedCategory(draft, review, ctx);
  if (pending === 'reject' || pending === 'blocked') return closedCategory(draft, review, ctx);
  if (!categoryChanged(draft)) {
    return { categorySource: stored.categorySource ?? null, categoryReview: review };
  }
  const superseded = pendingSuggestion(review) ? supersede(review, ctx) : review;
  return { categorySource: 'user', categoryReview: superseded };
}

type ImageFields = Pick<DerivedItemFields, 'imageStatus' | 'imageReview'>;

/** Foto escolhida (grupo preenchido) ou tirada (grupo nulo); a sugestão de foto pendente é aceita só se veio dela. */
function imageOfGroup(draft: ItemDraft, ctx: DecisionContext): ImageFields {
  const { entry, stored } = draft;
  const review = stored?.imageReview ?? null;
  const filled = isSent(entry.imageUrl);
  return {
    imageStatus: filled ? 'applied' : 'removed',
    imageReview: pendingSuggestion(review) ? closeImageReview(draft, review, ctx) : review,
  };
}

/** A sugestão de foto pendente quando a foto do item mudou: aceita se o operador escolheu uma delas, senão fechada. */
function closeImageReview(draft: ItemDraft, review: NonNullable<ItemReview>, ctx: DecisionContext) {
  const { entry } = draft;
  if (!isSent(entry.imageUrl)) return decide(review, 'rejected', ctx);
  return entry.imageOrigin === 'suggestion'
    ? decide(review, 'accepted', ctx)
    : supersede(review, ctx);
}

export function deriveImage(draft: ItemDraft, ctx: DecisionContext): ImageFields {
  const { entry, stored } = draft;
  if (IMAGE_GROUP_KEYS.some((key) => entry[key] !== undefined)) return imageOfGroup(draft, ctx);
  const review = stored?.imageReview ?? null;
  if (pendingSuggestion(review) && entry.imageDecision === 'reject') {
    return { imageStatus: 'not_found', imageReview: decide(review, 'rejected', ctx) };
  }
  return { imageStatus: stored?.imageStatus ?? 'none', imageReview: review };
}

/** A ortografia: aceitar grava o nome enviado (a mescla já o pôs), recusar fecha a sugestão, nome novo apaga a revisão. */
export function deriveSpell(draft: ItemDraft, ctx: DecisionContext): ItemReview {
  const { entry, stored, merged } = draft;
  if (!stored) return null;
  const review = stored.spellReview ?? null;
  const decision = pendingSuggestion(review) ? entry.spellDecision : undefined;
  if (decision === 'accept') return decide(review, 'accepted', ctx);
  if (decision === 'reject') return decide(review, 'rejected', ctx);
  const renamed = entry.name !== undefined && merged.name !== stored.name;
  return renamed ? null : review;
}

export function deriveItem(draft: ItemDraft, ctx: DecisionContext): DerivedItemFields {
  return {
    ...deriveCategory(draft, ctx),
    ...deriveImage(draft, ctx),
    spellReview: deriveSpell(draft, ctx),
  };
}
