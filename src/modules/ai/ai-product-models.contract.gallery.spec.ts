import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import {
  bearer,
  body,
  buildApp,
  createUploadDir,
  PRODUCT_ID,
  removeUploadDir,
  servePhoto,
  until,
  USAGE,
} from './ai-product-models.contract.testutil';
import { pngOf } from '../../shared/image/image-fixtures.testutil';
import { pixabayFetch, pixabayFile, pixabayMissing } from './pixabay.testutil';
import { chatResponse } from './utils/openai-chat.testutil';

beforeAll(createUploadDir);
afterAll(removeUploadDir);

const visionReply = () =>
  chatResponse({
    content: JSON.stringify({ title: 'ARROZ', fieldConfidence: { title: 0.9 } }),
    usage: USAGE,
  });

/**
 * Contrato das rotas dos dois editores que passam pela regravação dos dados da foto (change
 * 02-fix-gallery-alias-loss, requisito "As rotas dos dois editores mantêm o contrato"): o corpo é o de hoje e a leitura
 * por visão, simulada, segue sem segurar a resposta. O envio (`POST /v1/gallery/upload`) está em
 * `ai-product-models.contract.spec.ts` e o 401 das rotas em `ai-product-models.contract.auth.spec.ts`.
 */
describe('contrato das rotas que regravam os dados da foto (provedor simulado)', () => {
  let app: INestApplication;
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let connection: ReturnType<typeof pixabayFetch>;
  let png: Buffer;

  beforeAll(async () => {
    png = await pngOf(8, 8);
  });

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    ctx = await buildApp();
    app = ctx.app;
    connection = servePhoto(ctx, () => pixabayFile(png));
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  describe('POST /v1/ai/image-download', () => {
    const download = () =>
      request(app.getHttpServer())
        .post('/v1/ai/image-download')
        .set('Authorization', bearer())
        .send({ imageUrl: 'https://pixabay.com/arroz.png', productName: 'Arroz Camil 5kg' });

    it('responde success true com a imagem salva, sem esperar a leitura da foto', async () => {
      let release!: (value: unknown) => void;
      ctx.fakes.vision.mockReturnValue(new Promise((resolve) => (release = resolve)));

      const res = await download();

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({
        success: true,
        data: { imageUrl: 'http://localhost:3001/uploads/gallery/arroz.jpg', imageId: 'img-1' },
      });
      await until(() => ctx.fakes.vision.mock.calls.length === 1);
      expect(ctx.embedding.saveImageMetadata).not.toHaveBeenCalled();
      release(visionReply());
      await until(() => ctx.embedding.saveImageMetadata.mock.calls.length === 1);
    });

    it('a falha do download continua HTTP 200 com success false, sem imageId e sem linha nova', async () => {
      connection = servePhoto(ctx, () => pixabayMissing(404));

      const res = await download();

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({
        success: false,
        error: {
          code: 'IMAGE_DOWNLOAD_ERROR',
          message: 'Não foi possível salvar a imagem. Tente novamente.',
        },
      });
      expect(ctx.uploads.uploadFile).not.toHaveBeenCalled();
      expect(ctx.fakes.vision).not.toHaveBeenCalled();
    });

    it('arquivo de 12 MB: HTTP 200 com IMAGE_DOWNLOAD_ERROR, sem imageId e sem gravar nada', async () => {
      const twelveMb = 12 * 1024 * 1024;
      connection = servePhoto(ctx, () =>
        pixabayFile(Buffer.alloc(twelveMb), { contentLength: twelveMb }),
      );

      const res = await download();

      expect(res.status).toBe(200);
      expect(body(res)).toMatchObject({ success: false, error: { code: 'IMAGE_DOWNLOAD_ERROR' } });
      expect(body(res)).not.toHaveProperty('data');
      expect(ctx.uploads.uploadFile).not.toHaveBeenCalled();
    });

    it('registro na Galeria que falha: HTTP 200 com IMAGE_DOWNLOAD_ERROR e o arquivo gravado é apagado', async () => {
      jest.spyOn(ctx.gallery, 'registerImage').mockRejectedValue(new Error('banco fora do ar'));

      const res = await download();

      expect(res.status).toBe(200);
      expect(body(res)).toMatchObject({ success: false, error: { code: 'IMAGE_DOWNLOAD_ERROR' } });
      expect(body(res)).not.toHaveProperty('data');
      expect(ctx.uploads.uploadFile).toHaveBeenCalledTimes(1);
      expect(ctx.uploads.deleteFile).toHaveBeenCalledWith('products/arroz-uuid.jpg');
    });

    it('imageUrl que não é URL dá 400 BAD_REQUEST, sem baixar nada', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/ai/image-download')
        .set('Authorization', bearer())
        .send({ imageUrl: 'abc', productName: 'SALSINHA MAÇO' });

      expect(res.status).toBe(400);
      expect(body(res)).toMatchObject({ success: false, error: { code: 'BAD_REQUEST' } });
      expect(connection.request).not.toHaveBeenCalled();
    });
  });

  describe('PUT /v1/gallery/images/:imageId/product-link', () => {
    const link = (payload: object) =>
      request(app.getHttpServer())
        .put(`/v1/gallery/images/${PRODUCT_ID}/product-link`)
        .set('Authorization', bearer())
        .send(payload);

    function savedMetadata(): { aliases: Array<{ name: string; key: string }> } {
      const update = ctx.dataSource.manager.query.mock.calls.find(([sql]) =>
        String(sql).includes('UPDATE gallery_images'),
      );
      return JSON.parse(update[1][0]);
    }

    it('com EAN de dígito inválido responde 200 com ean.status invalid e grava o nome', async () => {
      const res = await link({ productName: 'ARROZ SOLITO 1KG', ean: '7891000100100' });

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({
        success: true,
        data: {
          imageId: PRODUCT_ID,
          alias: { key: 'ARROZ SOLITO 1KG', added: true },
          ean: { ean: '7891000100100', status: 'invalid' },
          client: null,
        },
      });
      expect(savedMetadata().aliases).toMatchObject([
        { name: 'ARROZ SOLITO 1KG', key: 'ARROZ SOLITO 1KG' },
      ]);
    });

    it('sem EAN responde a mesma forma, com ean null, e grava o nome', async () => {
      const res = await link({ productName: 'ARROZ SOLITO 1KG' });

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({
        success: true,
        data: {
          imageId: PRODUCT_ID,
          alias: { key: 'ARROZ SOLITO 1KG', added: true },
          ean: null,
          client: null,
        },
      });
      expect(savedMetadata().aliases).toHaveLength(1);
    });
  });

  describe('PATCH /v1/gallery/:id (renomear)', () => {
    it('responde a foto atualizada e a leitura roda depois, sem segurar a resposta', async () => {
      let release!: (value: unknown) => void;
      ctx.fakes.vision.mockReturnValue(new Promise((resolve) => (release = resolve)));

      const res = await request(app.getHttpServer())
        .patch('/v1/gallery/img-1')
        .set('Authorization', bearer())
        .send({ filename: 'arroz camil 5kg' });

      expect(res.status).toBe(200);
      expect(body(res)).toMatchObject({
        success: true,
        data: { id: 'img-1', filename: 'arroz camil 5kg.jpg' },
      });
      await until(() => ctx.fakes.vision.mock.calls.length === 1);
      expect(ctx.embedding.saveImageMetadata).not.toHaveBeenCalled();
      release(visionReply());
      await until(() => ctx.embedding.saveImageMetadata.mock.calls.length === 1);
    });
  });
});
