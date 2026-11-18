import {
  canRetryEan,
  EAN_RETRY_DELAYS_SECONDS,
  EAN_RETRY_MAX_PASSES,
  eanRetryDelaySeconds,
  ImageSearchAnswer,
  imageSearchRequest,
  imageVerdictOf,
  retryCounts,
  withImageExtras,
} from './flyer-pro-enrich-image';
import type { EnrichResult } from './flyer-pro-job.types';

const match = (over: object = {}) => ({
  productId: 'i1',
  imageId: 'g-match',
  imageUrl: 'http://cdn/uploads/gallery/match.jpg',
  score: 0.81,
  reasons: ['marca + variante iguais'],
  isClientPreferred: false,
  ...over,
});
const candidate = (imageId: string, score: number) => ({
  imageId,
  url: `http://cdn/uploads/gallery/${imageId}.jpg`,
  thumbnailUrl: `http://cdn/uploads/thumbnails/${imageId}.jpg`,
  score,
  reasons: ['mesma marca'],
  isClientPreferred: false,
});
const answer = (over: Partial<ImageSearchAnswer> = {}): ImageSearchAnswer => ({
  matches: [],
  reviewCandidates: [],
  pending: [],
  eanStatus: [],
  ...over,
});
const withSize = (width = 800, height = 640) => ({
  sizes: new Map([['i1', { width, height }]]),
  nameSearch: true,
});
const withoutSize = { sizes: new Map([['i1', null]]), nameSearch: true };
const noNameSearch = { sizes: new Map(), nameSearch: false };
const item = { id: 'i1' };

describe('pedido da busca de fotos', () => {
  it('o nome da planilha quando há; senão o nome do item, nunca vazio', () => {
    const request = imageSearchRequest([
      { id: 'a', name: 'FILÉ DE TILÁPIA CONGELADO', sourceName: 'FILE DE TILAPIA CONJELADO' },
      { id: 'b', name: 'COXA E SOBRECOXA DE FRANGO', sourceName: null },
      { id: 'c', name: 'ABACATE', sourceName: '  ' },
      { id: 'd', name: 'SALSINHA' },
    ] as never);

    expect(request.map((entry) => entry.name)).toEqual([
      'FILE DE TILAPIA CONJELADO',
      'COXA E SOBRECOXA DE FRANGO',
      'ABACATE',
      'SALSINHA',
    ]);
  });

  it('leva a categoria, a unidade e o EAN do item', () => {
    expect(
      imageSearchRequest([
        { id: 'a', name: 'CERVEJA', category: 'Bebidas', unit: 'cada', ean: '7896000000019' },
        { id: 'b', name: 'ABACATE', category: null, unit: 'kg', ean: null },
      ] as never),
    ).toEqual([
      { id: 'a', name: 'CERVEJA', category: 'Bebidas', unit: 'cada', ean: '7896000000019' },
      { id: 'b', name: 'ABACATE', category: null, unit: 'kg', ean: null },
    ]);
  });
});

