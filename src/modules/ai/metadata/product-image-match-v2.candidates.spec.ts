import { poolRow } from '../gallery-embedding.testutil';
import { ProductImageMatchV2Service } from './product-image-match-v2.service';

/**
 * `findCandidates` com fotos fixadas (change 27, U2.8): sem fixadas devolve o top-N de sempre; com fixadas, as que a
 * busca por nome achou entram no resultado mesmo fora do top-N, e o pool da busca as recebe (`includeIds`).
 */
describe('ProductImageMatchV2Service.findCandidates com fixadas', () => {
  const product = { id: 'inline', name: 'ABACATE', category: 'Hortifruti', unit: 'kg' };

  function makeService(scored: Array<{ imageId: string; score: number }>) {
    const embedding = {
      embedText: jest.fn().mockResolvedValue([0.1, 0.2]),
      searchByMetadataEmbedding: jest.fn().mockResolvedValue([]),
    };
    const service = new ProductImageMatchV2Service(
      embedding as never,
      { parseSingle: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
      { get: jest.fn().mockReturnValue('0') } as never,
    );
    const full = scored.map((candidate) => ({
      ...poolRow(candidate.imageId, 0.1),
      imageId: candidate.imageId,
      score: candidate.score,
      reasons: [],
    }));
    jest.spyOn(service as never, 'scoreCandidatesForProduct').mockResolvedValue(full as never);
    return { service, embedding };
  }

  const SCORED = [
    { imageId: 'a', score: 0.9 },
    { imageId: 'b', score: 0.8 },
    { imageId: 'c', score: 0.3 },
    { imageId: 'd', score: 0.1 },
  ];

  it('sem fixadas devolve o top-N, como antes', async () => {
    const { service } = makeService(SCORED);
    const result = await service.findCandidates(product, 2, null);
    expect(result.map((candidate) => candidate.imageId)).toEqual(['a', 'b']);
  });

  it('com fixadas, a fixada que ficou fora do top-N entra no fim, e as outras fora dele continuam fora', async () => {
    const { service } = makeService(SCORED);
    const result = await service.findCandidates(product, 2, null, ['c']);
    expect(result.map((candidate) => candidate.imageId)).toEqual(['a', 'b', 'c']);
  });

  it('com fixadas, a que já está no top-N não se repete', async () => {
    const { service } = makeService(SCORED);
    const result = await service.findCandidates(product, 2, null, ['a']);
    expect(result.map((candidate) => candidate.imageId)).toEqual(['a', 'b']);
  });

  it('a lista vazia de fixadas vale como sem fixadas', async () => {
    const { service } = makeService(SCORED);
    const result = await service.findCandidates(product, 2, null, []);
    expect(result.map((candidate) => candidate.imageId)).toEqual(['a', 'b']);
  });
});

describe('ProductImageMatchV2Service.findCandidates: o pool da busca recebe as fixadas', () => {
  it('passa os ids fixados como includeIds para a busca por embedding', async () => {
    const embedding = {
      embedText: jest.fn().mockResolvedValue([0.1, 0.2]),
      searchByMetadataEmbedding: jest.fn().mockResolvedValue([]),
    };
    const service = new ProductImageMatchV2Service(
      embedding as never,
      { parseSingle: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
      { get: jest.fn().mockReturnValue('0') } as never,
    );

    await service.findCandidates({ id: 'inline', name: 'ABACATE' }, 12, 'c1', ['p1', 'p2']);
    await service.findCandidates({ id: 'inline', name: 'ABACATE' }, 12, 'c1');

    const [withPinned, without] = embedding.searchByMetadataEmbedding.mock.calls;
    expect(withPinned[2]).toEqual({ clientId: 'c1', includeIds: ['p1', 'p2'] });
    expect(without[2]).toEqual({ clientId: 'c1', includeIds: undefined });
  });
});
