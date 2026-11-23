// O serviço puxa o importador de fotos → sharp, que não carrega no host.
jest.mock('sharp', () => jest.fn());

import { ALIAS_REASON, FlyerEanResolutionService } from './flyer-ean-resolution.service';
import {
  BAD_EAN,
  BEER_EAN,
  FakePhoto,
  fakeGalleryQuery,
  OTHER_CLIENT,
  PICCIN,
  scoredOf,
} from './flyer-ean-resolution.candidates.testutil';

const BEER = {
  id: 'inline',
  name: 'CERVEJA PILSEN GARRAFA 600ML',
  category: 'Bebidas',
  unit: 'cada',
};
const ABACATE = { id: 'inline', name: 'ABACATE', category: 'Hortifruti', unit: 'kg' };

/** A DotCompany e o resto do serviço: qualquer uso derruba o teste (a rota só lê a Galeria). */
const forbidden = new Proxy(
  {},
  {
    get: (_target, name) => () => {
      throw new Error(`a rota de candidatas não pode usar ${String(name)}`);
    },
  },
);

type Scored = ReturnType<typeof scoredOf>;

function makeService(photos: FakePhoto[], named: Scored[] = []) {
  const query = fakeGalleryQuery(photos);
  const matcher = { findCandidates: jest.fn().mockResolvedValue(named) };
  const service = new FlyerEanResolutionService(
    { query } as never,
    matcher as never,
    forbidden as never,
    forbidden as never,
    forbidden as never,
    forbidden as never,
    { get: (_key: string, fallback?: string) => fallback } as never,
  );
  return { service, matcher, query };
}

const idsOf = (candidates: Array<{ imageId: string }>) =>
  candidates.map((candidate) => candidate.imageId);

describe('FlyerEanResolutionService.findCandidatesForProduct: fotos do EAN', () => {
  const twoBeers: FakePhoto[] = [
    { id: 'beer-1', ean: BEER_EAN },
    { id: 'beer-2', ean: BEER_EAN },
  ];

  it('as fotos do EAN vêm antes das da busca por nome, com "EAN igual" e nota 1', async () => {
    const { service } = makeService(twoBeers, [scoredOf('name-1', 0.9), scoredOf('name-2', 0.6)]);

    const result = await service.findCandidatesForProduct({ ...BEER, ean: BEER_EAN }, 12, null);

    expect(idsOf(result)).toEqual(['beer-1', 'beer-2', 'name-1', 'name-2']);
    expect(result[0]).toMatchObject({ score: 1, reasons: ['EAN igual'], isClientPreferred: false });
    expect(result[1].reasons).toEqual(['EAN igual']);
  });

  it('acha o EAN gravado com zero à esquerda (outra variante do mesmo GTIN)', async () => {
    const { service } = makeService([{ id: 'beer-14', ean: `0${BEER_EAN}` }]);

    const result = await service.findCandidatesForProduct({ ...BEER, ean: BEER_EAN }, 12, null);

    expect(idsOf(result)).toEqual(['beer-14']);
  });

  it('foto do EAN que a busca por nome também acha aparece uma só vez, na posição do EAN', async () => {
    const { service } = makeService(twoBeers, [
      scoredOf('name-1', 0.95),
      scoredOf('beer-2', 0.8, ['categoria igual']),
    ]);

    const result = await service.findCandidatesForProduct({ ...BEER, ean: BEER_EAN }, 12, null);

    expect(idsOf(result)).toEqual(['beer-1', 'beer-2', 'name-1']);
    expect(result[1]).toMatchObject({ score: 1, reasons: ['EAN igual', 'categoria igual'] });
  });

  it('a preferida do cliente vem primeiro entre as do EAN, com isClientPreferred', async () => {
    const photos: FakePhoto[] = [
      { id: 'beer-1', ean: BEER_EAN },
      { id: 'beer-2', ean: BEER_EAN, preferredBy: [PICCIN] },
    ];
    const { service } = makeService(photos);

    const result = await service.findCandidatesForProduct({ ...BEER, ean: BEER_EAN }, 12, PICCIN);

    expect(idsOf(result)).toEqual(['beer-2', 'beer-1']);
    expect(result[0].isClientPreferred).toBe(true);
    expect(result[1].isClientPreferred).toBe(false);
  });

  it('preferida de outro cliente não passa na frente', async () => {
    const photos: FakePhoto[] = [
      { id: 'beer-1', ean: BEER_EAN },
      { id: 'beer-2', ean: BEER_EAN, preferredBy: [OTHER_CLIENT] },
    ];
    const { service } = makeService(photos);

    const result = await service.findCandidatesForProduct({ ...BEER, ean: BEER_EAN }, 12, PICCIN);

    expect(idsOf(result)).toEqual(['beer-1', 'beer-2']);
  });

  it('respeita o limit mesmo quando só as fotos do EAN já o enchem', async () => {
    const photos = ['a', 'b', 'c'].map((id) => ({ id: `beer-${id}`, ean: BEER_EAN }));
    const { service } = makeService(photos, [scoredOf('name-1', 0.9)]);

    const result = await service.findCandidatesForProduct({ ...BEER, ean: BEER_EAN }, 2, null);

    expect(idsOf(result)).toEqual(['beer-a', 'beer-b']);
  });

  it('EAN sem nenhuma foto na Galeria: a lista é a da busca por nome, sem consultar a DotCompany', async () => {
    const { service } = makeService([], [scoredOf('name-1', 0.9)]);

    const result = await service.findCandidatesForProduct(
      { ...BEER, ean: '7891000100103' },
      12,
      null,
    );

    expect(idsOf(result)).toEqual(['name-1']);
  });
});

