// O controller puxa (via resolução por EAN) o importador de fotos, que importa `sharp` (não carrega no host).
jest.mock('sharp', () => jest.fn());
jest.mock('./utils/fetch-with-timeout.util', () => ({ fetchWithTimeout: jest.fn() }));

import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import {
  bearer,
  body,
  buildApp,
  createUploadDir,
  removeUploadDir,
  USAGE,
} from './ai-product-models.contract.testutil';
import {
  BAD_EAN,
  BEER_EAN,
  FakePhoto,
  fakeGalleryQuery,
  PICCIN,
} from './ean/dotcompany/flyer-ean-resolution.candidates.testutil';
import { chatResponse } from './utils/openai-chat.testutil';

beforeAll(createUploadDir);
afterAll(removeUploadDir);

const ABACATE_PHOTO = '141da073-e2ab-4c8e-bb79-28e24074f743';
const POOL_PHOTO = '1798958c-04fc-4014-9921-a90755c9bdf3';
const SECOND_POOL_PHOTO = '3f6a9b2e-0d81-4c57-9e13-7a4b8c1d5f60';
const BEER_PHOTO = '5b0e2c9d-7a14-4f38-8d61-3c9a1e7f2b40';
const GALLERY: FakePhoto[] = [
  {
    id: ABACATE_PHOTO,
    aliases: [{ name: 'ABACATE', chosenAt: '2026-11-09T10:00:00Z' }],
    preferredBy: [PICCIN],
  },
  { id: BEER_PHOTO, ean: BEER_EAN },
];

/** Uma linha da busca por embedding com vetor fixo: o que a Galeria devolve ao casamento por nome. */
const poolRow = (id: string, distance: number) => ({
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

const nameReading = () =>
  chatResponse({
    content: JSON.stringify({ results: [{ title: 'ABACATE', fieldConfidence: { title: 0.9 } }] }),
    usage: USAGE,
  });

describe('POST /v1/ai/product-image-candidates-v2 com o campo ean (provedor simulado)', () => {
  let app: INestApplication;
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  const candidates = (payload: object, authorization: string | null = bearer()) => {
    const call = request(app.getHttpServer()).post('/v1/ai/product-image-candidates-v2');
    return (authorization ? call.set('Authorization', authorization) : call).send(payload);
  };
  const listOf = (res: request.Response) =>
    (body(res).data as { candidates: Array<{ imageId: string; reasons: string[] }> }).candidates;
  const idsOf = (res: request.Response) => listOf(res).map((candidate) => candidate.imageId);

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    ctx = await buildApp();
    app = ctx.app;
    ctx.dataSource.query.mockImplementation(fakeGalleryQuery(GALLERY) as never);
    ctx.fakes.parser.mockResolvedValue(nameReading());
    ctx.embedding.searchByMetadataEmbedding.mockResolvedValue([poolRow(POOL_PHOTO, 0.1)]);
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('regressão: sem o campo ean a resposta é a de antes, com a busca por nome e vetores fixos', async () => {
    ctx.embedding.searchByMetadataEmbedding.mockResolvedValue([
      poolRow(SECOND_POOL_PHOTO, 0.4),
      poolRow(POOL_PHOTO, 0.1),
    ]);

    const res = await candidates({
      productName: 'ABACATE',
      category: 'Hortifruti',
      unit: 'kg',
      limit: 12,
    });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      success: true,
      data: {
        candidates: [
          {
            imageId: POOL_PHOTO,
            url: `http://localhost:3101/uploads/gallery/${POOL_PHOTO}.png`,
            thumbnailUrl: null,
            filename: `${POOL_PHOTO}.png`,
            folderName: null,
            score: 0.1602,
            reasons: ['texto muito similar'],
            isClientPreferred: false,
          },
          {
            imageId: SECOND_POOL_PHOTO,
            url: `http://localhost:3101/uploads/gallery/${SECOND_POOL_PHOTO}.png`,
            thumbnailUrl: null,
            filename: `${SECOND_POOL_PHOTO}.png`,
            folderName: null,
            score: 0.1068,
            reasons: [],
            isClientPreferred: false,
          },
        ],
      },
    });
  });

  it('ean ausente, null e "": só null e "" fixam a foto do nome escolhido, sem 400 nem 500', async () => {
    const absent = await candidates({ productName: 'ABACATE', clientId: PICCIN });
    const nulled = await candidates({ productName: 'ABACATE', ean: null, clientId: PICCIN });
    const empty = await candidates({ productName: 'ABACATE', ean: '', clientId: PICCIN });

    expect(idsOf(absent)).toEqual([POOL_PHOTO]);
    for (const res of [nulled, empty]) {
      expect(res.status).toBe(200);
      expect(idsOf(res)).toEqual([ABACATE_PHOTO, POOL_PHOTO]);
      expect(listOf(res)[0].reasons).toContain('nome escolhido antes');
    }
  });

  it('com o EAN válido, a foto do EAN vem primeiro com "EAN igual"; com o dígito errado, nenhuma', async () => {
    const valid = await candidates({ productName: 'ABACATE', ean: BEER_EAN });
    const wrong = await candidates({ productName: 'ABACATE', ean: BAD_EAN });

    expect(idsOf(valid)).toEqual([BEER_PHOTO, ABACATE_PHOTO, POOL_PHOTO]);
    expect(listOf(valid)[0].reasons).toEqual(['EAN igual']);
    expect(idsOf(wrong)).toEqual([ABACATE_PHOTO, POOL_PHOTO]);
    expect(listOf(wrong).flatMap((candidate) => candidate.reasons)).not.toContain('EAN igual');
  });

  it('com e sem ean a rota faz o mesmo número de leituras de nome e de embeddings, e nunca consulta a DotCompany', async () => {
    // Nomes diferentes: a leitura de nome guarda o resultado por nome, e a segunda chamada do mesmo não a repetiria.
    await candidates({ productName: 'ARROZ CAMIL 5KG' });
    const without = [ctx.fakes.parser.mock.calls.length, ctx.embedding.embedText.mock.calls.length];
    ctx.fakes.parser.mockClear();
    ctx.embedding.embedText.mockClear();

    const res = await candidates({ productName: 'ABACATE', ean: BEER_EAN });

    expect(res.status).toBe(200);
    expect([ctx.fakes.parser.mock.calls.length, ctx.embedding.embedText.mock.calls.length]).toEqual(
      without,
    );
    expect(without).toEqual([1, 1]);
  });

  it('sem token responde 401 UNAUTHORIZED, mesmo com ean', async () => {
    const res = await candidates({ productName: 'ABACATE', ean: BEER_EAN }, null);

    expect(res.status).toBe(401);
    expect(body(res)).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
  });

  it('erro inesperado com ean continua HTTP 200 com PRODUCT_IMAGE_CANDIDATES_V2_ERROR', async () => {
    ctx.dataSource.query.mockRejectedValue(new Error('banco fora do ar'));

    const res = await candidates({ productName: 'ABACATE', ean: BEER_EAN });

    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({
      success: false,
      error: { code: 'PRODUCT_IMAGE_CANDIDATES_V2_ERROR' },
    });
  });
});
