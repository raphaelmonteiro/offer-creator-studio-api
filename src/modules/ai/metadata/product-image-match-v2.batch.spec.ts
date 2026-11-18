import * as fs from 'fs';
import * as path from 'path';
import { openAiError } from '../utils/openai-chat.testutil';
import { TransientProviderError } from '../../../shared/providers/provider-errors';
import {
  buildBatchService,
  buildRealEmbeddingService,
  PRODUCT_NAMES,
  snapshotOf,
  vectorOf,
} from './product-image-match-v2.batch.testutil';

/**
 * O resultado do casamento por nome para 78 produtos, gravado com o código de antes (o pedido de um embedding por produto,
 * commit aa22e2f) pelo mesmo `buildBatchService`: o teste de igualdade do requisito "Embedding em lote no casamento por
 * nome". O embedding simulado dá o mesmo vetor ao mesmo texto, então o resultado só muda se o código mudar a conta.
 */
const GOLDEN = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'product-image-match-v2.batch.golden.json'), 'utf8'),
);

describe('ProductImageMatchV2Service: embedding em lote (change 29)', () => {
  it('78 produtos: matches, reviewCandidates e candidatas idênticos aos do pedido por produto', async () => {
    const { service } = buildBatchService();

    const matched = await service.matchWithCandidates(PRODUCT_NAMES(78), 'client-1');

    expect(snapshotOf(matched)).toEqual(GOLDEN);
    // a Galeria de teste dá os três tipos de resultado e a preferida do cliente
    expect(matched.result.matches.length).toBeGreaterThan(20);
    expect(matched.result.reviewCandidates.length).toBeGreaterThan(0);
    expect(matched.result.matches.some((m) => m.isClientPreferred)).toBe(true);
    expect(matched.result.scanned - matched.result.matches.length).toBeGreaterThan(20);
  });

  it('78 produtos: uma chamada de embedding com os 78 textos, em vez de 78', async () => {
    const { service, embedText, embedTexts } = buildBatchService();

    await service.matchWithCandidates(PRODUCT_NAMES(78), null);

    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(embedTexts.mock.calls[0][0]).toHaveLength(78);
    expect(embedText).not.toHaveBeenCalled();
  });

  it('200 produtos: três chamadas à OpenAI, com 96, 96 e 8 textos', async () => {
    const { service, create } = buildRealEmbeddingService();

    await service.matchWithCandidates(PRODUCT_NAMES(200), null);

    expect(create.mock.calls.map(([body]) => body.input.length)).toEqual([96, 96, 8]);
  });

  it('produto sem texto de busca fica fora do pedido e sem candidatas', async () => {
    const { service, embedTexts, searchByMetadataEmbedding, parseNames } = buildBatchService();
    parseNames.mockResolvedValue([null, null, null] as never);
    const products = [
      { id: 'a', name: 'ABACATE KG', category: null, unit: 'kg' },
      { id: 'vazio', name: '   ', category: null, unit: null },
      { id: 'c', name: 'CERVEJA', category: null, unit: 'un' },
    ];

    const { candidates } = await service.matchWithCandidates(products, null);

    expect(embedTexts.mock.calls[0][0]).toEqual(['ABACATE KG kg', 'CERVEJA un']);
    expect(candidates.get('vazio')).toEqual([]);
    expect(candidates.get('a')?.length).toBeGreaterThan(0);
    expect(searchByMetadataEmbedding).toHaveBeenCalledTimes(2);
  });

  it('a lista toda sem texto: nenhum vetor pedido e nenhum erro', async () => {
    const { service, embedTexts, parseNames } = buildBatchService();
    parseNames.mockResolvedValue([null] as never);

    const { result } = await service.matchWithCandidates(
      [{ id: 'vazio', name: ' ', category: null, unit: null }],
      null,
    );

    expect(result).toEqual({ matches: [], reviewCandidates: [], scanned: 1, matched: 0 });
    expect(embedTexts.mock.calls[0][0]).toEqual([]);
  });

  it('o vetor de um produto é o do texto dele, na posição certa, mesmo com produtos sem texto no meio', async () => {
    const { service, searchByMetadataEmbedding, parseNames } = buildBatchService();
    parseNames.mockResolvedValue([null, null] as never);

    await service.matchWithCandidates(
      [
        { id: 'vazio', name: ' ', category: null, unit: null },
        { id: 'b', name: 'BANANA', category: null, unit: null },
      ],
      null,
    );

    expect(searchByMetadataEmbedding).toHaveBeenCalledTimes(1);
    expect(searchByMetadataEmbedding.mock.calls[0][0]).toEqual(vectorOf('BANANA'));
  });

  describe('falha do embedding em lote', () => {
    it('sem o modo estrito: a segunda de três chamadas falha, só os produtos 97 a 192 ficam sem candidatas pelo nome', async () => {
      const { service, create, search, errorLog } = buildRealEmbeddingService();
      const answers = async (body: { input: string[] }) => ({
        data: body.input.map(() => ({ embedding: [0.5, 0.5] })),
      });
      // a primeira chamada (textos 0 a 95) responde, a segunda (96 a 191) falha com 503 e a terceira (192 a 199) responde
      create
        .mockImplementationOnce(answers)
        .mockRejectedValueOnce(openAiError(503))
        .mockImplementationOnce(answers);

      const { candidates, result } = await service.matchWithCandidates(PRODUCT_NAMES(200), null);

      expect(result.scanned).toBe(200);
      expect(search).toHaveBeenCalledTimes(96 + 8);
      for (const index of [0, 95, 192, 199]) {
        expect(candidates.get(`p-${index}`)?.length).toBeGreaterThan(0);
      }
      for (const index of [96, 150, 191]) expect(candidates.get(`p-${index}`)).toEqual([]);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('Falha ao gerar embeddings'));
    });

    it('com o modo estrito: a falha sobe classificada como transitória, sem resultado parcial', async () => {
      const { service, create, search } = buildRealEmbeddingService();
      create.mockRejectedValue(openAiError(503));

      await expect(
        service.matchWithCandidates(PRODUCT_NAMES(200), null, { strict: true }),
      ).rejects.toBeInstanceOf(TransientProviderError);
      expect(search).not.toHaveBeenCalled();
    });
  });

  it('repassa o sinal de cancelamento ao leitor de nomes e ao embedding em lote', async () => {
    const { service, embedTexts, parseNames } = buildBatchService();
    const { signal } = new AbortController();

    await service.matchWithCandidates(PRODUCT_NAMES(3), null, { signal });

    expect(embedTexts.mock.calls[0][1]).toMatchObject({ signal });
    expect(parseNames.mock.calls[0][1]).toMatchObject({ signal });
  });
});
