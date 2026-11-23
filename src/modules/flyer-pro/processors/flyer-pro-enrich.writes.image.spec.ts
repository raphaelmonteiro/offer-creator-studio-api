import type { ImageCandidateVerdict, ImageVerdict } from '../providers/flyer-pro-enrich.port';
import { REVIEW_MAX_BYTES } from '../domain/flyer-pro-enrich-review';
import { planWrites } from './flyer-pro-enrich.writes';
import { columnsOf, itemRow, writeContext } from './flyer-pro-enrich.writes.testutil';

const candidate = (
  id: string,
  over: Partial<ImageCandidateVerdict> = {},
): ImageCandidateVerdict => ({
  galleryImageId: id,
  url: `http://cdn/uploads/gallery/${id}.jpg`,
  thumbnailUrl: `http://cdn/uploads/thumbnails/${id}.jpg`,
  score: 0.6,
  reasons: ['mesma marca'],
  isClientPreferred: false,
  ...over,
});
const photo = { ...candidate('g1', { score: 1, reasons: ['EAN igual'] }), width: 800, height: 640 };

const apply = (eanStatus: string | null = 'gallery'): ImageVerdict => ({
  itemId: 'i1',
  action: 'apply',
  photo,
  eanStatus,
});

function write(verdict: ImageVerdict, autoApply = true, ctx: object = {}) {
  const [planned] = planWrites(
    { phase: 'image_match', items: [itemRow()], verdicts: [verdict] },
    writeContext(autoApply, ctx),
  );
  return planned ? { write: planned, columns: columnsOf(planned) } : null;
}

type Review = {
  eanStatus: string | null;
  applied: { score: number; reasons: string[]; isClientPreferred: boolean } | null;
  suggestion: { status: string; candidates: Array<{ galleryImageId: string }> } | null;
};
const reviewOf = (columns: Record<string, unknown>) => columns.imageReview as Review;

describe('veredito da foto → o que o job grava (tabela do design.md)', () => {
  it('apply com autoApply: as cinco colunas da foto, origem match, applied, e a revisão com o placar', () => {
    const planned = write(apply());
    expect(planned?.write.count).toBe('applied');
    expect(planned?.columns).toMatchObject({
      galleryImageId: 'g1',
      imageUrl: 'http://cdn/uploads/gallery/g1.jpg',
      imageWidth: 800,
      imageHeight: 640,
      imageOrigin: 'match',
      imageStatus: 'applied',
    });
    expect(reviewOf(planned!.columns)).toMatchObject({
      eanStatus: 'gallery',
      applied: { score: 1, reasons: ['EAN igual'], isClientPreferred: false },
      suggestion: null,
    });
  });

  it('apply sem autoApply: review, sem foto no item, com a foto como única candidata pendente', () => {
    const planned = write(apply(), false);
    expect(planned?.write.count).toBe('review');
    expect(planned?.columns).toMatchObject({
      imageStatus: 'review',
      galleryImageId: null,
      imageUrl: null,
      imageWidth: null,
      imageHeight: null,
      imageOrigin: null,
    });
    const { suggestion } = reviewOf(planned!.columns);
    expect(suggestion).toMatchObject({ status: 'pending' });
    expect(suggestion?.candidates.map((c) => c.galleryImageId)).toEqual(['g1']);
  });

  it('review com 3 candidatas: pendentes, sem foto, até 3 (a quarta é cortada)', () => {
    const candidates = ['a', 'b', 'c', 'd'].map((id) => candidate(id));
    const planned = write({ itemId: 'i1', action: 'review', candidates, eanStatus: null });
    expect(planned?.write.count).toBe('review');
    expect(reviewOf(planned!.columns).suggestion?.candidates).toHaveLength(3);
    expect(reviewOf(planned!.columns).applied).toBeNull();
  });

  it('pending: ean_pending sem foto, eanStatus pending e sem candidatas', () => {
    const planned = write({ itemId: 'i1', action: 'pending', candidates: [] });
    expect(planned?.write.count).toBe('eanPending');
    expect(planned?.columns).toMatchObject({ imageStatus: 'ean_pending', galleryImageId: null });
    expect(reviewOf(planned!.columns)).toMatchObject({
      eanStatus: 'pending',
      applied: null,
      suggestion: null,
    });
  });

  it('pending com candidatas pelo nome: guarda as candidatas pendentes', () => {
    const planned = write({
      itemId: 'i1',
      action: 'pending',
      candidates: [candidate('a'), candidate('b')],
    });
    expect(reviewOf(planned!.columns).suggestion?.candidates).toHaveLength(2);
    expect(reviewOf(planned!.columns).eanStatus).toBe('pending');
  });

  it('not_found: applied e suggestion nulos, sem foto', () => {
    const planned = write({ itemId: 'i1', action: 'not_found', eanStatus: null });
    expect(planned?.write.count).toBe('notFound');
    expect(planned?.columns).toMatchObject({ imageStatus: 'not_found', imageUrl: null });
    expect(reviewOf(planned!.columns)).toMatchObject({ applied: null, suggestion: null });
  });

  it('unanswered: nada gravado', () => {
    expect(write({ itemId: 'i1', action: 'unanswered' })).toBeNull();
  });

  it('eanStatus budget_blocked conta também em eanBudgetBlocked; os outros estados, não', () => {
    expect(write(apply('budget_blocked'))?.write.also).toBe('eanBudgetBlocked');
    expect(
      write({ itemId: 'i1', action: 'not_found', eanStatus: 'budget_blocked' })?.write.also,
    ).toBe('eanBudgetBlocked');
    expect(write(apply('gallery'))?.write.also).toBeUndefined();
    expect(write(apply(null))?.write.also).toBeUndefined();
    expect(write({ itemId: 'i1', action: 'pending', candidates: [] })?.write.also).toBeUndefined();
  });

  it('o EAN inválido fica na revisão e o item segue pelo nome', () => {
    const planned = write({ itemId: 'i1', action: 'not_found', eanStatus: 'invalid' });
    expect(reviewOf(planned!.columns).eanStatus).toBe('invalid');
  });

  it('nunca grava alternatives nem colunas fora da foto e da revisão', () => {
    const planned = write(apply());
    expect(Object.keys(planned!.columns).sort()).toEqual(
      [
        'galleryImageId',
        'imageHeight',
        'imageOrigin',
        'imageReview',
        'imageStatus',
        'imageUrl',
        'imageWidth',
        'updatedAt',
      ].sort(),
    );
    expect(JSON.stringify(planned!.columns)).not.toMatch(/alternatives/);
  });
});

