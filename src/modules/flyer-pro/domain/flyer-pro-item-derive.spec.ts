import { itemRow } from '../services/flyer-pro-documents.service.testutil';
import { deriveItem } from './flyer-pro-item-derive';
import { draftOf } from './flyer-pro-item-merge';
import { FlyerProItemEntry } from './flyer-pro-item.types';

const ID = 'e41a0b52-3c6d-4e7f-8a91-b2c3d4e5f6a7';
const CTX = { stamp: '2026-11-14T14:33:10.004512Z', userId: 'ana' };
const DECIDED = { decidedAt: CTX.stamp, decidedByUserId: 'ana' };
const PHOTO = {
  galleryImageId: '141da073-e2ab-4c8e-bb79-28e24074f743',
  imageUrl: 'http://localhost:3101/uploads/gallery/05a0bd80.png',
  imageWidth: 900,
  imageHeight: 700,
};
const NO_PHOTO = {
  galleryImageId: null,
  imageUrl: null,
  imageWidth: null,
  imageHeight: null,
  imageOrigin: null,
};

const pending = (extra: Record<string, unknown>) => ({
  checkedAt: '2026-11-14T13:05:02.000Z',
  jobId: 'job-1',
  suggestion: { status: 'pending', ...extra },
});
const categoryReview = (category = 'Carnes') => pending({ category, confidence: 0.92, why: null });
const imageReview = () => pending({ candidates: [] });
const spellReview = () => ({ ...pending({ value: 'ABACATE' }), checkedName: 'ABACAATE' });

/** Deriva um item existente (a linha dada) a partir da entrada. */
const existing = (entry: Partial<FlyerProItemEntry>, row = {}) =>
  deriveItem(draftOf({ id: ID, ...entry }, itemRow({ id: ID, ...row }), false), CTX);
const created = (entry: Partial<FlyerProItemEntry> = {}) =>
  deriveItem(
    draftOf(
      {
        id: ID,
        position: 0,
        name: 'ABACATE',
        price: { kind: 'simple', cents: 699 },
        unit: 'kg',
        ...entry,
      },
      null,
      false,
    ),
    CTX,
  );
const suggestionOf = (review: Record<string, unknown> | null) =>
  review?.suggestion as Record<string, unknown>;

describe('deriveItem: origem da categoria', () => {
  it('item novo com category e imported é "import"; sem imported é "user"; sem category é nulo', () => {
    expect(created({ category: 'Hortifruti', imported: { v: 1 } }).categorySource).toBe('import');
    expect(created({ category: 'Carnes' }).categorySource).toBe('user');
    expect(created({ category: null }).categorySource).toBeNull();
    expect(created().categorySource).toBeNull();
  });

  it('item existente com category diferente da gravada, sem decisão, é "user"', () => {
    const derived = existing(
      { category: 'Hortifruti' },
      { category: 'Mercearia', categorySource: 'ai' },
    );

    expect(derived.categorySource).toBe('user');
  });

  it('com sugestão pendente, trocar à mão a categoria a fecha como rejected "superseded"', () => {
    const derived = existing(
      { category: 'Hortifruti' },
      { category: 'Mercearia', categorySource: 'ai', categoryReview: categoryReview('Carnes') },
    );

    expect(derived.categorySource).toBe('user');
    expect(suggestionOf(derived.categoryReview)).toMatchObject({
      status: 'rejected',
      reason: 'superseded',
      ...DECIDED,
    });
  });

  it('category nula em item existente com categoria é "user"; igual à gravada mantém a origem', () => {
    expect(
      existing({ category: null }, { category: 'Carnes', categorySource: 'import' }).categorySource,
    ).toBe('user');
    expect(
      existing({ category: 'Carnes' }, { category: 'Carnes', categorySource: 'import' })
        .categorySource,
    ).toBe('import');
    expect(
      existing({ name: 'X' }, { category: 'Carnes', categorySource: 'ai' }).categorySource,
    ).toBe('ai');
  });
});

