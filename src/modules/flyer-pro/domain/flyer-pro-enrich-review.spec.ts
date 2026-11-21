import { fitCategoryReview, fitReasons, REVIEW_MAX_BYTES } from './flyer-pro-enrich-review';
import { jsonBytes } from './flyer-pro-slices';

const categoryReview = (why: string) => ({
  checkedAt: '2026-11-18T10:00:00.000Z',
  jobId: 'job-1',
  suggestion: { category: 'Limpeza', confidence: 0.88, why, status: 'pending' },
});

const candidate = (reasons: string[]) => ({
  galleryImageId: 'g1',
  url: 'http://x/uploads/a.jpg',
  thumbnailUrl: null,
  score: 0.6,
  reasons,
  isClientPreferred: false,
});

describe('revisão do item até 4 KB (A-15)', () => {
  it('o limite é 4096 bytes do JSON', () => {
    expect(REVIEW_MAX_BYTES).toBe(4096);
  });

  it('motivo longo da categoria: a revisão cabe, com a categoria e a confiança inteiras e o motivo cortado', () => {
    const fitted = fitCategoryReview(categoryReview('A'.repeat(6000)));
    expect(jsonBytes(fitted)).toBeLessThanOrEqual(REVIEW_MAX_BYTES);
    expect(fitted.suggestion).toMatchObject({
      category: 'Limpeza',
      confidence: 0.88,
      status: 'pending',
    });
    expect(fitted.suggestion.why.length).toBeGreaterThan(3000);
    expect(fitted.suggestion.why.length).toBeLessThan(6000);
  });

  it('motivo com aspas e acento (que o JSON escapa ou alarga) também cabe', () => {
    const fitted = fitCategoryReview(categoryReview('"ção" '.repeat(1500)));
    expect(jsonBytes(fitted)).toBeLessThanOrEqual(REVIEW_MAX_BYTES);
  });

  it('revisão pequena não é cortada', () => {
    const review = categoryReview('motivo curto');
    expect(fitCategoryReview(review)).toBe(review);
  });

  it('sugestão nula não tem o que cortar', () => {
    const review = { checkedAt: 'x', jobId: 'j', suggestion: null };
    expect(fitCategoryReview(review)).toBe(review);
  });

  it('candidatas com muitos motivos: cabe em 4 KB e continua com as 3 candidatas', () => {
    const reasons = Array.from({ length: 12 }, (_, index) => `${index}:` + 'm'.repeat(150));
    const review = {
      checkedAt: 'x',
      jobId: 'j',
      eanStatus: null,
      applied: null,
      suggestion: {
        status: 'pending',
        candidates: [candidate(reasons), candidate(reasons), candidate(reasons)],
      },
    };
    expect(jsonBytes(review)).toBeGreaterThan(REVIEW_MAX_BYTES);
    const fitted = fitReasons(review);
    expect(jsonBytes(fitted)).toBeLessThanOrEqual(REVIEW_MAX_BYTES);
    expect(fitted.suggestion.candidates).toHaveLength(3);
    expect(fitted.suggestion.candidates[0]).toMatchObject({ galleryImageId: 'g1', score: 0.6 });
    expect(fitted.suggestion.candidates.every((c) => c.reasons.length > 0)).toBe(true);
  });

  it('o motivo da foto aplicada também é cortado', () => {
    const reasons = Array.from({ length: 40 }, () => 'm'.repeat(150));
    const review = {
      checkedAt: 'x',
      jobId: 'j',
      eanStatus: 'gallery',
      applied: { score: 1, reasons, isClientPreferred: false },
      suggestion: null,
    };
    const fitted = fitReasons(review);
    expect(jsonBytes(fitted)).toBeLessThanOrEqual(REVIEW_MAX_BYTES);
    expect(fitted.applied.score).toBe(1);
  });

  it('revisão de foto pequena não é cortada', () => {
    const review = {
      checkedAt: 'x',
      jobId: 'j',
      applied: null,
      suggestion: { status: 'pending', candidates: [candidate(['EAN igual'])] },
    };
    expect(fitReasons(review)).toBe(review);
  });
});
