// O serviço puxa o importador de fotos → sharp, que não carrega no host.
jest.mock('sharp', () => jest.fn());

import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../../shared/providers/provider-errors';
import { GalleryEmbeddingService } from '../../gallery-embedding.service';
import { ProductImageMatchV2Service } from '../../metadata/product-image-match-v2.service';
import { ProductNameParserService } from '../../metadata/product-name-parser.service';
import { TaxonomyService } from '../../metadata/taxonomy/taxonomy.service';
import {
  fakeConfig,
  installFakeOpenAi,
  openAiError,
  spyOnLogger,
} from '../../utils/openai-chat.testutil';
import { FlyerEanResolutionService } from './flyer-ean-resolution.service';

/** EAN válido de exemplo (dígito verificador conferido). */
const EAN = '7896000000019';
const CERVEJA = { id: 'p-cerveja', name: 'CERVEJA PILSEN LATA 350ML', ean: EAN };
const ABACATE = { id: 'p-abacate', name: 'ABACATE KG' };

const PHOTO_BY_EAN = {
  id: 'img-ean',
  url: 'http://x/cerveja.png',
  thumbnailUrl: null,
  filename: 'cerveja.png',
  ean: EAN,
  source: 'manual',
  preferred: false,
};

/**
 * O serviço real de `findImages` com o casamento por nome, o leitor de nomes e o embedding reais, e os clientes da
 * OpenAI simulados: nenhuma chamada paga. O banco devolve a foto da Galeria só na consulta por EAN.
 */
function build(env: Record<string, string> = {}, galleryHasEan = false) {
  const config = fakeConfig({ OPENAI_API_KEY: 'sk-teste', ...env });
  const query = jest.fn(async (sql: string) =>
    galleryHasEan && sql.includes("metadata->>'ean'") ? [PHOTO_BY_EAN] : [],
  );
  const embedding = new GalleryEmbeddingService(config, { query } as never);
  const embeddingsCreate = jest.fn().mockRejectedValue(openAiError(503));
  (embedding as unknown as { openai: unknown }).openai = {
    embeddings: { create: embeddingsCreate },
  };
  spyOnLogger(embedding);
  const parser = new ProductNameParserService(config, {
    promptList: () => '101|Mercearia > Arroz',
  } as unknown as TaxonomyService);
  const chatCreate = installFakeOpenAi(parser);
  chatCreate.mockRejectedValue(openAiError(503));
  spyOnLogger(parser);
  const matcher = new ProductImageMatchV2Service(embedding, parser, {} as never, config);
  const lookups = {
    resolve: jest.fn(async (eans: string[]) => ({
      outcomes: new Map(eans.map((ean) => [ean, { ean, input: ean, status: 'not_found' }])),
      credits: 0,
      requests: 0,
      blocked: null,
      authError: null,
    })),
  };
  const service = new FlyerEanResolutionService(
    { query } as never,
    matcher,
    lookups as never,
    {} as never,
    { criarJobDoEncarte: jest.fn() } as never,
    { wake: jest.fn() } as never,
    config,
  );
  return { service, embedding, chatCreate, embeddingsCreate, lookups };
}

describe('FlyerEanResolutionService.findImages, modo estrito (change 28)', () => {
  it('429 de taxa na leitura de nomes com a opção: lança TransientProviderError', async () => {
    const { service, chatCreate } = build();
    chatCreate.mockRejectedValue(openAiError(429, 'taxa', 'rate_limit_exceeded'));

    await expect(service.findImages([CERVEJA, ABACATE], null, { strict: true })).rejects.toThrow(
      TransientProviderError,
    );
  });

  it('a mesma falha sem a opção: resultado vazio de hoje, sem exceção', async () => {
    const { service, chatCreate } = build();
    chatCreate.mockRejectedValue(openAiError(429, 'taxa', 'rate_limit_exceeded'));

    const result = await service.findImages([ABACATE, { id: 'p2', name: 'ARROZ 5KG' }]);

    expect(result.matches).toEqual([]);
    expect(result.reviewCandidates).toEqual([]);
  });

  it('chave inválida no embedding com a opção: lança TerminalProviderError', async () => {
    const { service, chatCreate, embeddingsCreate } = build({ AI_NAME_PARSER_ENABLED: 'false' });
    embeddingsCreate.mockRejectedValue(openAiError(401));

    expect(chatCreate).not.toHaveBeenCalled();
    await expect(service.findImages([ABACATE], null, { strict: true })).rejects.toThrow(
      TerminalProviderError,
    );
  });

  it('leitor desligado com a opção: não lança, não chama a leitura e segue pelo texto cru', async () => {
    const { service, chatCreate, embeddingsCreate } = build({ AI_NAME_PARSER_ENABLED: 'false' });
    embeddingsCreate.mockResolvedValue({ data: [{ embedding: new Array(1536).fill(0.1) }] });

    const result = await service.findImages([ABACATE], null, { strict: true });

    expect(chatCreate).not.toHaveBeenCalled();
    expect(embeddingsCreate).toHaveBeenCalledTimes(1);
    expect(result.matches).toEqual([]);
  });

  it('EAN da Galeria com a OpenAI fora do ar: lança com a opção, e sem ela devolve a foto do EAN', async () => {
    const { service } = build({}, true);

    await expect(service.findImages([CERVEJA], null, { strict: true })).rejects.toThrow(
      TransientProviderError,
    );
    const lenient = await service.findImages([CERVEJA]);

    expect(lenient.matches).toEqual([
      expect.objectContaining({ productId: CERVEJA.id, imageId: 'img-ean' }),
    ]);
    expect(lenient.eanStatus).toEqual([
      expect.objectContaining({ productId: CERVEJA.id, status: 'gallery' }),
    ]);
  });

  it('busca por EAN desligada: o estado do EAN é o mesmo com e sem a opção', async () => {
    const { service, embedding, lookups } = build({
      EAN_FLYER_RESOLVE_ENABLED: 'false',
      AI_NAME_PARSER_ENABLED: 'false',
    });
    const embedTexts = jest.spyOn(embedding, 'embedTexts').mockResolvedValue([null]);

    const strict = await service.findImages([CERVEJA], null, { strict: true });
    const lenient = await service.findImages([CERVEJA]);

    expect(strict.eanStatus).toEqual(lenient.eanStatus);
    expect(strict.eanStatus).toEqual([expect.objectContaining({ status: 'budget_blocked' })]);
    expect(lookups.resolve).not.toHaveBeenCalled();
    expect(embedTexts).toHaveBeenCalledWith([expect.any(String)], { strict: true });
  });
});
