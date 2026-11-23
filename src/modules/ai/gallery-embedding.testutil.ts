import { GalleryEmbeddingService, MetadataEmbeddingMatch } from './gallery-embedding.service';
import { fakeConfig, LoggerSpies, spyOnLogger } from './utils/openai-chat.testutil';

export interface FakeEmbeddingOptions {
  /** O ambiente do `ConfigService` simulado; `OPENAI_API_KEY` vazia ou ausente deixa o serviço sem cliente, como no construtor. */
  env?: Record<string, string>;
  /** O `query` do `DataSource` simulado (a busca por similaridade e as consultas da Galeria). */
  query?: jest.Mock;
  /** O `embeddings.create` do cliente da OpenAI simulado. */
  create?: jest.Mock;
}

/**
 * O `GalleryEmbeddingService` real com o cliente da OpenAI trocado por `{ embeddings: { create } }` (o serviço guarda o
 * SDK em `openai`) e o log silenciado: nenhuma chamada paga. O cliente simulado só entra onde o construtor criou um; sem
 * `OPENAI_API_KEY` no `env`, o cliente segue `null`, como o construtor o deixa.
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
  // O cliente simulado entra só onde o construtor criou um: o ajudante nunca decide, a partir do `env`, o que o serviço decide.
  const target = embedding as unknown as { openai: unknown };
  if (target.openai) target.openai = { embeddings: { create } };
  return { embedding, create, logs: spyOnLogger(embedding) };
}

/** Uma linha da busca por embedding com vetor fixo: o que a Galeria devolve ao casamento por nome. */
export const poolRow = (id: string, distance: number): MetadataEmbeddingMatch => ({
  id,
  filename: `${id}.png`,
  url: `http://localhost:3101/uploads/gallery/${id}.png`,
  thumbnailUrl: null,
  folderId: null,
  folderName: null,
  distance,
  isClientPreferred: false,
  metadata: null,
});
