// O controller puxa (via resolução por EAN) o importador de fotos, que importa `sharp` (não carrega no host).
jest.mock('sharp', () => jest.fn());
jest.mock('./utils/fetch-with-timeout.util', () => ({ fetchWithTimeout: jest.fn() }));

import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import {
  buildApp,
  createUploadDir,
  PRODUCT_ID,
  removeUploadDir,
} from './ai-product-models.contract.testutil';

beforeAll(createUploadDir);
afterAll(removeUploadDir);

const body = (res: request.Response) => res.body as Record<string, unknown>;

describe('contrato das rotas das cinco features: autenticação', () => {
  let app: INestApplication;
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    ctx = await buildApp();
    app = ctx.app;
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  const routes: Array<[string, 'get' | 'post' | 'put' | 'patch', string, object | undefined]> = [
    [
      'spell-check',
      'post',
      '/v1/ai/spell-check',
      { products: [{ id: PRODUCT_ID, name: 'Arroz' }] },
    ],
    [
      'product-categorization',
      'post',
      '/v1/ai/product-categorization',
      { products: [{ id: 'p1', name: 'Arroz' }] },
    ],
    [
      'product-image-match-v2',
      'post',
      '/v1/ai/product-image-match-v2',
      { products: [{ id: 'p1', name: 'Arroz' }] },
    ],
    [
      'product-image-candidates-v2',
      'post',
      '/v1/ai/product-image-candidates-v2',
      { productName: 'Arroz' },
    ],
    ['image-search', 'get', '/v1/ai/image-search?rawName=salsinha', undefined],
    ['gallery/upload', 'post', '/v1/gallery/upload', undefined],
    [
      'image-download',
      'post',
      '/v1/ai/image-download',
      { imageUrl: 'https://pixabay.com/arroz.png', productName: 'Arroz' },
    ],
    [
      'gallery/images/:imageId/product-link',
      'put',
      `/v1/gallery/images/${PRODUCT_ID}/product-link`,
      { productName: 'ARROZ SOLITO 1KG' },
    ],
    ['gallery/:id (renomear)', 'patch', '/v1/gallery/img-1', { filename: 'arroz.jpg' }],
  ];

  it.each(routes)(
    '%s sem token responde 401 UNAUTHORIZED e não chama a OpenAI',
    async (_name, method, url, payload) => {
      const req = request(app.getHttpServer())[method](url);
      const res = payload ? await req.send(payload) : await req;
      expect(res.status).toBe(401);
      expect(body(res)).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
      Object.values(ctx.fakes).forEach((fake) => expect(fake).not.toHaveBeenCalled());
      expect(ctx.dataSource.manager.query).not.toHaveBeenCalled();
      expect(ctx.uploads.uploadFile).not.toHaveBeenCalled();
    },
  );

  it('com a ortografia desligada pela flag, sem token continua 401', async () => {
    await app.close();
    ctx = await buildApp({ AI_SPELLCHECK_ENABLED: 'false' });
    app = ctx.app;
    const res = await request(app.getHttpServer())
      .post('/v1/ai/spell-check')
      .send({ products: [{ id: PRODUCT_ID, name: 'Arroz' }] });
    expect(res.status).toBe(401);
    expect(body(res)).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });
});