describe('resposta da busca → veredito da porta (precedência matches, pending, reviewCandidates, nenhum)', () => {
  it('matches com a medida lida: apply com a foto, a nota, os motivos e a medida', () => {
    const verdict = imageVerdictOf(item, answer({ matches: [match()] }), withSize(800, 640));
    expect(verdict).toEqual({
      itemId: 'i1',
      action: 'apply',
      eanStatus: null,
      photo: {
        galleryImageId: 'g-match',
        url: 'http://cdn/uploads/gallery/match.jpg',
        thumbnailUrl: null,
        score: 0.81,
        reasons: ['marca + variante iguais'],
        isClientPreferred: false,
        width: 800,
        height: 640,
      },
    });
  });

  it('matches sem a medida: review com a foto como única candidata, sem miniatura', () => {
    const verdict = imageVerdictOf(item, answer({ matches: [match()] }), withoutSize);
    expect(verdict).toMatchObject({ action: 'review' });
    const { candidates } = verdict as {
      candidates: Array<{ galleryImageId: string; thumbnailUrl: null }>;
    };
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ galleryImageId: 'g-match', thumbnailUrl: null });
  });

  it('matches vem antes de pending: EAN em consulta e foto pelo nome aplicada', () => {
    const verdict = imageVerdictOf(
      item,
      answer({
        matches: [match()],
        pending: ['i1'],
        eanStatus: [{ productId: 'i1', status: 'pending' }],
      }),
      withSize(),
    );
    expect(verdict).toMatchObject({ action: 'apply', eanStatus: 'pending' });
  });

  it('pending sem candidatas: pending vazio', () => {
    expect(imageVerdictOf(item, answer({ pending: ['i1'] }), withSize())).toEqual({
      itemId: 'i1',
      action: 'pending',
      candidates: [],
    });
  });

  it('pending com candidatas pelo nome: guarda as candidatas, até 3', () => {
    const reviewCandidates = [
      {
        productId: 'i1',
        candidates: ['a', 'b', 'c', 'd'].map((id, index) => candidate(id, 0.7 - index * 0.05)),
      },
    ];
    const verdict = imageVerdictOf(item, answer({ pending: ['i1'], reviewCandidates }), withSize());
    expect(verdict.action).toBe('pending');
    expect((verdict as { candidates: unknown[] }).candidates).toHaveLength(3);
  });

  it('reviewCandidates sem pending: review com as candidatas e a miniatura de cada uma', () => {
    const reviewCandidates = [
      { productId: 'i1', candidates: [candidate('a', 0.7), candidate('b', 0.6)] },
    ];
    const verdict = imageVerdictOf(item, answer({ reviewCandidates }), withSize());
    expect(verdict).toMatchObject({
      action: 'review',
      candidates: [
        { galleryImageId: 'a', thumbnailUrl: 'http://cdn/uploads/thumbnails/a.jpg', score: 0.7 },
        { galleryImageId: 'b', score: 0.6 },
      ],
    });
  });

  it('as três candidatas do ABACATE ficam, e uma quarta é cortada', () => {
    const reviewCandidates = [
      { productId: 'i1', candidates: ['a', 'b', 'c', 'd'].map((id) => candidate(id, 0.6)) },
    ];
    const verdict = imageVerdictOf(item, answer({ reviewCandidates }), withSize());
    expect((verdict as { candidates: unknown[] }).candidates).toHaveLength(3);
  });

  it('nada, com a busca por nome disponível: not_found', () => {
    expect(imageVerdictOf(item, answer(), withSize())).toEqual({
      itemId: 'i1',
      action: 'not_found',
      eanStatus: null,
    });
  });

  it('nada, com a busca por nome indisponível: o item continua como estava (unanswered), nunca not_found', () => {
    expect(imageVerdictOf(item, answer(), noNameSearch)).toEqual({
      itemId: 'i1',
      action: 'unanswered',
    });
  });

  it('com a busca por nome indisponível, o que o EAN achou ainda vale', () => {
    const verdict = imageVerdictOf(
      item,
      answer({ matches: [match({ reasons: ['EAN igual'], score: 1 })] }),
      { ...noNameSearch, sizes: new Map([['i1', { width: 800, height: 640 }]]) },
    );
    expect(verdict.action).toBe('apply');
  });

  it('eanStatus vem da entrada do item: sem crédito, EAN inválido e sem EAN (nulo)', () => {
    const blocked = answer({ eanStatus: [{ productId: 'i1', status: 'budget_blocked' }] });
    const invalid = answer({ eanStatus: [{ productId: 'i1', status: 'invalid' }] });
    expect(imageVerdictOf(item, blocked, withSize())).toMatchObject({
      eanStatus: 'budget_blocked',
    });
    expect(imageVerdictOf(item, invalid, withSize())).toMatchObject({ eanStatus: 'invalid' });
    expect(imageVerdictOf(item, answer(), withSize())).toMatchObject({ eanStatus: null });
  });

  it('só olha as entradas do próprio item', () => {
    const others = answer({
      matches: [match({ productId: 'outro' })],
      pending: ['outro'],
      eanStatus: [{ productId: 'outro', status: 'gallery' }],
    });
    expect(imageVerdictOf(item, others, withSize())).toMatchObject({
      action: 'not_found',
      eanStatus: null,
    });
  });
});