describe('FlyerEanResolutionService.findCandidatesForProduct: nome já escolhido', () => {
  const chosen = (id: string, chosenAt: string, over: Partial<FakePhoto> = {}): FakePhoto => ({
    id,
    aliases: [{ name: 'Abacate', chosenAt }],
    ...over,
  });

  it('ABACATE sem EAN: a foto com o nome escolhido vem primeiro, com "nome escolhido antes"', async () => {
    const { service } = makeService(
      [chosen('abacate-1', '2026-11-09T10:00:00Z')],
      [scoredOf('name-1', 0.9)],
    );

    const result = await service.findCandidatesForProduct({ ...ABACATE, ean: null }, 12, PICCIN);

    expect(idsOf(result)).toEqual(['abacate-1', 'name-1']);
    expect(result[0].reasons).toEqual([ALIAS_REASON]);
  });

  it('as fixadas vão à busca por nome (para receber a nota de verdade) e voltam com a nota dela', async () => {
    const { service, matcher } = makeService(
      [chosen('abacate-1', '2026-11-09T10:00:00Z')],
      [scoredOf('name-1', 0.9), scoredOf('abacate-1', 0.7, ['categoria igual'])],
    );

    const result = await service.findCandidatesForProduct({ ...ABACATE, ean: null }, 12, PICCIN);

    expect(matcher.findCandidates).toHaveBeenCalledWith({ ...ABACATE, ean: null }, 12, PICCIN, [
      'abacate-1',
    ]);
    expect(result[0]).toMatchObject({
      imageId: 'abacate-1',
      score: 0.7,
      reasons: [ALIAS_REASON, 'categoria igual'],
    });
  });

  it('com a busca por nome vazia (embedding desligado), as fixadas voltam mesmo assim, com nota 0', async () => {
    const { service } = makeService([chosen('abacate-1', '2026-11-09T10:00:00Z')], []);

    const result = await service.findCandidatesForProduct({ ...ABACATE, ean: null }, 12, null);

    expect(result).toEqual([
      expect.objectContaining({ imageId: 'abacate-1', score: 0, reasons: [ALIAS_REASON] }),
    ]);
  });

  it('entre as escolhidas, a preferida do cliente antes e depois a escolha mais recente', async () => {
    const photos = [
      chosen('velha', '2026-10-01T10:00:00Z'),
      chosen('nova', '2026-11-16T10:00:00Z'),
      chosen('preferida', '2026-09-01T10:00:00Z', { preferredBy: [PICCIN] }),
    ];
    const { service } = makeService(photos);

    const result = await service.findCandidatesForProduct({ ...ABACATE, ean: null }, 12, PICCIN);

    expect(idsOf(result)).toEqual(['preferida', 'nova', 'velha']);
  });

  it('EAN e nome escolhido no mesmo item: o EAN primeiro, o nome escolhido depois, a busca por nome por último', async () => {
    const photos: FakePhoto[] = [
      { id: 'alias-only', aliases: [{ name: BEER.name, chosenAt: '2026-11-09T10:00:00Z' }] },
      { id: 'ean-only', ean: BEER_EAN },
    ];
    const { service } = makeService(photos, [scoredOf('name-1', 0.9)]);

    const result = await service.findCandidatesForProduct({ ...BEER, ean: BEER_EAN }, 12, null);

    expect(idsOf(result)).toEqual(['ean-only', 'alias-only', 'name-1']);
  });

  it('foto com o EAN e o nome escolhido aparece uma só vez, com os dois motivos', async () => {
    const photos: FakePhoto[] = [
      {
        id: 'both',
        ean: BEER_EAN,
        aliases: [{ name: BEER.name, chosenAt: '2026-11-09T10:00:00Z' }],
      },
    ];
    const { service } = makeService(photos);

    const result = await service.findCandidatesForProduct({ ...BEER, ean: BEER_EAN }, 12, null);

    expect(result).toHaveLength(1);
    expect(result[0].reasons).toEqual(['EAN igual', ALIAS_REASON]);
  });

  it('o nome escolhido para outro produto não entra', async () => {
    const photos: FakePhoto[] = [
      { id: 'cerveja', aliases: [{ name: BEER.name, chosenAt: '2026-11-09T10:00:00Z' }] },
    ];
    const { service } = makeService(photos, [scoredOf('name-1', 0.9)]);

    const result = await service.findCandidatesForProduct({ ...ABACATE, ean: null }, 12, null);

    expect(idsOf(result)).toEqual(['name-1']);
  });
});

describe('FlyerEanResolutionService.findCandidatesForProduct: EAN ausente de efeito', () => {
  const photos: FakePhoto[] = [
    { id: 'beer-ean', ean: BEER_EAN },
    { id: 'beer-name', aliases: [{ name: BEER.name, chosenAt: '2026-11-09T10:00:00Z' }] },
  ];

  it.each([
    ['null', null],
    ['texto vazio', ''],
    ['dígito verificador errado', BAD_EAN],
    ['comprimento errado', '123'],
  ])('ean %s: só as fotos do nome escolhido, nenhuma com "EAN igual"', async (_name, ean) => {
    const { service } = makeService(photos, [scoredOf('name-1', 0.9)]);

    const result = await service.findCandidatesForProduct({ ...BEER, ean }, 12, null);

    expect(idsOf(result)).toEqual(['beer-name', 'name-1']);
    expect(result.flatMap((candidate) => candidate.reasons)).not.toContain('EAN igual');
  });

  it('nenhuma foto pelo EAN nem pelo nome e sem busca por nome: lista vazia', async () => {
    const { service } = makeService([], []);

    const result = await service.findCandidatesForProduct(
      { ...BEER, ean: '7891000100103' },
      12,
      null,
    );

    expect(result).toEqual([]);
  });
});
