/** A sugestão de uma revisão de IA do item (`categoryReview`, `imageReview`, `spellReview`) e a decisão sobre ela. */

export type ItemReview = Record<string, unknown> | null;
type Suggestion = Record<string, unknown> & { status?: string };

export interface DecisionContext {
  /** O carimbo da gravação (`decidedAt`) e o usuário do token (`decidedByUserId`): A-13. */
  stamp: string;
  userId: string;
}

export type DecisionStatus = 'accepted' | 'rejected' | 'blocked';

/** A sugestão pendente da revisão, ou `null` (sem revisão, sem sugestão ou já decidida). */
export function pendingSuggestion(review: ItemReview | undefined): Suggestion | null {
  const suggestion = review?.suggestion as Suggestion | null | undefined;
  return suggestion && suggestion.status === 'pending' ? suggestion : null;
}

/** A revisão com a sugestão decidida: o estado novo, o motivo (se houver) e quem decidiu e quando. */
export function decide(
  review: NonNullable<ItemReview>,
  status: DecisionStatus,
  context: DecisionContext,
  reason?: string,
): Record<string, unknown> {
  return {
    ...review,
    suggestion: {
      ...(review.suggestion as Suggestion),
      status,
      ...(reason === undefined ? {} : { reason }),
      decidedAt: context.stamp,
      decidedByUserId: context.userId,
    },
  };
}

/** A sugestão pendente vira `rejected` com o motivo `superseded`: o operador escolheu outra coisa à mão. */
export const supersede = (review: NonNullable<ItemReview>, context: DecisionContext) =>
  decide(review, 'rejected', context, 'superseded');