describe('contagens da passada do EAN (A-14, D-2 (a))', () => {
  it('o item que sai de ean_pending sai de eanPending e não conta de novo em visited', () => {
    expect(retryCounts({ visited: 3, applied: 1 })).toEqual({
      visited: 0,
      applied: 1,
      eanPending: -1,
    });
    expect(retryCounts({ visited: 4, applied: 1, review: 1, notFound: 1 })).toEqual({
      visited: 0,
      applied: 1,
      review: 1,
      notFound: 1,
      eanPending: -3,
    });
  });

  it('passada sem ninguém que saiu: nada muda', () => {
    expect(retryCounts({ visited: 2 })).toEqual({ visited: 0, eanPending: -0 });
  });
});

describe('campos opcionais de result.image_match', () => {
  const base = (extra: object = {}): EnrichResult => ({
    image_match: {
      visited: 78,
      applied: 62,
      review: 9,
      notFound: 7,
      eanPending: 0,
      skipped: null,
      ...extra,
    },
  });

  it('nameSearchUnavailable liga com a busca por nome indisponível e fica ausente com ela disponível', () => {
    expect(
      withImageExtras(base(), { nameSearchUnavailable: true, eanBudgetBlocked: 0 }).image_match,
    ).toMatchObject({ nameSearchUnavailable: true });
    expect(
      withImageExtras(base(), { nameSearchUnavailable: false, eanBudgetBlocked: 0 }).image_match,
    ).not.toHaveProperty('nameSearchUnavailable');
  });

  it('nameSearchUnavailable não desliga: um lote com a busca e outro sem deixam true', () => {
    const second = withImageExtras(base({ nameSearchUnavailable: true }), {
      nameSearchUnavailable: false,
      eanBudgetBlocked: 0,
    });
    expect(second.image_match).toMatchObject({ nameSearchUnavailable: true });
  });

  it('eanBudgetBlocked soma entre os lotes e fica ausente enquanto ninguém foi gravado com ele', () => {
    const none = withImageExtras(base(), { nameSearchUnavailable: false, eanBudgetBlocked: 0 });
    expect(none.image_match).not.toHaveProperty('eanBudgetBlocked');
    const one = withImageExtras(base(), { nameSearchUnavailable: false, eanBudgetBlocked: 1 });
    const three = withImageExtras(one, { nameSearchUnavailable: false, eanBudgetBlocked: 2 });
    expect(three.image_match).toMatchObject({ eanBudgetBlocked: 3 });
  });

  it('sem result.image_match (fase que não rodou), nada é criado', () => {
    expect(withImageExtras({}, { nameSearchUnavailable: true, eanBudgetBlocked: 1 })).toEqual({});
  });
});

describe('passadas do EAN pendente: quantas e quanto esperam', () => {
  it('no máximo 3 passadas por job, com a espera de 30, 60 e 120 s', () => {
    expect(EAN_RETRY_MAX_PASSES).toBe(3);
    expect(EAN_RETRY_DELAYS_SECONDS).toEqual([30, 60, 120]);
    expect([1, 2, 3].map(eanRetryDelaySeconds)).toEqual([30, 60, 120]);
  });

  it('cabe outra passada enquanto o job usou menos de 3', () => {
    expect([0, 1, 2, 3, 4].map(canRetryEan)).toEqual([true, true, true, false, false]);
  });

  it('o maior atraso (120 s) fica abaixo dos 180 s de stalled e dos 300 s do reconciliador', () => {
    expect(Math.max(...EAN_RETRY_DELAYS_SECONDS)).toBeLessThan(180);
  });
});
