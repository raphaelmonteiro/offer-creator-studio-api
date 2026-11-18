import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { ClientsController } from '../../modules/clients/clients.controller';
import { ClientsService } from '../../modules/clients/clients.service';
import { FlyerProClientGuardService } from '../../modules/flyer-pro/services/flyer-pro-client-guard.service';
import { SceneTemplateConfiguration } from '../../modules/template-scenes/domain/scene-template.types';
import { Template } from '../../modules/templates/entities/template.entity';
import { createE2eApp, E2eApp } from './e2e-app';
import { applyE2eSeed, E2eSeed } from './e2e-seed';
import { fileExists } from './e2e-seed-scenes';
import { createTempE2eDb, TempE2eDb, urlWithDatabase } from './e2e-temp-db.testutil';
import { describeIfE2eDb, E2E_DB_URL, openE2eDb } from './e2e-test-db';

/** Conta as linhas que uma semente deixa, por tabela, para comparar antes e depois da limpeza de outra. */
async function rowsOf(dataSource: DataSource, seed: E2eSeed) {
  const sceneIds = [seed.scenes.frontBack.id, seed.scenes.tabloid.id];
  const one = async (sql: string, ...params: unknown[]) =>
    Number((await dataSource.query(sql, params))[0].count);
  return {
    users: await one(`SELECT count(*) FROM users WHERE id = $1`, seed.user.id),
    clients: await one(`SELECT count(*) FROM clients WHERE cnpj = ANY($1)`, [
      seed.identity.clientWithLibrary.cnpj,
      seed.identity.clientLegacyFooter.cnpj,
    ]),
    scenes: await one(`SELECT count(*) FROM template_scenes WHERE id = ANY($1::uuid[])`, sceneIds),
    faces: await one(
      `SELECT count(*) FROM template_scene_faces WHERE "sceneId" = ANY($1::uuid[])`,
      sceneIds,
    ),
    templates: await one(
      `SELECT count(*) FROM templates WHERE configuration->'source'->>'sceneId' = ANY($1)`,
      sceneIds,
    ),
    images: await one(
      `SELECT count(*) FROM gallery_images WHERE filename = ANY($1)`,
      seed.identity.photoFiles,
    ),
    folders: await one(`SELECT count(*) FROM gallery_folders WHERE id = $1`, seed.folder.id),
  };
}

