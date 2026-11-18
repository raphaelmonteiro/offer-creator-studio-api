import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as request from 'supertest';
import { binaryBody } from '../../shared/testing/binary-body.testutil';
import { useUploadsStatic } from './uploads-static.config';

/** O estático de `/uploads/` que o `main.ts` e o app de teste do e2e compartilham. */
describe('useUploadsStatic', () => {
  const bytes = Buffer.from([0, 1, 0, 0, 7, 8, 9]);
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-static-spec-'));
  let app: NestExpressApplication;

  beforeAll(async () => {
    fs.mkdirSync(path.join(uploadsDir, 'fonts'));
    fs.writeFileSync(path.join(uploadsDir, 'fonts', 'teste.ttf'), bytes);
    const moduleRef = await Test.createTestingModule({}).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    useUploadsStatic(app, uploadsDir);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  });

  const get = (url: string) => request(app.getHttpServer()).get(url);

  it('serve o arquivo sem token, com os mesmos bytes e os três cabeçalhos de CORS', async () => {
    const response = await get('/uploads/fonts/teste.ttf')
      .set('Origin', 'http://localhost:3110')
      .buffer(true)
      .parse(binaryBody);
    expect(response.status).toBe(200);
    expect(Buffer.compare(response.body as Buffer, bytes)).toBe(0);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS');
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('só serve sob o prefixo /uploads/', async () => {
    await get('/fonts/teste.ttf').expect(404);
  });

  it('arquivo que não existe na pasta: 404', async () => {
    await get('/uploads/fonts/outro.ttf').expect(404);
  });
});
