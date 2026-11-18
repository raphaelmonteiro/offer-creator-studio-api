// O serviço puxa o importador de fotos → sharp, que não carrega no host.
jest.mock('sharp', () => jest.fn());

import { GalleryEmbeddingService } from '../../gallery-embedding.service';
import { ProductImageMatchV2Service } from '../../metadata/product-image-match-v2.service';
import { ProductNameParserService } from '../../metadata/product-name-parser.service';
import { TaxonomyService } from '../../metadata/taxonomy/taxonomy.service';
import { AiUsageCollector } from '../../utils/ai-usage';
import {
  chatResponse,
  fakeConfig,
  installFakeOpenAi,
  spyOnLogger,
} from '../../utils/openai-chat.testutil';
import { FlyerEanResolutionService } from './flyer-ean-resolution.service';

const PRODUCTS = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `p-${index}`, name: `ARROZ MARCA ${index}` }));

const NAME_ANSWER = chatResponse({
  content: JSON.stringify({
    results: Array.from({ length: 8 }, (_, index) => ({
      title: `ARROZ ${index}`,
      fieldConfidence: { title: 0.9 },
    })),
  }),
  usage: { prompt_tokens: 1000, completion_tokens: 200 },
});

/** `findImages` com a leitura de nomes real (cliente simulado, uso em cada chamada) e o embedding sem vetor. */
function build() {
  const config = fakeConfig({ OPENAI_API_KEY: 'sk-teste', EAN_FLYER_RESOLVE_ENABLED: 'false' });
  const query = jest.fn().mockResolvedValue([]);
  const embedding = new GalleryEmbeddingService(config, { query } as never);
  (embedding as unknown as { openai: unknown }).openai = {
    embeddings: { create: jest.fn().mockResolvedValue({ data: [] }) },
  };
  spyOnLogger(embedding);
  const parser = new ProductNameParserService(config, {
    promptList: () => '101|Mercearia > Arroz',
  } as unknown as TaxonomyService);
  const chatCreate = installFakeOpenAi(parser);
  chatCreate.mockResolvedValue(NAME_ANSWER);
  spyOnLogger(parser);
  const matcher = new ProductImageMatchV2Service(embedding, parser, {} as never, config);
  const service = new FlyerEanResolutionService(
    { query } as never,
    matcher,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    config,
  );
  return { service, chatCreate };
}

describe('FlyerEanResolutionService.findImages, uso da leitura do nome (change 29)', () => {
  it('16 nomes ainda não lidos: o uso traz o modelo, 2 chamadas e a soma dos tokens e dos custos', async () => {
    const { service, chatCreate } = build();
    const usage = new AiUsageCollector();

    await service.findImages(PRODUCTS(16), null, { usage });

    expect(chatCreate).toHaveBeenCalledTimes(2);
    expect(usage.snapshot()).toEqual({
      model: 'gpt-6-luna',
      models: ['gpt-6-luna'],
      calls: 2,
      inputTokens: 2000,
      outputTokens: 400,
      costUsd: 0.0004,
    });
  });

  it('os mesmos nomes já lidos pelo processo: nenhuma chamada, o modelo, zero tokens e custo 0', async () => {
    const { service, chatCreate } = build();
    await service.findImages(PRODUCTS(16), null, { usage: new AiUsageCollector() });
    chatCreate.mockClear();
    const usage = new AiUsageCollector();

    await service.findImages(PRODUCTS(16), null, { usage });

    expect(chatCreate).not.toHaveBeenCalled();
    expect(usage.snapshot()).toMatchObject({
      model: 'gpt-6-luna',
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('quem não pede o uso recebe o mesmo resultado, sem usage nele', async () => {
    const { service } = build();
    const asked = await service.findImages(PRODUCTS(8), null, { usage: new AiUsageCollector() });
    const plain = await service.findImages(PRODUCTS(8), null);

    expect(plain).toEqual(asked);
    expect(JSON.stringify(plain)).not.toMatch(/usage|costUsd|gpt-6/);
  });
});
