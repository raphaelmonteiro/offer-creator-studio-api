import { createHash } from 'crypto';
import { MetadataEmbeddingMatch } from '../gallery-embedding.service';
import { fakeEmbeddingService } from '../gallery-embedding.testutil';
import { ProductMetadata } from './product-metadata.schema';
import { ProductImageMatchV2Service, ProductMatchInputV2 } from './product-image-match-v2.service';

/**
 * Apoio dos testes do embedding em lote do casamento por nome: um embedding de vetores fixos por texto (o mesmo texto dá
 * sempre o mesmo vetor), uma Galeria de 12 fotos pontuadas pela distância ao vetor e um leitor de nomes que devolve a
 * ficha de cada produto pelo próprio nome. Nenhuma chamada à OpenAI.
 */

const hashOf = (text: string): number => {
  let hash = 7;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
  return hash;
};

/** O vetor fixo de um texto de busca: os números só precisam ser estáveis e diferentes entre textos. */
export const vectorOf = (text: string): number[] => {
  const hash = hashOf(text);
  return [(hash % 997) / 997, (hash % 211) / 211];
};

export const PRODUCT_NAMES = (count: number): ProductMatchInputV2[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `p-${index}`,
    name: `PRODUTO ${index} MARCA${index % 6}`,
    category: index % 4 === 0 ? 'Mercearia' : null,
    unit: 'un',
  }));

const metadataOf = (name: string): ProductMetadata => {
  const brand = /MARCA(\d)/.exec(name)?.[1] ?? '0';
  return {
    title: name,
    category: { id: 10 + (Number(brand) % 3), path: ['Mercearia', `Grupo ${Number(brand) % 3}`] },
    quantity: { value: 100 * (1 + (Number(brand) % 4)), unit: 'g' },
    packageType: 'caixa',
    pack: null,
    alternatives: [{ brand: `MARCA${brand}`, subBrand: null, variant: null }],
    ean: null,
    sku: null,
    claims: [],
    promo: null,
    dominantColors: [],
    fieldConfidence: { title: 0.9, brand: 0.9 },
    source: 'name-parse',
    modelVersion: 'teste',
    warnings: [],
  };
};

/** A Galeria de teste: 12 fotos, cada uma com a ficha de uma das marcas. */
const GALLERY: MetadataEmbeddingMatch[] = Array.from({ length: 12 }, (_, index) => ({
  id: `img-${index}`,
  filename: `img-${index}.png`,
  url: `http://cdn.teste/uploads/gallery/img-${index}.png`,
  thumbnailUrl: null,
  folderId: null,
  folderName: null,
  distance: 0,
  metadata: metadataOf(`FOTO ${index} MARCA${index % 4}`),
  isClientPreferred: false,
}));

/** As fotos mais próximas do vetor, com a distância real, e a preferida do cliente marcada. */
const searchByVector = (vector: number[], limit: number, clientId?: string | null) =>
  GALLERY.map((photo, index) => ({
    ...photo,
    distance: Math.abs(vector[0] - index / 12) / 2 + Math.abs(vector[1] - (index % 5) / 5) / 4,
    isClientPreferred: !!clientId && index === 3,
  }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);

export type EmbedTextsMock = jest.Mock<Promise<(number[] | null)[]>, [string[], object?]>;

/** O casamento por nome sobre o embedding fixo; `embedText` e `embedTexts` dão o mesmo vetor para o mesmo texto. */
export function buildBatchService() {
  const embedText = jest.fn(async (text: string) => vectorOf(text));
  const embedTexts: EmbedTextsMock = jest.fn(async (texts: string[]) => texts.map(vectorOf));
  const searchByMetadataEmbedding = jest.fn(
    async (vector: number[], limit: number, options?: { clientId?: string | null }) =>
      searchByVector(vector, limit, options?.clientId),
  );
  const parseNames = jest.fn(async (inputs: Array<{ name: string }>, _options?: object) =>
    inputs.map((input) => metadataOf(input.name)),
  );
  const service = new ProductImageMatchV2Service(
    { embedText, embedTexts, searchByMetadataEmbedding } as never,
    { parseNames, parseSingle: jest.fn() } as never,
    { pathSimilarity: (a: number, b: number) => (a === b ? 1 : 0.4) } as never,
    { get: jest.fn().mockReturnValue('0') } as never,
  );
  return { service, embedText, embedTexts, searchByMetadataEmbedding, parseNames };
}

/** O que a igualdade compara: o resultado inteiro e a impressão digital das candidatas pontuadas de cada produto. */
export function snapshotOf(matched: { result: unknown; candidates: Map<string, unknown> }): {
  result: unknown;
  candidatesDigest: string;
} {
  const digest = createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(matched.candidates)))
    .digest('hex');
  return { result: matched.result, candidatesDigest: digest };
}

/**
 * O casamento por nome sobre o `GalleryEmbeddingService` real (divide a cada 96 textos), com o cliente de embeddings da
 * OpenAI simulado: `create` conta as chamadas e os textos de cada uma. A busca por similaridade é a do `searchByVector`.
 */
export function buildRealEmbeddingService() {
  const { embedding, create, logs } = fakeEmbeddingService({
    create: jest.fn(async (body: { input: string[] }) => ({
      data: body.input.map((text) => ({ embedding: vectorOf(text) })),
    })),
  });
  const search = jest.fn(async (vector: number[], limit: number) => searchByVector(vector, limit));
  embedding.searchByMetadataEmbedding = search as never;
  const parseNames = jest.fn(async (inputs: Array<{ name: string }>, _options?: object) =>
    inputs.map((input) => metadataOf(input.name)),
  );
  const service = new ProductImageMatchV2Service(
    embedding,
    { parseNames, parseSingle: jest.fn() } as never,
    { pathSimilarity: (a: number, b: number) => (a === b ? 1 : 0.4) } as never,
    { get: jest.fn().mockReturnValue('0') } as never,
  );
  return { service, embedding, create, search, errorLog: logs.error };
}
