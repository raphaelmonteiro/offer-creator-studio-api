import { fakeEmbeddingService } from '../../gallery-embedding.testutil';
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

/** O corpo que a leitura do nome manda ao chat: o texto do usuário é a lista numerada dos nomes. */
export interface ChatBody {
  messages: Array<{ content: string }>;
}

export interface FindImagesWorldOptions {
  /** O ambiente do `ConfigService` simulado, sobre `OPENAI_API_KEY: 'sk-teste'`; `OPENAI_API_KEY: ''` tira os dois clientes. */
  env?: Record<string, string>;
  /** As linhas que o banco devolve a cada SQL (por trecho do SQL); sem ela, nenhuma linha. */
  galleryRows?: (sql: string) => unknown[];
  /** A resposta do chat à leitura do nome; sem ela, 503 em toda chamada. */
  chatAnswer?: (body: ChatBody) => unknown;
  /** O `embeddings.create` do cliente simulado; sem ele, 503 em toda chamada. */
  embeddingsCreate?: jest.Mock;
  /** A resolução por EAN da DotCompany; sem ela, `not_found` para todo EAN. */
  lookups?: { resolve: jest.Mock };
  /** O que o casamento por nome usa da taxonomia (`pathSimilarity`). */
  taxonomy?: object;
}

const notFoundLookups = () => ({
  resolve: jest.fn(async (eans: string[]) => ({
    outcomes: new Map(eans.map((ean) => [ean, { ean, input: ean, status: 'not_found' }])),
    credits: 0,
    requests: 0,
    blocked: null,
    authError: null,
  })),
});

/**
 * O serviço real de `findImages` com o casamento por nome, a leitura de nomes e o embedding reais, e os clientes da
 * OpenAI simulados (nenhuma chamada paga). O banco responde por `galleryRows`; a DotCompany, por `lookups`.
 */
export function buildFindImagesWorld(options: FindImagesWorldOptions = {}) {
  const env = { OPENAI_API_KEY: 'sk-teste', ...options.env };
  const config = fakeConfig(env);
  const query = jest.fn(async (sql: string) => options.galleryRows?.(sql) ?? []);
  const { embedding, create: embeddingsCreate } = fakeEmbeddingService({
    env,
    query,
    create: options.embeddingsCreate ?? jest.fn().mockRejectedValue(openAiError(503)),
  });
  const parser = new ProductNameParserService(config, {
    promptList: () => '101|Mercearia > Arroz',
  } as unknown as TaxonomyService);
  const chatCreate = env.OPENAI_API_KEY ? installFakeOpenAi(parser) : jest.fn();
  chatCreate.mockImplementation(async (body: ChatBody) => {
    if (!options.chatAnswer) throw openAiError(503);
    return options.chatAnswer(body);
  });
  spyOnLogger(parser);
  const matcher = new ProductImageMatchV2Service(
    embedding,
    parser,
    (options.taxonomy ?? {}) as never,
    config,
  );
  const lookups = options.lookups ?? notFoundLookups();
  const service = new FlyerEanResolutionService(
    { query } as never,
    matcher,
    lookups as never,
    {} as never,
    { criarJobDoEncarte: jest.fn() } as never,
    { wake: jest.fn() } as never,
    config,
  );
  return { service, embedding, chatCreate, embeddingsCreate, lookups, query };
}