describeIfE2eDb('Semente do e2e (banco chroma_x_e2e)', () => {
  jest.setTimeout(180_000);
  let dataSource: DataSource;
  const dirs: string[] = [];
  const seeds: E2eSeed[] = [];

  const newDir = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-seed-'));
    dirs.push(dir);
    return dir;
  };
  /** Aplica uma semente nova (ids únicos) numa pasta própria; a limpeza final apaga o que sobrar. */
  const seed = async () => {
    const uploadsDir = await newDir();
    const applied = await applyE2eSeed(dataSource, { uploadsDir });
    seeds.push(applied);
    return { applied, uploadsDir };
  };

  beforeAll(async () => {
    dataSource = await openE2eDb();
  });
  afterAll(async () => {
    for (const applied of seeds) await applied.cleanup().catch(() => undefined);
    await dataSource?.destroy();
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  });

  it('o que a semente cria: usuário com senha e token aceitos, clientes, cenas com template e fotos', async () => {
    const { applied, uploadsDir } = await seed();
    expect(await applied.user.validatePassword(applied.identity.password)).toBe(true);

    const withLibrary = applied.clientWithLibrary;
    expect(withLibrary.headers).toEqual([expect.objectContaining({ format: '27x40' })]);
    expect(withLibrary.footers).toHaveLength(2);
    expect(withLibrary.footer).toEqual(withLibrary.footers[0].section);
    const legacy = applied.clientLegacyFooter;
    expect(legacy.footer).not.toBeNull();
    expect([legacy.footers, legacy.headers]).toEqual([null, null]);

    const { frontBack, tabloid } = applied.scenes;
    expect([frontBack.formatId, frontBack.layout]).toEqual(['folheto-27x40', 'front_back']);
    expect(frontBack.faces.map((face) => face.key)).toEqual(['front', 'back']);
    expect([tabloid.formatId, tabloid.layout]).toEqual(['folheto-54x40', 'tabloid']);
    expect(tabloid.faces.map((face) => face.key)).toEqual(['outer', 'inner']);
    for (const scene of [frontBack, tabloid]) {
      for (const face of scene.faces) {
        const template = await dataSource.manager.findOneByOrFail(Template, {
          id: face.templateId,
        });
        const configuration = template.configuration as SceneTemplateConfiguration;
        expect(template.isDefault).toBe(false);
        expect(configuration.source).toMatchObject({
          kind: 'template-scene',
          sceneId: scene.id,
          faceKey: face.key,
        });
        const artUrl = configuration.bodyBackground.imageUrl;
        expect(artUrl.startsWith('http://cdn.e2e.test/uploads/')).toBe(true);
        expect(
          await fileExists(
            path.join(uploadsDir, artUrl.replace('http://cdn.e2e.test/uploads/', '')),
          ),
        ).toBe(true);
      }
    }
    expect(applied.images).toHaveLength(2);
    for (const image of applied.images) {
      expect(await fileExists(path.join(uploadsDir, 'gallery', image.filename))).toBe(true);
    }

    const web: E2eApp = await createE2eApp({
      dataSource,
      uploadsDir,
      controllers: [ClientsController],
      providers: [ClientsService, FlyerProClientGuardService],
    });
    try {
      const token = web.jwt.sign({ sub: applied.user.id, email: applied.user.email });
      await request(web.app.getHttpServer())
        .get('/v1/clients?limit=1')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    } finally {
      await web.close();
    }
  });

  it('duas suítes ao mesmo tempo: nenhuma falha por chave única e cada uma tem os seus ids', async () => {
    const [first, second] = await Promise.all([seed(), seed()]);
    expect(first.applied.user.id).not.toBe(second.applied.user.id);
    expect(first.applied.scenes.frontBack.id).not.toBe(second.applied.scenes.frontBack.id);
    expect(first.applied.clientWithLibrary.cnpj).not.toBe(second.applied.clientWithLibrary.cnpj);
  });

  it('a limpeza de uma suíte apaga só os dados dela, com os arquivos, e deixa os da outra iguais', async () => {
    const first = await seed();
    const second = await seed();
    const secondBefore = await rowsOf(dataSource, second.applied);
    expect(Object.values(await rowsOf(dataSource, first.applied)).every((count) => count > 0)).toBe(
      true,
    );

    await first.applied.cleanup();

    expect(await rowsOf(dataSource, first.applied)).toEqual({
      users: 0,
      clients: 0,
      scenes: 0,
      faces: 0,
      templates: 0,
      images: 0,
      folders: 0,
    });
    expect(
      await fileExists(
        path.join(first.uploadsDir, 'template-scenes', first.applied.scenes.frontBack.id),
      ),
    ).toBe(false);
    expect(
      await fileExists(path.join(first.uploadsDir, 'gallery', first.applied.images[0].filename)),
    ).toBe(false);
    expect(await rowsOf(dataSource, second.applied)).toEqual(secondBefore);
    expect(secondBefore.users).toBe(1);
    expect(
      await fileExists(path.join(second.uploadsDir, 'gallery', second.applied.images[0].filename)),
    ).toBe(true);
  });

  it('semente sobre o resto de uma execução que quebrou no meio: termina sem erro de chave única', async () => {
    await seed(); // fica sem limpar, como uma execução que quebrou
    await expect(seed()).resolves.toBeDefined();
  });

  it('semente em banco recusado: o harness recusa o flyer_db antes de conectar', async () => {
    const flyer = urlWithDatabase(E2E_DB_URL as string, 'flyer_db');
    await expect(openE2eDb(flyer)).rejects.toThrow(/O e2e nunca usa o flyer_db/);
  });
});

describeIfE2eDb('Semente do e2e em banco recém-criado', () => {
  jest.setTimeout(180_000);
  let temp: TempE2eDb;
  let dataSource: DataSource;
  let dir: string;

  beforeAll(async () => {
    temp = await createTempE2eDb();
    dataSource = await openE2eDb(temp.url);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-seed-fresh-'));
  });
  afterAll(async () => {
    await dataSource?.destroy();
    await temp?.drop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('gallery_images existe e tem as 2 fotos de teste', async () => {
    const applied = await applyE2eSeed(dataSource, { uploadsDir: dir });
    const rows = await dataSource.query(
      `SELECT filename, metadata_status FROM gallery_images ORDER BY filename`,
    );
    expect(rows).toEqual(
      applied.identity.photoFiles
        .map((filename) => ({ filename, metadata_status: 'ready' }))
        .sort((a, b) => a.filename.localeCompare(b.filename)),
    );
  });
});
