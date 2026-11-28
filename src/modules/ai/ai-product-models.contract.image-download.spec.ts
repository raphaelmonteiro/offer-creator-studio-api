import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { pngOf, textBytes } from '../../shared/image/image-fixtures.testutil';
import {
  bearer,
  body,
  buildApp,
  createUploadDir,
  removeUploadDir,
  servePhoto,
} from './ai-product-models.contract.testutil';
import { PIXABAY_PHOTO_URL, pixabayFile } from './pixabay.testutil';
import { connectionReply, redirectTo } from '../../shared/http/pinned-fetch.testutil';

beforeAll(createUploadDir);
afterAll(removeUploadDir);

const REFUSED = { success: false, error: { code: 'IMAGE_DOWNLOAD_ERROR' } };

/**
 * `POST /v1/ai/image-download` só baixa de `pixabay.com` e `cdn.pixabay.com`, por https na porta 443, no primeiro endereço
 * e em cada salto (change 47, D-11, requisito "Download do Pixabay só de endereço do Pixabay"); a recusa é HTTP 200 com
 * `IMAGE_DOWNLOAD_ERROR`, sem conexão ao endereço recusado e sem gravar nada.
 */
describe('POST /v1/ai/image-download: só endereço do Pixabay (conexão simulada)', () => {
  let app: INestApplication;
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let png: Buffer;

  beforeAll(async () => {
    png = await pngOf(8, 8);
  });
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    ctx = await buildApp();
    app = ctx.app;
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  const download = (imageUrl: string) =>
    request(app.getHttpServer())
      .post('/v1/ai/image-download')
      .set('Authorization', bearer())
      .send({ imageUrl, productName: 'Arroz Camil 5kg' });

  const hostsConnected = (connection: ReturnType<typeof servePhoto>) =>
    connection.request.mock.calls.map(([options]) => options.url.host);

  const expectRefused = (res: request.Response) => {
    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject(REFUSED);
    expect(body(res)).not.toHaveProperty('data');
    expect(ctx.uploads.uploadFile).not.toHaveBeenCalled();
  };

  it('Foto do Pixabay nas duas telas: o fullUrl do site e a do CDN voltam com { imageUrl, imageId }', async () => {
    servePhoto(ctx, () => pixabayFile(png, { contentType: 'image/png' }));

    for (const url of [PIXABAY_PHOTO_URL, 'https://cdn.pixabay.com/photo/2020/abacate_150.jpg']) {
      const res = await download(url);

      expect(res.status).toBe(200);
      expect(body(res)).toMatchObject({
        success: true,
        data: { imageUrl: expect.any(String), imageId: 'img-1' },
      });
    }
  });

  it.each([
    'https://exemplo.com/x.jpg',
    'https://pixabay.com.exemplo.com/x.jpg',
    'http://pixabay.com/get/x.jpg',
    'https://pixabay.com:8443/get/g1a2b3c4d5e6f_1280.jpg',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:3001/v1/health',
    'pixabay.com/get/g1a2b3c4d5e6f_1280.jpg',
    'abc',
  ])('%s: HTTP 200 com IMAGE_DOWNLOAD_ERROR, sem nenhuma conexão', async (url) => {
    const connection = servePhoto(ctx, () => pixabayFile(png));

    expectRefused(await download(url));

    expect(connection.request).not.toHaveBeenCalled();
  });

  it.each([
    ['https://exemplo.com/x.jpg', 'exemplo.com'],
    ['https://cdn.pixabay.com:8080/x.jpg', 'cdn.pixabay.com:8080'],
    ['http://169.254.169.254/latest/meta-data/', '169.254.169.254'],
  ])('Salto para %s: recusado, e nenhuma conexão sai para ele', async (location, host) => {
    const connection = servePhoto(ctx, () => redirectTo(location));

    expectRefused(await download(PIXABAY_PHOTO_URL));

    expect(hostsConnected(connection)).toEqual(['pixabay.com']);
    expect(hostsConnected(connection)).not.toContain(host);
  });

  it('Página no lugar da foto: HTML com content-type image/jpeg não grava nada', async () => {
    servePhoto(ctx, () =>
      connectionReply(textBytes('<html>acesso negado</html>'), 200, {
        'content-type': 'image/jpeg',
      }),
    );

    expectRefused(await download(PIXABAY_PHOTO_URL));
  });
});
