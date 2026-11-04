import { Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as request from 'supertest';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';
import { TemplateScene } from './entities/template-scene.entity';
import { insertReadyVersion, insertScene } from './testing/scene-fixtures';
import { createSceneE2eApp, E2E_ADMIN_TOKEN, SceneE2eApp } from './testing/scene-e2e-app';
import {
  createTestUser,
  deleteTestScenes,
  describeIfSceneDb,
  openSceneTestDb,
} from './testing/scene-test-db';
import { SceneFilesService } from './services/scene-files.service';
import { ConfigService } from '@nestjs/config';

/**
 * E2E da cena (D-7, achado 7): controller, services e processor reais, pg-boss real e o banco
 * descartável `chroma_x_e2e`, com o provedor `mock` sem latência. Fluxo base e acesso negado; as
 * bordas ficam nos specs de unidade. Rodar com `TEMPLATE_SCENE_E2E_DB_URL=... npm run test --
 * template-scenes.controller.e2e` (e com `--runInBand` se rodar junto com os outros specs de
 * banco, porque o GC manual olha todas as cenas do banco).
 */
describeIfSceneDb('Cena de template: fluxo base (e2e, banco chroma_x_e2e)', () => {
  jest.setTimeout(60_000);

  let dataSource: DataSource;
  let harness: SceneE2eApp;
  let uploadsDir: string;
  let token: string;
  const createdScenes: string[] = [];
  const env = { ...process.env };

  beforeAll(async () => {
    Logger.overrideLogger(false);
    process.env.NODE_ENV = 'production'; // o filtro de erros não escreve console.error por teste
    process.env.TEMPLATE_SCENE_ENABLED = 'true';
    process.env.ANIMATIONS_ENABLED = 'false';
    process.env.MC_ENABLED = 'false';
    process.env.TEMPLATE_SCENE_GC_DRY_RUN = 'false';
    delete process.env.WORKER_ONLY;
    dataSource = await openSceneTestDb();
    uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-e2e-'));
    harness = await createSceneE2eApp(dataSource, { uploadsDir, mockSlowMs: 2500 });
    const user = await createTestUser(dataSource, 'Usuária E2E');
    token = harness.jwt.sign({ sub: user.id, email: user.email });
  });

  afterAll(async () => {
    process.env = { ...env };
    await harness?.close();
    await deleteTestScenes(dataSource, createdScenes);
    await dataSource.destroy();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  const http = () => request(harness.app.getHttpServer());
  const authed = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
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

  const isReady = (scene: Record<string, any>) => scene.currentVersion?.status === 'ready';

  describe('fluxo base', () => {
    it('cria, lista, gera pela fila (com animações desligadas) e lê a versão ready', async () => {
      const created = await newScene('E2E Páscoa');
      expect(created).toMatchObject({ widthPx: 1920, heightPx: 3840, revision: 0 });

      const list = await get('?limit=50');
      expect(list.status).toBe(200);
      expect(list.body.pagination).toMatchObject({ page: 1, limit: 50 });
      const item = list.body.data.find((entry: { id: string }) => entry.id === created.id);
      expect(item).toMatchObject({
        name: 'E2E Páscoa',
        createdByName: 'Usuária E2E',
        previewUrl: null,
      });

      const sent = await post(`/${created.id}/messages`, {
        content: 'campo verde com sol à direita',
        expectedRevision: 0,
      });
      expect(sent.status).toBe(202);
      expect(sent.body.data).toMatchObject({ revision: 1 });
      expect(sent.body.data.jobId).toEqual(expect.any(String));

      const scene = await waitForScene(created.id, isReady);
      expect(scene.currentVersion).toMatchObject({
        number: 1,
        operation: 'generate',
        providerCostUsd: 0,
      });
      expect(scene.currentVersion.master).toMatchObject({ width: 1920, height: 3840 });
      expect(scene.currentVersion.preview.url).toMatch(/preview\.webp$/);
      expect(scene.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
      expect(scene.activeVersion).toBeNull();

      const files = new SceneFilesService(new ConfigService({ UPLOAD_DEST: uploadsDir }));
      const master = await sharp(files.absolutePath(scene.currentVersion.master.url)).metadata();
      expect(master).toMatchObject({ format: 'png', width: 1920, height: 3840 });
      const after = await get('?limit=50');
      expect(
        after.body.data.find((entry: { id: string }) => entry.id === created.id).previewUrl,
      ).toMatch(/preview\.webp$/);
    });

    it('SCENE_BUSY durante a geração e REVISION_CONFLICT com revisão antiga', async () => {
      const created = await newScene('E2E Ocupada');
      const first = await post(`/${created.id}/messages`, {
        content: 'campo #lento',
        expectedRevision: 0,
      });
      expect(first.status).toBe(202);

      const busy = await post(`/${created.id}/messages`, { content: 'outra', expectedRevision: 1 });
      expect(busy.status).toBe(409);
      expect(busy.body.error.code).toBe('SCENE_BUSY');

      await waitForScene(created.id, isReady);
      const stale = await post(`/${created.id}/messages`, {
        content: 'reenvio',
        expectedRevision: 0,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('REVISION_CONFLICT');
      const edit = await post(`/${created.id}/messages`, {
        content: 'deixa o sol laranja',
        expectedRevision: 2,
      });
      expect(edit.status).toBe(422);
      expect(edit.body.error.code).toBe('SCENE_EDIT_UNAVAILABLE');
    });

    it('duas mensagens ao mesmo tempo: uma 202, a outra 409, uma só versão', async () => {
      const created = await newScene('E2E Corrida');
      const [a, b] = await Promise.all([
        post(`/${created.id}/messages`, { content: 'primeira', expectedRevision: 0 }),
        post(`/${created.id}/messages`, { content: 'segunda', expectedRevision: 0 }),
      ]);
      expect([a.status, b.status].sort()).toEqual([202, 409]);
      const scene = await waitForScene(created.id, isReady);
      expect(scene.versions.total).toBe(1);
    });

    it('cancela durante a chamada: continua ocupada até o worker parar, descarta o resultado e libera', async () => {
      const created = await newScene('E2E Cancelar');
      const sent = await post(`/${created.id}/messages`, {
        content: 'campo #lento',
        expectedRevision: 0,
      });
      const running = await waitForScene(created.id, (s) => s.activeVersion?.step === 'generating');

      const cancel = await post(`/${created.id}/versions/${sent.body.data.versionId}/cancel`);
      expect(cancel.status).toBe(202);
      expect(cancel.body.data).toMatchObject({
        versionId: sent.body.data.versionId,
        status: 'running',
      });
      const blocked = await post(`/${created.id}/messages`, {
        content: 'outra',
        expectedRevision: cancel.body.data.revision,
      });
      expect(blocked.body.error.code).toBe('SCENE_BUSY');
      expect(running.activeVersion.cancelRequested).toBe(false);

      const done = await waitForScene(created.id, (s) => s.activeVersion === null);
      expect(done.currentVersion).toBeNull();
      expect(done.versions.items[0]).toMatchObject({ status: 'cancelled', previewUrl: null });
      expect(done.messages.at(-1).content).toBe('Geração cancelada.');
      const again = await post(`/${created.id}/messages`, {
        content: 'campo verde',
        expectedRevision: done.revision,
      });
      expect(again.status).toBe(202);
      await waitForScene(created.id, isReady);
    });

    it('logo por upload + PATCH das camadas: uma só versão manual aberta acumula os ajustes', async () => {
      const created = await newScene('E2E Camadas');
      await post(`/${created.id}/messages`, { content: 'campo verde', expectedRevision: 0 });
      const ready = await waitForScene(created.id, isReady);

      const png = await sharp({
        create: { width: 30, height: 30, channels: 4, background: '#f00' },
      })
        .png()
        .toBuffer();
      const logo = await authed(
        http().post(`/v1/template-scenes/${created.id}/assets/logo`),
      ).attach('file', png, {
        filename: 'logo.png',
        contentType: 'image/png',
      });
      expect(logo.status).toBe(201);
      expect(logo.body.data).toMatchObject({ width: 30, height: 30 });

      const element = (extra: object) => ({
        id: 'logo-1',
        kind: 'logo',
        name: 'Logo',
        x: 0.5,
        y: 0.1,
        w: 0.2,
        aspect: 1,
        rotation: 0,
        z: 1,
        assetId: logo.body.data.assetId,
        ...extra,
      });
      const first = await authed(http().patch(`/v1/template-scenes/${created.id}/elements`)).send({
        expectedRevision: ready.revision,
        elements: [element({ x: 0.3 })],
      });
      expect(first.status).toBe(200);
      const second = await authed(http().patch(`/v1/template-scenes/${created.id}/elements`)).send({
        expectedRevision: first.body.data.revision,
        elements: [element({ x: 0.3, rotation: 5 })],
      });
      expect(second.body.data.versions.total).toBe(2);
      expect(second.body.data.currentVersion).toMatchObject({
        operation: 'manual',
        isOpenManual: true,
      });
      expect(second.body.data.currentVersion.assets.map((a: { role: string }) => a.role)).toEqual(
        expect.arrayContaining(['master', 'logo']),
      );

      const svg = await authed(http().post(`/v1/template-scenes/${created.id}/assets/logo`)).attach(
        'file',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        { filename: 'logo.svg', contentType: 'image/svg+xml' },
      );
      expect(svg.status).toBe(422);
      expect(svg.body.error.code).toBe('LOGO_INVALID');
      const url = await authed(http().patch(`/v1/template-scenes/${created.id}/elements`)).send({
        expectedRevision: second.body.data.revision,
        elements: [{ ...element({}), src: 'http://x/a.png' }],
      });
      expect(url.status).toBe(400);
    });

    it('restaurar e, depois do GC manual, 410 para a versão podada', async () => {
      const scene = await insertScene(dataSource, { name: 'E2E Restaurar' });
      createdScenes.push(scene.id);
      const files = new SceneFilesService(new ConfigService({ UPLOAD_DEST: uploadsDir }));
      const ready = [];
      for (let number = 1; number <= 6; number++) {
        const item = await insertReadyVersion(dataSource, scene, number);
        for (const asset of [item.master, item.preview]) {
          const name = path.basename(asset.url);
          await files.write(scene.id, item.version.id, name, Buffer.from(name));
        }
        ready.push(item);
      }
      await dataSource.manager.update(
        TemplateScene,
        { id: scene.id },
        { currentVersionId: ready[5].version.id },
      );
      await dataSource.query(
        `UPDATE template_scene_assets SET "expiresAt" = now() - interval '1 minute' WHERE "versionId" = $1`,
        [ready[0].version.id],
      );

      const gc = await http()
        .post('/v1/template-scenes/admin/gc')
        .set('x-admin-token', E2E_ADMIN_TOKEN)
        .send({ dryRun: false });
      expect(gc.status).toBe(200);
      expect(gc.body.data).toMatchObject({ dryRun: false });
      expect(gc.body.data.files).toEqual(
        expect.arrayContaining([ready[0].master.url, ready[0].preview.url]),
      );
      await expect(fs.access(files.absolutePath(ready[0].master.url))).rejects.toThrow();

      const gone = await post(`/${scene.id}/versions/${ready[0].version.id}/restore`);
      expect(gone.status).toBe(410);
      expect(gone.body.error).toMatchObject({
        code: 'VERSION_NOT_RESTORABLE',
        details: { reason: 'master_purged' },
      });
      const ok = await post(`/${scene.id}/versions/${ready[2].version.id}/restore`);
      expect(ok.status).toBe(200);
      expect(ok.body.data.currentVersion).toMatchObject({ operation: 'restore', number: 7 });
      expect(
        ok.body.data.versions.items.find((v: { number: number }) => v.number === 1),
      ).toMatchObject({
        restorable: false,
        previewUrl: null,
      });
    });

    it('exclui, a cena some e responde 404', async () => {
      const created = await newScene('E2E Excluir');
      const removed = await authed(http().delete(`/v1/template-scenes/${created.id}`));
      expect(removed.status).toBe(204);
      expect((await get(`/${created.id}`)).status).toBe(404);
      expect((await authed(http().delete(`/v1/template-scenes/${created.id}`))).status).toBe(404);
      const list = await get('?limit=50');
      expect(
        list.body.data.find((entry: { id: string }) => entry.id === created.id),
      ).toBeUndefined();
    });

    it('recebe por SSE as etapas de uma geração', async () => {
      const created = await newScene('E2E SSE');
      const server = harness.app.getHttpServer().listen(0);
      const { port } = server.address() as { port: number };
      const controller = new AbortController();
      const events: Array<Record<string, any>> = [];
      const reading = (async () => {
        const response = await fetch(
          `http://127.0.0.1:${port}/v1/template-scenes/${created.id}/events`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          },
        );
        expect(response.status).toBe(200);
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          for (const block of buffer.split('\n\n').slice(0, -1)) {
            if (block.startsWith('data: ')) events.push(JSON.parse(block.slice(6)));
          }
          buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
          if (events.some((e) => e.kind === 'version.ready')) break;
        }
      })().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));

      await post(`/${created.id}/messages`, { content: 'campo verde', expectedRevision: 0 });
      await waitForScene(created.id, isReady);
      await Promise.race([reading, new Promise((resolve) => setTimeout(resolve, 5000))]);
      controller.abort();
      server.close();

      expect(events.map((e) => [e.kind, e.step])).toEqual([
        ['version.step', null],
        ['version.step', 'preparing'],
        ['version.step', 'generating'],
        ['version.step', 'saving'],
        ['version.ready', 'done'],
      ]);
      expect(events.every((e) => e.sceneId === created.id)).toBe(true);
    });
  });

  describe('acesso negado e flag', () => {
    it('sem token ou com token inválido: 401', async () => {
      expect((await http().get('/v1/template-scenes')).status).toBe(401);
      const bad = await http().get('/v1/template-scenes').set('Authorization', 'Bearer lixo');
      expect(bad.status).toBe(401);
    });

    it('rota admin sem x-admin-token ou com token errado: 401 e nada roda', async () => {
      expect((await http().post('/v1/template-scenes/admin/gc').send({})).status).toBe(401);
      const wrong = await http()
        .post('/v1/template-scenes/admin/gc')
        .set('x-admin-token', 'errado')
        .send({});
      expect(wrong.status).toBe(401);
    });

    it('flag desligada: 404 TEMPLATE_SCENE_DISABLED em todas as rotas', async () => {
      process.env.TEMPLATE_SCENE_ENABLED = 'false';
      try {
        const response = await get('');
        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('TEMPLATE_SCENE_DISABLED');
        const admin = await http()
          .post('/v1/template-scenes/admin/gc')
          .set('x-admin-token', E2E_ADMIN_TOKEN)
          .send({});
        expect(admin.status).toBe(404);
      } finally {
        process.env.TEMPLATE_SCENE_ENABLED = 'true';
      }
    });

    it('formato não suportado e nome vazio: 422 e 400', async () => {
      const spread = await post('', { name: 'Spread', formatId: 'spread-55x55' });
      expect(spread.status).toBe(422);
      expect(spread.body.error.code).toBe('SCENE_FORMAT_UNSUPPORTED');
      expect((await post('', { name: '', formatId: 'folheto-27x54' })).status).toBe(400);
    });
  });
});
