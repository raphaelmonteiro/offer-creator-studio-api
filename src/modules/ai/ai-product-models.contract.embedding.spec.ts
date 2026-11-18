// O controller puxa (via resolução por EAN) o importador de fotos, que importa `sharp` (não carrega no host).
jest.mock('sharp', () => jest.fn());
jest.mock('./utils/fetch-with-timeout.util', () => ({ fetchWithTimeout: jest.fn() }));

import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import {
  bearer,
  buildApp,
  createUploadDir,
  removeUploadDir,
} from './ai-product-models.contract.testutil';
import { fakeEmbeddingService } from './gallery-embedding.testutil';
import { chatResponse, openAiError } from './utils/openai-chat.testutil';

beforeAll(createUploadDir);
afterAll(removeUploadDir);

const EMPTY_MATCH = {
  matches: [],
  reviewCandidates: [],
  alternatives: [],
  pending: [],
  eanStatus: [],
  aliasStatus: [],
};

/**
 * Teste de contrato de `POST /v1/ai/product-image-match-v2` para o embedding em lote da change 29 (PP-18): o pedido, a
 * resposta, o status e a autenticação são os de antes; o que muda é só a quantidade de chamadas de embedding.
 */
describe('contrato da busca de fotos com o embedding em lote', () => {
  let app: INestApplication;
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    ctx = await buildApp();
    app = ctx.app;
    ctx.fakes.parser.mockResolvedValue(chatResponse({ content: '{"results":[]}' }));
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  const products = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ id: `p-${index}`, name: `PRODUTO ${index}` }));
  const post = (count: number) =>
    request(app.getHttpServer())
      .post('/v1/ai/product-image-match-v2')
      .set('Authorization', bearer())
      .send({ products: products(count) });

  it('mesmo corpo de resposta, 200, e uma chamada de embedding para os produtos todos', async () => {
    const res = await post(3);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      success: true,
      data: { ...EMPTY_MATCH, scanned: 3, matched: 0 },
    });
    expect(ctx.embedding.embedTexts).toHaveBeenCalledTimes(1);
    expect(ctx.embedding.embedTexts.mock.calls[0][0]).toHaveLength(3);
    expect(ctx.embedding.embedText).not.toHaveBeenCalled();
  });

  it('segunda de três chamadas de embedding responde 503: HTTP 200 com o corpo de hoje, e só os produtos 97 a 192 ficam sem foto pelo nome', async () => {
    const answers = async (input: { input: string[] }) => ({
      data: input.input.map(() => ({ embedding: [0.1, 0.2] })),
    });
    const create = jest
      .fn()
      .mockImplementationOnce(answers)
      .mockRejectedValueOnce(openAiError(503))
      .mockImplementationOnce(answers);
    const { embedding: real, logs } = fakeEmbeddingService({ create });
    ctx.embedding.embedTexts.mockImplementation((texts: string[], options?: { strict?: boolean }) =>
      real.embedTexts(texts, options),
    );

    const res = await post(200);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      success: true,
      data: { ...EMPTY_MATCH, scanned: 200, matched: 0 },
    });
    expect(create.mock.calls.map(([input]) => input.input.length)).toEqual([96, 96, 8]);
    // a busca por similaridade só roda para quem recebeu o vetor: 96 da primeira chamada e 8 da terceira
    expect(ctx.embedding.searchByMetadataEmbedding).toHaveBeenCalledTimes(104);
    expect(logs.lines().some((line) => line.includes('Falha ao gerar embeddings'))).toBe(true);
  });

  it('sem token: 401 UNAUTHORIZED e nenhuma chamada de embedding', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/ai/product-image-match-v2')
      .send({ products: products(2) });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    expect(ctx.embedding.embedTexts).not.toHaveBeenCalled();
    expect(ctx.embedding.embedText).not.toHaveBeenCalled();
  });
});
