import { FlyerEanResolutionService } from '../../ai/ean/dotcompany/flyer-ean-resolution.service';
import { GalleryEmbeddingService } from '../../ai/gallery-embedding.service';
import { ProductImageMatchV2Service } from '../../ai/metadata/product-image-match-v2.service';
import { ProductMetadata } from '../../ai/metadata/product-metadata.schema';
import { ProductNameParserService } from '../../ai/metadata/product-name-parser.service';
import { TaxonomyService } from '../../ai/metadata/taxonomy/taxonomy.service';
import {
  chatResponse,
  fakeConfig,
  installFakeOpenAi,
  spyOnLogger,
} from '../../ai/utils/openai-chat.testutil';
import { productAliasKey } from '../../gallery/product-alias';
import { EnrichImagePhase } from './enrich-image-phase';

/**
 * O mundo da fase de fotos com os serviços reais (a busca de fotos do encarte, o casamento por nome, a leitura do nome e o
 * embedding) sobre clientes simulados da OpenAI e um banco que só responde as três consultas da Galeria (por EAN, por
 * nome já escolhido e a busca por similaridade): nenhuma chamada paga e nenhuma escrita na Galeria.
 */

export const EAN = '7896000000019';

export interface GalleryEanRow {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  filename: string;
  ean: string;
  source: string | null;
  preferred: boolean;
}

export const eanRow = (id: string, ean = EAN, source = 'manual'): GalleryEanRow => ({
  id,
  url: `http://cdn.teste/uploads/gallery/${id}.png`,
  thumbnailUrl: null,
  filename: `${id}.png`,
  ean,
  source,
  preferred: false,
});

/** A ficha do produto como a leitura do nome a devolve; a foto da Galeria com a mesma ficha pontua como "nome igual". */
const metadataOf = (name: string, brand: string): ProductMetadata => ({
  title: name,
  category: { id: 10, path: ['Mercearia', 'Bebidas'] },
  quantity: { value: 350, unit: 'ml' },
  packageType: 'lata',
  pack: null,
  alternatives: [{ brand, subBrand: null, variant: null }],
  ean: null,
  sku: null,
  claims: [],
  promo: null,
  dominantColors: [],
  fieldConfidence: { title: 0.9 },
  source: 'name-parse',
  modelVersion: 'teste',
  warnings: [],
});

export interface ImageWorldOptions {
  env?: Record<string, string>;
  /** Fotos da Galeria por EAN (a consulta `metadata->>'ean'`). */
  byEan?: GalleryEanRow[];
  /** Fotos já escolhidas antes para um nome da planilha (`metadata.aliases`). */
  byAlias?: Array<{ name: string; photoId: string }>;
  /** Nomes de produto para os quais a busca por similaridade devolve uma foto: `strong` casa, `weak` vira candidata. */
  nameMatches?: Array<{ name: string; photoId: string; strength: 'strong' | 'weak' }>;
}

export function buildImageWorld(options: ImageWorldOptions = {}) {
  const config = fakeConfig({
    OPENAI_API_KEY: 'sk-teste',
    EAN_FLYER_RESOLVE_ENABLED: 'false',
    ...options.env,
  });
  const queries: string[] = [];
  const query = jest.fn(async (sql: string) => {
    queries.push(sql);
    if (sql.includes("metadata->>'ean'")) return options.byEan ?? [];
    if (sql.includes("metadata->'aliases'")) return aliasRows(options.byAlias ?? []);
    return [];
  });
  const embedding = new GalleryEmbeddingService(config, { query } as never);
  const embeddingsCreate = jest.fn(async (body: { input: string[] }) => ({
    data: body.input.map(() => ({ embedding: [0.1, 0.2] })),
  }));
  (embedding as unknown as { openai: unknown }).openai =
    options.env?.OPENAI_API_KEY === '' ? null : { embeddings: { create: embeddingsCreate } };
  embedding.searchByMetadataEmbedding = jest.fn(async () =>
    photoRows(options.nameMatches ?? []),
  ) as never;
  spyOnLogger(embedding);
  const parser = new ProductNameParserService(config, {
    promptList: () => '10|Mercearia > Bebidas',
  } as unknown as TaxonomyService);
  const chatCreate = options.env?.OPENAI_API_KEY === '' ? jest.fn() : installFakeOpenAi(parser);
  chatCreate.mockImplementation(async (body: { messages: Array<{ content: string }> }) => {
    const names = [...body.messages[1].content.matchAll(/^\d+\. "([^"]*)"/gm)].map((m) => m[1]);
    return chatResponse({
      content: JSON.stringify({
        results: names.map((name) => ({
          title: name,
          category: { id: 10, path: ['Mercearia', 'Bebidas'] },
          quantity: { value: 350, unit: 'ml' },
          alternatives: [{ brand: brandOf(name), subBrand: null, variant: null }],
          fieldConfidence: { title: 0.9 },
        })),
      }),
    });
  });
  spyOnLogger(parser);
  const matcher = new ProductImageMatchV2Service(
    embedding,
    parser,
    { pathSimilarity: (a: number, b: number) => (a === b ? 1 : 0) } as never,
    config,
  );
  const lookups = { resolve: jest.fn() };
  const images = new FlyerEanResolutionService(
    { query } as never,
    matcher,
    lookups as never,
    {} as never,
    { criarJobDoEncarte: jest.fn() } as never,
    { wake: jest.fn() } as never,
    config,
  );
  const sizes = { measure: jest.fn(async () => ({ width: 800, height: 640 })) };
  const phase = new EnrichImagePhase(images, embedding, sizes);
  const writes = () => queries.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql));
  return { phase, images, embedding, sizes, query, chatCreate, embeddingsCreate, lookups, writes };
}

/** A marca da ficha do produto: a primeira palavra do nome; a foto fraca usa outra marca, então a nota cai para a revisão. */
const brandOf = (name: string): string => name.split(' ')[0];

function aliasRows(aliases: Array<{ name: string; photoId: string }>) {
  return aliases.map(({ name, photoId }) => ({
    id: photoId,
    url: `http://cdn.teste/uploads/gallery/${photoId}.png`,
    thumbnailUrl: null,
    filename: `${photoId}.png`,
    key: productAliasKey(name),
    chosenAt: '2026-11-01T10:00:00.000Z',
    preferred: false,
  }));
}

function photoRows(matches: NonNullable<ImageWorldOptions['nameMatches']>) {
  return matches.map(({ name, photoId, strength }) => ({
    id: photoId,
    filename: `${photoId}.png`,
    url: `http://cdn.teste/uploads/gallery/${photoId}.png`,
    thumbnailUrl: `http://cdn.teste/uploads/thumbnails/${photoId}.png`,
    folderId: null,
    folderName: null,
    distance: 0.05,
    isClientPreferred: false,
    metadata: metadataOf(name, strength === 'strong' ? brandOf(name) : 'OUTRA'),
  }));
}
