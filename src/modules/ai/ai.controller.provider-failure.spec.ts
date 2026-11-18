// O controller puxa (via resolução por EAN) o importador de fotos, que importa `sharp` (não carrega no host).
jest.mock('sharp', () => jest.fn());
jest.mock('./utils/fetch-with-timeout.util', () => ({ fetchWithTimeout: jest.fn() }));

import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { TransientProviderError } from '../../shared/providers/provider-errors';
import {
  bearer,
  body,
  buildApp,
  createUploadDir,
  PRODUCT_ID,
  removeUploadDir,
} from './ai-product-models.contract.testutil';
import { ProductNameParserService } from './metadata/product-name-parser.service';
import { openAiError } from './utils/openai-chat.testutil';

beforeAll(createUploadDir);
afterAll(removeUploadDir);

/**
 * Não regressão (change 28, PP-18): as rotas síncronas que o `/editor-v2` e o `/social` chamam respondem numa queda do
 * provedor como antes, porque nenhuma passa a opção `strict`. O 401 sem token das três está em
 * `ai-product-models.contract.auth.spec.ts`.
 */
describe('rotas síncronas de fotos, categorias e ortografia com o provedor falhando', () => {
  let app: INestApplication;
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let parseNames: jest.SpyInstance;

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    parseNames = jest.spyOn(ProductNameParserService.prototype, 'parseNames');
    ctx = await buildApp();
    app = ctx.app;
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  const post = (url: string, payload: object) =>
    request(app.getHttpServer()).post(url).set('Authorization', bearer()).send(payload);

  /** O embedding real devolve `null` na falha quando não está em modo estrito, e lança com a opção. */
  function embeddingDown(): void {
    ctx.embedding.embedText.mockImplementation(
      async (_text: string, options?: { strict?: boolean }) => {
        if (options?.strict) throw new TransientProviderError('HTTP 503');
        return null;
      },
    );
  }

  const PHOTOS = {
    products: [
      { id: 'p-cerveja', name: 'CERVEJA PILSEN LATA 350ML' },
      { id: 'p-abacate', name: 'ABACATE KG' },
    ],
  };

  it('busca de fotos com a leitura de nomes e o embedding fora do ar: 200 sem fotos pelo nome', async () => {
    ctx.fakes.parser.mockRejectedValue(openAiError(503));
    embeddingDown();

    const res = await post('/v1/ai/product-image-match-v2', PHOTOS);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      success: true,
      data: {
        matches: [],
        reviewCandidates: [],
        scanned: 2,
        matched: 0,
        alternatives: [],
        pending: [],
        eanStatus: [],
        aliasStatus: [],
      },
    });
    for (const call of parseNames.mock.calls) expect(call[1]?.strict).toBeUndefined();
    for (const call of ctx.embedding.embedText.mock.calls) expect(call[1]?.strict).toBeUndefined();
  });

  it('o mesmo pedido de busca de fotos repetido na queda: as duas respostas são iguais', async () => {
    ctx.fakes.parser.mockRejectedValue(openAiError(503));
    embeddingDown();

    const first = await post('/v1/ai/product-image-match-v2', PHOTOS);
    const second = await post('/v1/ai/product-image-match-v2', PHOTOS);

    expect(second.status).toBe(first.status);
    expect(second.body).toStrictEqual(first.body);
  });

  it('categorização com o provedor em 500: 200 com success false e o código de hoje', async () => {
    ctx.fakes.categorization.mockRejectedValue(openAiError(500));

    const res = await post('/v1/ai/product-categorization', {
      products: [{ id: 'p1', name: 'Arroz' }],
    });

    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({
      success: false,
      error: { code: 'PRODUCT_CATEGORIZATION_ERROR' },
    });
  });

  it('ortografia com o provedor em 500: 200 com success false e o código de hoje', async () => {
    ctx.fakes.spell.mockRejectedValue(openAiError(500));

    const res = await post('/v1/ai/spell-check', { products: [{ id: PRODUCT_ID, name: 'Arroz' }] });

    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({ success: false, error: { code: 'AI_SERVICE_ERROR' } });
  });
});
