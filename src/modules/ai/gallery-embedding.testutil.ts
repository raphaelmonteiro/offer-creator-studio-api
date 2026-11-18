import { GalleryEmbeddingService } from './gallery-embedding.service';
import { fakeConfig, LoggerSpies, spyOnLogger } from './utils/openai-chat.testutil';

export interface FakeEmbeddingOptions {
  /** O ambiente do `ConfigService` simulado; `OPENAI_API_KEY` vazia ou ausente deixa o serviço sem cliente. */
  env?: Record<string, string>;
  /** O `query` do `DataSource` simulado (a busca por similaridade e as consultas da Galeria). */
  query?: jest.Mock;
  /** O `embeddings.create` do cliente da OpenAI simulado. */
  create?: jest.Mock;
}

/**
 * O `GalleryEmbeddingService` real com o cliente da OpenAI trocado por `{ embeddings: { create } }` (o serviço guarda o
 * SDK em `openai`) e o log silenciado: nenhuma chamada paga. Sem `OPENAI_API_KEY` no `env`, o cliente é `null`.
 */
export function fakeEmbeddingService(options: FakeEmbeddingOptions = {}): {
  embedding: GalleryEmbeddingService;
  create: jest.Mock;
  logs: LoggerSpies;
} {
  const env = options.env ?? { OPENAI_API_KEY: 'sk-teste' };
  const create = options.create ?? jest.fn();
  const embedding = new GalleryEmbeddingService(fakeConfig(env), {
    query: options.query ?? jest.fn(),
  } as never);
  (embedding as unknown as { openai: unknown }).openai = env.OPENAI_API_KEY
    ? { embeddings: { create } }
    : null;
  return { embedding, create, logs: spyOnLogger(embedding) };
}
