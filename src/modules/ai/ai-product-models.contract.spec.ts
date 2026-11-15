// O controller puxa (via resolução por EAN) o importador de fotos, que importa `sharp` (não carrega no host).
jest.mock('sharp', () => jest.fn());
jest.mock('./utils/fetch-with-timeout.util', () => ({ fetchWithTimeout: jest.fn() }));

import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import {
  bearer,
  buildApp,
  createUploadDir,
  PRODUCT_ID,
  removeUploadDir,
  until,
  USAGE,
} from './ai-product-models.contract.testutil';
import { fetchWithTimeout } from './utils/fetch-with-timeout.util';
import { chatResponse, openAiError } from './utils/openai-chat.testutil';

beforeAll(createUploadDir);
afterAll(removeUploadDir);

const body = (res: request.Response) => res.body as Record<string, unknown>;

describe('contrato das rotas das cinco features (provedor simulado)', () => {
  let app: INestApplication;
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    (fetchWithTimeout as jest.Mock).mockReset().mockResolvedValue({
      ok: true,
      json: async () => ({
        hits: [
          {
            id: 7,
            previewURL: 'p',
            webformatURL: 'w',
            largeImageURL: 'l',
            webformatWidth: 1,
            webformatHeight: 2,
          },
        ],
      }),
    });
    ctx = await buildApp();
    app = ctx.app;
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  describe('forma da resposta, sem usage, model nem costUsd', () => {
    it('POST /v1/ai/spell-check', async () => {
      const correction = {
        productId: PRODUCT_ID,
        field: 'name',
        original: 'Arroz Camil 5k',
        suggestion: 'Arroz Camil 5 kg',
      };
      ctx.fakes.spell.mockResolvedValue(
        chatResponse({ content: JSON.stringify({ corrections: [correction] }), usage: USAGE }),
      );

      const res = await request(app.getHttpServer())
        .post('/v1/ai/spell-check')
        .set('Authorization', bearer())
        .send({ products: [{ id: PRODUCT_ID, name: 'Arroz Camil 5k' }] });

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({ success: true, data: { corrections: [correction] } });
      expect(JSON.stringify(res.body)).not.toMatch(/usage|costUsd|gpt-6|"model"/);
    });

    it('POST /v1/ai/product-categorization', async () => {
      ctx.fakes.categorization.mockResolvedValue(
        chatResponse({
          content: JSON.stringify({
            assignments: [
              {
                productId: 'p1',
                category: 'Mercearia',
                confidence: 0.9,
                source: 'ai',
                reason: 'arroz',
              },
            ],
          }),
          usage: USAGE,
        }),
      );

      const res = await request(app.getHttpServer())
        .post('/v1/ai/product-categorization')
        .set('Authorization', bearer())
        .send({ products: [{ id: 'p1', name: 'Arroz Camil 5kg' }] });

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({
        success: true,
        data: {
          assignments: [
            {
              productId: 'p1',
              category: 'Mercearia',
              confidence: 0.9,
              source: 'ai',
              reason: 'arroz',
            },
          ],
          summary: { total: 1, categorized: 1, uncertain: 0 },
        },
      });
      expect(JSON.stringify(res.body)).not.toMatch(/usage|costUsd|gpt-6/);
    });

    it('POST /v1/ai/product-image-match-v2 (leitura do nome pelo modelo novo, sem usage na resposta)', async () => {
      ctx.fakes.parser.mockResolvedValue(
        chatResponse({
          content: JSON.stringify({
            results: [{ title: 'ARROZ CAMIL 5KG', fieldConfidence: { title: 0.9 } }],
          }),
          usage: USAGE,
        }),
      );

      const res = await request(app.getHttpServer())
        .post('/v1/ai/product-image-match-v2')
        .set('Authorization', bearer())
        .send({ products: [{ id: 'p1', name: 'ARROZ CAMIL 5KG' }] });

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({
        success: true,
        data: {
          matches: [],
          reviewCandidates: [],
          scanned: 1,
          matched: 0,
          alternatives: [],
          pending: [],
          eanStatus: [],
          aliasStatus: [],
        },
      });
      expect(ctx.fakes.parser.mock.calls[0][0].model).toBe('gpt-6-luna');
    });

    it('POST /v1/ai/product-image-candidates-v2', async () => {
      ctx.fakes.parser.mockResolvedValue(
        chatResponse({
          content: JSON.stringify({
            results: [{ title: 'ARROZ', fieldConfidence: { title: 0.9 } }],
          }),
          usage: USAGE,
        }),
      );

      const res = await request(app.getHttpServer())
        .post('/v1/ai/product-image-candidates-v2')
        .set('Authorization', bearer())
        .send({ productName: 'Arroz Camil 5kg' });

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({ success: true, data: { candidates: [] } });
    });

    it('GET /v1/ai/image-search', async () => {
      ctx.fakes.translate.mockResolvedValue(chatResponse({ content: 'parsley', usage: USAGE }));

      const res = await request(app.getHttpServer())
        .get('/v1/ai/image-search')
        .query({ rawName: 'salsinha' })
        .set('Authorization', bearer());

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({
        success: true,
        data: {
          searchTerm: 'salsinha',
          images: [
            { pixabayId: 7, thumbnailUrl: 'p', previewUrl: 'w', fullUrl: 'l', width: 1, height: 2 },
          ],
        },
      });
    });

    it('POST /v1/gallery/upload responde sem esperar a leitura da foto, que roda depois', async () => {
      let release!: (value: unknown) => void;
      ctx.fakes.vision.mockReturnValue(new Promise((resolve) => (release = resolve)));

      const res = await request(app.getHttpServer())
        .post('/v1/gallery/upload')
        .set('Authorization', bearer())
        .attach('files', Buffer.from('imagem-falsa'), 'arroz.jpg');

      expect(res.status).toBe(201);
      expect(body(res)).toMatchObject({
        success: true,
        data: [{ id: 'img-1', filename: 'arroz.jpg' }],
      });
      await until(() => ctx.fakes.vision.mock.calls.length === 1);
      expect(ctx.fakes.vision.mock.calls[0][0].model).toBe('gpt-6.1-terra');
      expect(ctx.embedding.saveImageMetadata).not.toHaveBeenCalled();

      release(
        chatResponse({
          content: JSON.stringify({ title: 'ARROZ', fieldConfidence: { title: 0.9 } }),
          usage: USAGE,
        }),
      );
      await until(() => ctx.embedding.saveImageMetadata.mock.calls.length === 1);
      expect(ctx.embedding.saveImageMetadata.mock.calls[0][1].modelVersion).toBe(
        'vision-v2-2026-11:gpt-6.1-terra',
      );
    });
  });

  describe('erros em HTTP 200 com success: false', () => {
    it('ortografia: erro do provedor vira AI_SERVICE_ERROR', async () => {
      ctx.fakes.spell.mockRejectedValue(openAiError(429, 'limite de taxa', 'rate_limit_exceeded'));
      const res = await request(app.getHttpServer())
        .post('/v1/ai/spell-check')
        .set('Authorization', bearer())
        .send({ products: [{ id: PRODUCT_ID, name: 'Arroz' }] });
      expect(res.status).toBe(200);
      expect(body(res)).toMatchObject({ success: false, error: { code: 'AI_SERVICE_ERROR' } });
      expect(ctx.fakes.spell).toHaveBeenCalledTimes(1);
    });

    it('ortografia desligada pela flag: o mesmo erro, sem chamar a OpenAI, também no pedido repetido', async () => {
      await app.close();
      ctx = await buildApp({ AI_SPELLCHECK_ENABLED: 'false' });
      app = ctx.app;
      const call = () =>
        request(app.getHttpServer())
          .post('/v1/ai/spell-check')
          .set('Authorization', bearer())
          .send({ products: [{ id: PRODUCT_ID, name: 'Arroz' }] });
      const first = await call();
      const second = await call();
      expect(first.status).toBe(200);
      expect(body(first)).toMatchObject({ success: false, error: { code: 'AI_SERVICE_ERROR' } });
      expect(second.body).toStrictEqual(first.body);
      expect(ctx.fakes.spell).not.toHaveBeenCalled();
    });

    it('categorização: erro 5xx do provedor vira PRODUCT_CATEGORIZATION_ERROR', async () => {
      ctx.fakes.categorization.mockRejectedValue(openAiError(503, 'indisponível'));
      const res = await request(app.getHttpServer())
        .post('/v1/ai/product-categorization')
        .set('Authorization', bearer())
        .send({ products: [{ id: 'p1', name: 'Arroz' }] });
      expect(res.status).toBe(200);
      expect(body(res)).toMatchObject({
        success: false,
        error: { code: 'PRODUCT_CATEGORIZATION_ERROR' },
      });
    });

    it('match v2 e candidatas v2: falha no casamento vira o código da rota', async () => {
      ctx.fakes.parser.mockResolvedValue(chatResponse({ content: '{"results":[]}' }));
      ctx.embedding.embedText.mockRejectedValue(new Error('falha do embedding'));
      const match = await request(app.getHttpServer())
        .post('/v1/ai/product-image-match-v2')
        .set('Authorization', bearer())
        .send({ products: [{ id: 'p1', name: 'Arroz' }] });
      const candidates = await request(app.getHttpServer())
        .post('/v1/ai/product-image-candidates-v2')
        .set('Authorization', bearer())
        .send({ productName: 'Arroz' });
      expect(match.status).toBe(200);
      expect(body(match)).toMatchObject({
        success: false,
        error: { code: 'PRODUCT_IMAGE_MATCH_V2_ERROR' },
      });
      expect(candidates.status).toBe(200);
      expect(body(candidates)).toMatchObject({
        success: false,
        error: { code: 'PRODUCT_IMAGE_CANDIDATES_V2_ERROR' },
      });
    });

    it('busca no Pixabay: a tradução que falha não derruba a rota (busca com o termo original)', async () => {
      ctx.fakes.translate.mockRejectedValue(openAiError(500, 'falha'));
      const res = await request(app.getHttpServer())
        .get('/v1/ai/image-search')
        .query({ rawName: 'salsinha' })
        .set('Authorization', bearer());
      expect(res.status).toBe(200);
      expect(body(res)).toMatchObject({ success: true, data: { searchTerm: 'salsinha' } });
      const url = String((fetchWithTimeout as jest.Mock).mock.calls[0][0]);
      expect(new URL(url).searchParams.get('q')).toBe('salsinha');
    });
  });
});
