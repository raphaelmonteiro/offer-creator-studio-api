import { Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { createSceneE2eApp, SceneE2eApp } from './scene-e2e-app';
import { createTestUser, deleteTestScenes, openSceneTestDb, SCENE_DB_URL } from './scene-test-db';

/** Os specs e2e dividem a fila `template_scene.turn` do banco: um por vez (lock de sessão). */
const E2E_LOCK_KEY = 7_770_002;

/**
 * Preparo comum dos specs e2e da cena (D-7, achado 7): controller, services e processor reais, pg-boss
 * real e o banco descartável `chroma_x_e2e`, com o provedor `mock` sem latência. Chame dentro do
 * `describeIfSceneDb`.
 */
export function useE2eHarness() {
  jest.setTimeout(60_000);
  const h = {} as {
    dataSource: DataSource;
    harness: SceneE2eApp;
    uploadsDir: string;
    token: string;
  };
  const createdScenes: string[] = [];
  const env = { ...process.env };

  let lockClient: Client;

  beforeAll(async () => {
    lockClient = new Client({ connectionString: SCENE_DB_URL });
    await lockClient.connect();
    await lockClient.query('SELECT pg_advisory_lock($1)', [E2E_LOCK_KEY]);
    Logger.overrideLogger(false);
    process.env.NODE_ENV = 'production'; // o filtro de erros não escreve console.error por teste
    process.env.TEMPLATE_SCENE_ENABLED = 'true';
    process.env.ANIMATIONS_ENABLED = 'false';
    process.env.MC_ENABLED = 'false';
    process.env.TEMPLATE_SCENE_GC_DRY_RUN = 'false';
    delete process.env.WORKER_ONLY;
    h.dataSource = await openSceneTestDb();
    h.uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-e2e-'));
    h.harness = await createSceneE2eApp(h.dataSource, {
      uploadsDir: h.uploadsDir,
      mockSlowMs: 2500,
    });
    const user = await createTestUser(h.dataSource, 'Usuária E2E');
    h.token = h.harness.jwt.sign({ sub: user.id, email: user.email });
  }, 240_000);

  afterAll(async () => {
    process.env = { ...env };
    await h.harness?.close();
    await deleteTestScenes(h.dataSource, createdScenes);
    await h.dataSource.destroy();
    await fs.rm(h.uploadsDir, { recursive: true, force: true });
    await lockClient?.end(); // solta o lock do banco
  });

  const http = () => request(h.harness.app.getHttpServer());
  const authed = (req: request.Test) => req.set('Authorization', `Bearer ${h.token}`);
  const get = (url: string) => authed(http().get(`/v1/template-scenes${url}`));
  const post = (url: string, body?: object) =>
    authed(http().post(`/v1/template-scenes${url}`)).send(body);

  async function newScene(name: string, formatId = 'folheto-27x54') {
    const response = await post('', { name, formatId });
    expect(response.status).toBe(201);
    createdScenes.push(response.body.data.id);
    return response.body.data as {
      id: string;
      revision: number;
      widthPx: number;
      heightPx: number;
    };
  }

  /** Espera a condição sobre o `GET /:id` (o worker roda no mesmo processo, pela fila real). */
  async function waitForScene(
    sceneId: string,
    done: (scene: Record<string, any>) => boolean,
    timeoutMs = 30_000,
  ): Promise<Record<string, any>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await get(`/${sceneId}`);
      if (response.status === 200 && done(response.body.data)) return response.body.data;
      if (Date.now() > deadline)
        throw new Error(`tempo esgotado: ${JSON.stringify(response.body).slice(0, 400)}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  return Object.assign(h, {
    http,
    authed,
    get,
    post,
    newScene,
    waitForScene,
    trackScene: (id: string) => createdScenes.push(id),
    isReady: (scene: Record<string, any>) => scene.currentVersion?.status === 'ready',
  });
}
