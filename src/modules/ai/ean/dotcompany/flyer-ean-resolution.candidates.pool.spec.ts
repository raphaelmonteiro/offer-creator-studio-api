// O serviço puxa o importador de fotos → sharp, que não carrega no host.
jest.mock('sharp', () => jest.fn());

import { productAliasKey } from '../../../gallery/product-alias';
import { BEER_EAN } from './flyer-ean-resolution.candidates.testutil';
import { ALIAS_REASON } from './flyer-ean-resolution.service';
import { buildFindImagesWorld } from './flyer-ean-resolution.testutil';

/**
 * A rota de candidatas (E2, change 27) sobre o casamento por nome real da change 28 e da 29: o pool da busca vira
 * objeto (`{ includeIds }`) e a busca da E2 segue sem `strict`. A OpenAI e o banco são simulados (nenhuma chamada paga).
 */
const ABACATE = { id: 'inline', name: 'ABACATE', category: 'Hortifruti', unit: 'kg' };
const PINNED = '141da073-e2ab-4c8e-bb79-28e24074f743';

const aliasRow = {
  id: PINNED,
  url: `http://localhost:3101/uploads/gallery/${PINNED}.png`,
  thumbnailUrl: null,
  filename: 'abacate.png',
  key: productAliasKey('ABACATE'),
  chosenAt: '2026-11-20T10:00:00.000Z',
  preferred: false,
};

/** O banco devolve a foto escolhida antes só na consulta pelos nomes (`metadata.aliases`). */
const galleryHasAlias = (sql: string) => (sql.includes('jsonb_array_elements') ? [aliasRow] : []);

/** As chamadas ao banco que buscam as fotos fixadas pelo id (a segunda parte da busca por similaridade). */
const pinnedQueries = (query: jest.Mock) =>
  (query.mock.calls as unknown[][]).filter(([sql]) =>
    String(sql).includes('gi.id = ANY($2::uuid[])'),
  );

describe('FlyerEanResolutionService.findCandidatesForProduct: pool e modo da busca por nome', () => {
  it('com ean e o embedding falhando, a busca não lança e a foto escolhida antes volta', async () => {
    const { service, embeddingsCreate } = buildFindImagesWorld({ galleryRows: galleryHasAlias });

    const result = await service.findCandidatesForProduct({ ...ABACATE, ean: BEER_EAN }, 12, null);

    expect(embeddingsCreate).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      expect.objectContaining({ imageId: PINNED, score: 0, reasons: [ALIAS_REASON] }),
    ]);
  });

  it('o pool da busca por embedding recebe as fotos escolhidas antes (includeIds)', async () => {
    const { service, query } = buildFindImagesWorld({
      galleryRows: galleryHasAlias,
      embeddingsCreate: jest
        .fn()
        .mockResolvedValue({ data: [{ embedding: new Array(1536).fill(0.1) }] }),
    });

    await service.findCandidatesForProduct({ ...ABACATE, ean: null }, 12, null);

    const pinnedCalls = pinnedQueries(query);
    expect(pinnedCalls).toHaveLength(1);
    expect((pinnedCalls[0][1] as unknown[])[1]).toEqual([PINNED]);
  });

  it('sem foto escolhida antes, o pool não pede fixadas', async () => {
    const { service, query } = buildFindImagesWorld({
      embeddingsCreate: jest
        .fn()
        .mockResolvedValue({ data: [{ embedding: new Array(1536).fill(0.1) }] }),
    });

    await service.findCandidatesForProduct({ ...ABACATE, ean: null }, 12, null);

    expect(pinnedQueries(query)).toEqual([]);
  });
});
