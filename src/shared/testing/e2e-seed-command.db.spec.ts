import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthController } from '../../modules/auth/auth.controller';
import { createE2eApp } from './e2e-app';
import { runE2eSeedCommand } from './e2e-seed-command';
import { FIXED_IDENTITY } from './e2e-seed-identity';
import { fileExists } from './e2e-seed-scenes';
import { createTempE2eDb, TempE2eDb, urlWithDatabase } from './e2e-temp-db.testutil';
import { describeIfE2eDb, E2E_DB_ENV, E2E_DB_URL, openE2eDb } from './e2e-test-db';

const CDN = 'http://localhost:3102/uploads';

/** O comando roda no banco `_e2e` temporário, vazio, criado e apagado pelo spec. */
describeIfE2eDb('Comando da semente para o e2e de navegador', () => {
  jest.setTimeout(180_000);
  let temp: TempE2eDb;
  let uploadsDir: string;
  const env = () => ({ [E2E_DB_ENV]: temp.url, UPLOAD_DEST: uploadsDir, CDN_URL: CDN });

  beforeAll(async () => {
    temp = await createTempE2eDb();
    uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-seed-command-'));
  });
  afterAll(async () => {
    await temp?.drop();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  /** Contagens e ids da semente fixa, lidos do banco. */
  async function fixedRows(dataSource: DataSource) {
    const count = async (sql: string, params: unknown[]) =>
      Number((await dataSource.query(sql, params))[0].count);
    const ids = FIXED_IDENTITY;
    const names = [ids.sceneFrontBack, ids.sceneTabloid];
    return {
      userId: (await dataSource.query(`SELECT id FROM users WHERE email = $1`, [ids.email]))[0]?.id,
      users: await count(`SELECT count(*) FROM users WHERE email = $1`, [ids.email]),
      clients: await count(`SELECT count(*) FROM clients WHERE cnpj = ANY($1)`, [
        [ids.clientWithLibrary.cnpj, ids.clientLegacyFooter.cnpj],
      ]),
      scenes: await count(`SELECT count(*) FROM template_scenes WHERE name = ANY($1)`, [names]),
      templates: await count(
        `SELECT count(*) FROM templates t JOIN template_scenes s
           ON t.configuration->'source'->>'sceneId' = s.id::text WHERE s.name = ANY($1)`,
        [names],
      ),
      images: await count(`SELECT count(*) FROM gallery_images WHERE filename = ANY($1)`, [
        ids.photoFiles,
      ]),
    };
  }

  it('primeira aplicação: o banco fica montado, com os dados fixos, e o login do e2e responde 200', async () => {
    const summary = await runE2eSeedCommand(env());
    expect(summary).toMatchObject({ email: 'e2e@chroma.local', cdnUrl: CDN, database: temp.name });

    const dataSource = await openE2eDb(temp.url);
    const web = await createE2eApp({ dataSource, uploadsDir, controllers: [AuthController] });
    try {
      expect(await fixedRows(dataSource)).toMatchObject({
        users: 1,
        clients: 2,
        scenes: 2,
        templates: 4,
        images: 2,
      });
      const login = await request(web.app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: FIXED_IDENTITY.email, password: FIXED_IDENTITY.password });
      expect(login.status).toBe(200);
      expect(login.body.data.token).toEqual(expect.any(String));
    } finally {
      await web.close();
      await dataSource.destroy();
    }
  });

  it('aplicação repetida: termina sem erro e as contagens e os ids ficam iguais', async () => {
    const dataSource = await openE2eDb(temp.url);
    try {
      const before = await fixedRows(dataSource);
      await runE2eSeedCommand(env());
      expect(await fixedRows(dataSource)).toEqual(before);
    } finally {
      await dataSource.destroy();
    }
  });

  it('arte e fotos na pasta indicada, com as URLs no endereço indicado', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-seed-command-pasta-'));
    try {
      const summary = await runE2eSeedCommand({ ...env(), UPLOAD_DEST: dir });
      for (const filename of FIXED_IDENTITY.photoFiles) {
        expect(await fileExists(path.join(dir, 'gallery', filename))).toBe(true);
      }
      expect(summary.images.every((url) => url.startsWith(`${CDN}/gallery/`))).toBe(true);
      const dataSource = await openE2eDb(temp.url);
      try {
        const [row] = await dataSource.query(
          `SELECT t.configuration->'bodyBackground'->>'imageUrl' AS art
           FROM templates t JOIN template_scenes s ON t.configuration->'source'->>'sceneId' = s.id::text
           WHERE s.name = $1 AND t.configuration->'source'->>'faceKey' = 'front'`,
          [FIXED_IDENTITY.sceneFrontBack],
        );
        expect(row.art.startsWith(`${CDN}/templates/scene-`)).toBe(true);
        expect(await fileExists(path.join(dir, row.art.slice(CDN.length + 1)))).toBe(true);
      } finally {
        await dataSource.destroy();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('banco do ambiente: recusa antes de conectar, com o nome do banco', async () => {
    const flyer = urlWithDatabase(E2E_DB_URL as string, 'flyer_db');
    await expect(runE2eSeedCommand({ ...env(), [E2E_DB_ENV]: flyer })).rejects.toThrow(/flyer_db/);
  });

  it('sem UPLOAD_DEST ou CDN_URL: erro em pt-BR que diz o que definir, sem escrever nada', async () => {
    await expect(runE2eSeedCommand({ ...env(), UPLOAD_DEST: undefined })).rejects.toThrow(
      /Defina UPLOAD_DEST/,
    );
    await expect(runE2eSeedCommand({ ...env(), CDN_URL: undefined })).rejects.toThrow(/CDN_URL/);
  });
});
