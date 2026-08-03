import { ProductImageMatchV2Service } from './product-image-match-v2.service';

/**
 * Cobre a regra da Feature 12/13: quando o cliente já marcou uma foto como
 * preferida, ela decide o match direto — o produto não vai para a tela de
 * revisão. Sem preferida, o comportamento por score permanece o mesmo.
 *
 * Os colaboradores são stubados: o que importa aqui é a decisão tomada sobre a
 * lista de candidatas já pontuadas, não como elas foram pontuadas.
 */
describe('ProductImageMatchV2Service — preferência do cliente', () => {
  const product = { id: 'p1', name: 'Contrafilé kg', category: null, unit: 'kg' };

  /**
   * Monta o service com `scoreCandidatesForProduct` stubado para devolver as
   * candidatas informadas (já ordenadas por score, como no fluxo real).
   */
  function buildService(
    candidates: Array<{ imageId: string; score: number; isClientPreferred: boolean }>,
  ) {
    const service = new ProductImageMatchV2Service(
      {} as never,
      { parseNames: jest.fn().mockResolvedValue([null]) } as never,
      {} as never,
      { get: jest.fn().mockReturnValue('0') } as never,
    );

    const full = candidates.map((c) => ({
      imageId: c.imageId,
      url: `https://cdn/${c.imageId}.jpg`,
      thumbnailUrl: null,
      filename: `${c.imageId}.jpg`,
      folderName: null,
      score: c.score,
      reasons: [],
      isClientPreferred: c.isClientPreferred,
    }));

    jest.spyOn(service as never, 'scoreCandidatesForProduct').mockResolvedValue(full as never);

    return service;
  }

  it('escolhe a preferida do cliente mesmo quando outra tem score maior', async () => {
    const service = buildService([
      { imageId: 'outra', score: 0.95, isClientPreferred: false },
      { imageId: 'favorita', score: 0.62, isClientPreferred: true },
    ]);

    const result = await service.findBestMatches([product], 'client-1');

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].imageId).toBe('favorita');
    expect(result.matches[0].isClientPreferred).toBe(true);
    // Não pede confirmação: a preferência do cliente já resolveu.
    expect(result.reviewCandidates).toHaveLength(0);
  });

  it('desempata pela preferida quando os scores são equivalentes', async () => {
    const service = buildService([
      { imageId: 'a', score: 0.7, isClientPreferred: false },
      { imageId: 'b', score: 0.7, isClientPreferred: true },
    ]);

    const result = await service.findBestMatches([product], 'client-1');

    expect(result.matches[0].imageId).toBe('b');
    expect(result.reviewCandidates).toHaveLength(0);
  });

  it('ignora preferida irrelevante (abaixo do piso) e mantém o fluxo por score', async () => {
    const service = buildService([
      { imageId: 'boa', score: 0.9, isClientPreferred: false },
      { imageId: 'preferida-de-outro-produto', score: 0.2, isClientPreferred: true },
    ]);

    const result = await service.findBestMatches([product], 'client-1');

    expect(result.matches[0].imageId).toBe('boa');
    expect(result.matches[0].isClientPreferred).toBe(false);
  });

  it('sem preferida: mantém o comportamento atual (auto-match acima de 0.75)', async () => {
    const service = buildService([{ imageId: 'boa', score: 0.8, isClientPreferred: false }]);

    const result = await service.findBestMatches([product], null);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].imageId).toBe('boa');
    expect(result.reviewCandidates).toHaveLength(0);
  });

  it('sem preferida: mantém a revisão na faixa intermediária (0.5–0.75)', async () => {
    const service = buildService([{ imageId: 'duvidosa', score: 0.6, isClientPreferred: false }]);

    const result = await service.findBestMatches([product], null);

    expect(result.matches).toHaveLength(0);
    expect(result.reviewCandidates).toHaveLength(1);
    expect(result.reviewCandidates[0].productId).toBe('p1');
  });
});