describe('deriveItem: decisões sobre a categoria', () => {
  const row = {
    category: 'Mercearia',
    categorySource: 'import',
    categoryReview: categoryReview('Bebidas'),
  };

  it('aceitar com a categoria sugerida: "ai" e sugestão accepted com quem decidiu e quando', () => {
    const derived = existing({ category: 'Bebidas', categoryDecision: 'accept' }, row);

    expect(derived.categorySource).toBe('ai');
    expect(suggestionOf(derived.categoryReview)).toMatchObject({
      status: 'accepted',
      category: 'Bebidas',
      ...DECIDED,
    });
  });

  it('aceitar com outra categoria vale como troca à mão: "user" e rejected "superseded" (D-1 (a))', () => {
    const derived = existing({ category: 'Bazar', categoryDecision: 'accept' }, row);

    expect(derived.categorySource).toBe('user');
    expect(suggestionOf(derived.categoryReview)).toMatchObject({
      status: 'rejected',
      reason: 'superseded',
    });
  });

  it('recusar fecha a sugestão e não muda a origem; a categoria não é tocada', () => {
    const derived = existing({ categoryDecision: 'reject' }, row);

    expect(derived.categorySource).toBe('import');
    expect(suggestionOf(derived.categoryReview)).toMatchObject({ status: 'rejected', ...DECIDED });
    expect(suggestionOf(derived.categoryReview)).not.toHaveProperty('reason');
  });

  it('bloquear grava o motivo da decisão na sugestão', () => {
    const derived = existing(
      { categoryDecision: 'blocked', categoryDecisionReason: 'levaria o item para outra página' },
      row,
    );

    expect(derived.categorySource).toBe('import');
    expect(suggestionOf(derived.categoryReview)).toMatchObject({
      status: 'blocked',
      reason: 'levaria o item para outra página',
      ...DECIDED,
    });
  });

  it('recusar junto com outra categoria: a categoria mudada é "user" e a sugestão fica recusada', () => {
    const derived = existing({ categoryDecision: 'reject', category: 'Bazar' }, row);

    expect(derived.categorySource).toBe('user');
    expect(suggestionOf(derived.categoryReview)).toMatchObject({ status: 'rejected' });
  });

  it.each(['accept', 'reject', 'blocked'] as const)(
    'decisão %s sem sugestão pendente é ignorada: nada muda',
    (categoryDecision) => {
      const closed = {
        checkedAt: 'x',
        jobId: null,
        suggestion: { status: 'rejected', category: 'Bebidas' },
      };
      for (const categoryReview of [
        null,
        closed,
        { checkedAt: 'x', jobId: null, suggestion: null },
      ]) {
        const derived = existing(
          { categoryDecision, ...(categoryDecision === 'accept' ? { category: 'Mercearia' } : {}) },
          { category: 'Mercearia', categorySource: 'import', categoryReview },
        );

        expect(derived.categorySource).toBe('import');
        expect(derived.categoryReview).toEqual(categoryReview);
      }
    },
  );
});