describe('passada do EAN (retry)', () => {
  it('item ainda pendente: nenhuma escrita', () => {
    expect(
      write({ itemId: 'i1', action: 'pending', candidates: [candidate('a')] }, true, {
        retry: true,
      }),
    ).toBeNull();
  });

  it('item que saiu de pendente grava como na fase de fotos, só se ainda está ean_pending', () => {
    const planned = write(apply(), true, { retry: true });
    expect(planned?.write.count).toBe('applied');
    expect(planned?.write.sql).toContain(`"imageStatus" = 'ean_pending'`);
    expect(planned?.write.sql).not.toContain(`'none'`);
  });

  it('na fase de fotos a condição do UPDATE aceita none e ean_pending', () => {
    expect(write(apply())?.write.sql).toContain(`IN ('none', 'ean_pending')`);
  });
});

describe('revisão da foto até 4 KB (A-15)', () => {
  it('candidatas com motivos que juntos passam de 4 KB: cabe e continua com as 3 candidatas', () => {
    const reasons = Array.from({ length: 12 }, (_, index) => `${index}:${'m'.repeat(150)}`);
    const candidates = ['a', 'b', 'c'].map((id) => candidate(id, { reasons }));
    const planned = write({ itemId: 'i1', action: 'review', candidates, eanStatus: null });

    expect(Buffer.byteLength(JSON.stringify(planned!.columns.imageReview))).toBeLessThanOrEqual(
      REVIEW_MAX_BYTES,
    );
    expect(reviewOf(planned!.columns).suggestion?.candidates).toHaveLength(3);
  });

  it('revisão pequena: nada é cortado', () => {
    const planned = write({
      itemId: 'i1',
      action: 'review',
      candidates: [candidate('a', { reasons: ['um', 'dois', 'tres'] })],
      eanStatus: null,
    });
    const [only] = (
      planned!.columns.imageReview as { suggestion: { candidates: Array<{ reasons: string[] }> } }
    ).suggestion.candidates;
    expect(only.reasons).toEqual(['um', 'dois', 'tres']);
  });
});
