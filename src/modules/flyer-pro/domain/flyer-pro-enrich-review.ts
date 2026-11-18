/**
 * O corte da revisão do item em 4 KB (A-15, `FLYER_PRO_REVIEW_MAX_BYTES`): cada revisão gravada pelo job
 * (`categoryReview`, `imageReview`, `spellReview`) cabe em 4 KB de JSON. Passando, o job corta o texto do `why` da
 * categoria e os motivos das candidatas até caber; nunca as candidatas, a categoria, o nome conferido nem a sugestão de
 * ortografia. A medida é em bytes do JSON, que é o que o banco guarda.
 */
export const REVIEW_MAX_BYTES = 4096;

export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** A revisão de categoria com o `why` cortado (do fim) até a revisão inteira caber em 4 KB. */
export function fitCategoryReview<T extends { suggestion: { why?: string | null } | null }>(
  review: T,
): T {
  let why = review.suggestion?.why;
  const withWhy = (text: string): T => ({
    ...review,
    suggestion: { ...review.suggestion, why: text },
  });
  let fitted = review;
  while (why && jsonBytes(fitted) > REVIEW_MAX_BYTES) {
    // Cada caractere tirado libera pelo menos um byte do JSON: tirar o excesso inteiro converge em poucas voltas.
    why = why.slice(0, Math.max(0, why.length - (jsonBytes(fitted) - REVIEW_MAX_BYTES)));
    fitted = withWhy(why);
  }
  return fitted;
}

interface WithReasons {
  reasons: string[];
}

/** A revisão de foto: a foto aplicada (ou `null`) e a sugestão pendente com as candidatas (ou `null`). */
export interface ImageReviewShape {
  applied: WithReasons | null;
  suggestion: { candidates: WithReasons[] } | null;
}

/**
 * Os motivos da foto aplicada e das candidatas, tirados do fim (do que mais tem, um a um) até a revisão caber. As
 * candidatas, as notas e as urls ficam inteiras.
 */
export function fitReasons<T extends ImageReviewShape>(review: T): T {
  if (jsonBytes(review) <= REVIEW_MAX_BYTES) return review;
  const copy: T = JSON.parse(JSON.stringify(review));
  const holders = [copy.applied, ...(copy.suggestion?.candidates ?? [])].filter(
    (holder): holder is WithReasons => holder !== null,
  );
  while (holders.length > 0 && jsonBytes(copy) > REVIEW_MAX_BYTES) {
    const richest = holders.reduce((a, b) => (b.reasons.length > a.reasons.length ? b : a));
    if (richest.reasons.length === 0) break;
    richest.reasons.pop();
  }
  return copy;
}