describe('deriveItem: foto', () => {
  it('grupo preenchido é "applied"; a sugestão pendente vira accepted se a origem é "suggestion"', () => {
    const derived = existing(
      { ...PHOTO, imageOrigin: 'suggestion' },
      { imageStatus: 'review', imageReview: imageReview() },
    );

    expect(derived.imageStatus).toBe('applied');
    expect(suggestionOf(derived.imageReview)).toMatchObject({ status: 'accepted', ...DECIDED });
  });

  it('foto do seletor com sugestão pendente: "applied" e a sugestão vira rejected "superseded"', () => {
    const derived = existing(
      { ...PHOTO, imageOrigin: 'picker' },
      { imageStatus: 'review', imageReview: imageReview() },
    );

    expect(derived.imageStatus).toBe('applied');
    expect(suggestionOf(derived.imageReview)).toMatchObject({
      status: 'rejected',
      reason: 'superseded',
    });
  });

  it('tirar a foto (grupo nulo) é "removed"; a sugestão pendente vira rejected sem motivo', () => {
    const derived = existing(NO_PHOTO, { imageStatus: 'review', imageReview: imageReview() });

    expect(derived.imageStatus).toBe('removed');
    expect(suggestionOf(derived.imageReview)).toMatchObject({ status: 'rejected', ...DECIDED });
    expect(suggestionOf(derived.imageReview)).not.toHaveProperty('reason');
  });

  it('item existente com foto aplicada e grupo nulo fica "removed"; sem revisão a revisão segue nula', () => {
    const derived = existing(NO_PHOTO, { imageStatus: 'applied', imageUrl: PHOTO.imageUrl });

    expect(derived.imageStatus).toBe('removed');
    expect(derived.imageReview).toBeNull();
  });

  it('item novo: grupo nulo é "removed", sem grupo é "none", com grupo é "applied"', () => {
    expect(created(NO_PHOTO).imageStatus).toBe('removed');
    expect(created().imageStatus).toBe('none');
    expect(created({ ...PHOTO, imageOrigin: 'picker' }).imageStatus).toBe('applied');
  });

  it('recusar as fotos sugeridas: rejected e "not_found"', () => {
    const derived = existing(
      { imageDecision: 'reject' },
      { imageStatus: 'review', imageReview: imageReview() },
    );

    expect(derived.imageStatus).toBe('not_found');
    expect(suggestionOf(derived.imageReview)).toMatchObject({ status: 'rejected', ...DECIDED });
  });

  it('recusar as fotos sem sugestão pendente é ignorado: o estado da foto segue', () => {
    const derived = existing(
      { imageDecision: 'reject' },
      { imageStatus: 'applied', imageReview: null },
    );

    expect(derived.imageStatus).toBe('applied');
    expect(derived.imageReview).toBeNull();
  });

  it('sem nada da foto no corpo, o estado e a revisão gravados ficam', () => {
    const row = { imageStatus: 'review', imageReview: imageReview() };

    const derived = existing({ name: 'ABACATE 2' }, row);

    expect(derived.imageStatus).toBe('review');
    expect(derived.imageReview).toEqual(row.imageReview);
  });
});

describe('deriveItem: EAN corrigido sem trocar a foto (PU-32)', () => {
  it('só o ean muda: foto, imageStatus e as revisões ficam como estão', () => {
    const row = {
      ean: '7891000100202',
      imageStatus: 'applied',
      galleryImageId: PHOTO.galleryImageId,
      imageUrl: PHOTO.imageUrl,
      imageReview: {
        checkedAt: 'x',
        jobId: null,
        eanStatus: 'gallery',
        applied: null,
        suggestion: null,
      },
      categoryReview: categoryReview(),
      spellReview: spellReview(),
      category: 'Mercearia',
      categorySource: 'import',
    };

    const derived = existing({ ean: '7891000100103' }, row);

    expect(derived).toEqual({
      categorySource: 'import',
      categoryReview: row.categoryReview,
      imageStatus: 'applied',
      imageReview: row.imageReview,
      spellReview: row.spellReview,
    });
  });
});

describe('deriveItem: ortografia', () => {
  it('nome diferente do gravado, sem decisão, apaga a revisão', () => {
    expect(
      existing({ name: 'ABACATE AVOCADO' }, { name: 'ABACATE', spellReview: spellReview() })
        .spellReview,
    ).toBeNull();
  });

  it('nome igual ao gravado (mesmo com espaços nas pontas) mantém a revisão', () => {
    const row = { name: 'ABACATE', spellReview: spellReview() };

    expect(
      existing({ name: 'ABACATE', price: { kind: 'simple', cents: 599 } }, row).spellReview,
    ).toEqual(row.spellReview);
    expect(existing({ name: ' ABACATE ' }, row).spellReview).toEqual(row.spellReview);
  });

  it('aceitar a correção fecha a sugestão como accepted', () => {
    const derived = existing(
      { name: 'ABACATE', spellDecision: 'accept' },
      { name: 'ABACAATE', spellReview: spellReview() },
    );

    expect(suggestionOf(derived.spellReview)).toMatchObject({
      status: 'accepted',
      value: 'ABACATE',
      ...DECIDED,
    });
  });

  it('recusar fecha como rejected e o nome não muda a revisão', () => {
    const derived = existing({ spellDecision: 'reject' }, { spellReview: spellReview() });

    expect(suggestionOf(derived.spellReview)).toMatchObject({ status: 'rejected', ...DECIDED });
  });

  it('decisão sem sugestão pendente é ignorada, e item novo não tem revisão', () => {
    expect(existing({ spellDecision: 'reject' }, { spellReview: null }).spellReview).toBeNull();
    expect(created().spellReview).toBeNull();
  });
});
