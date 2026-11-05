import * as sharp from 'sharp';
import { ConfigService } from '@nestjs/config';
import { SceneFilesService } from './services/scene-files.service';
import { E2E_ADMIN_TOKEN } from './testing/scene-e2e-app';
import { useE2eHarness } from './testing/scene-e2e-harness';
import { describeIfSceneDb } from './testing/scene-test-db';

/**
 * E2E da cena (fluxo base, exclusão, SSE e acesso negado). Rodar com `TEMPLATE_SCENE_E2E_DB_URL=... npm run test --
 * template-scenes.controller.e2e` (com `--runInBand` junto dos outros specs de banco, porque o GC
 * manual olha todas as cenas do banco).
 */
describeIfSceneDb('Cena de template: fluxo base (e2e, banco chroma_x_e2e)', () => {
  const h = useE2eHarness();
  const { http, authed, get, post, newScene, waitForScene, isReady } = h;

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

      const files = new SceneFilesService(new ConfigService({ UPLOAD_DEST: h.uploadsDir }));
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
      expect(edit.status).toBe(202);
      expect(edit.body.data).toMatchObject({ jobId: null, operation: 'needs_region' });
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
      const server = h.harness.app.getHttpServer().listen(0);
      const { port } = server.address() as { port: number };
      const controller = new AbortController();
      const events: Array<Record<string, any>> = [];
      const reading = (async () => {
        const response = await fetch(
          `http://127.0.0.1:${port}/v1/template-scenes/${created.id}/events`,
          {
            headers: { Authorization: `Bearer ${h.token}` },
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
