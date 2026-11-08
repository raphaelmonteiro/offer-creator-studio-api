import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TemplateScene } from './entities/template-scene.entity';
import { SceneFilesService } from './services/scene-files.service';
import { insertReadyVersion, insertScene } from './testing/scene-fixtures';
import { E2E_CDN_URL } from './testing/scene-e2e-app';
import { useE2eHarness } from './testing/scene-e2e-harness';
import { solidPng } from './testing/scene-template-fixtures';
import { describeIfSceneDb } from './testing/scene-test-db';

type Config = Record<string, any>;

/**
 * E2E da cena como template do encarte (fluxo base): a cena com imagem vira um template em `GET /v1/templates`,
 * acompanha voltar, desfazer e camada, some com a exclusão e nasce no backfill. O worker roda no mesmo processo, pela
 * fila real; os passos que só precisam do resultado chamam o job direto (a espera do pg-boss é de 5 s). Rodar com
 * `TEMPLATE_SCENE_E2E_DB_URL=... npm run test -- template-scenes.template.e2e --runInBand`.
 */
describeIfSceneDb(
  'Cena de template: template no editor de encartes (e2e, banco chroma_x_e2e)',
  () => {
    const h = useE2eHarness();
    const { http, authed, get, post, newScene, waitForScene, isReady } = h;

    const listTemplates = (search: string) =>
      authed(http().get('/v1/templates').query({ search, type: 'full', limit: 50 }));
    const templateOf = async (name: string) => {
      const list = await listTemplates(name);
      expect(list.status).toBe(200);
      const [found] = list.body.data as Array<{ id: string }>;
      if (!found) return null;
      const detail = await authed(http().get(`/v1/templates/${found.id}`));
      return { id: found.id, ...detail.body.data } as {
        id: string;
        configuration: Config;
        name: string;
        type: string;
      };
    };
    const waitForTemplate = async (name: string, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = await templateOf(name);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`template "${name}" não apareceu`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    };
    const sync = (sceneId: string) => h.harness.templateSync.process({ sceneId });
    const diskOf = (url: string) => path.join(h.uploadsDir, url.replace(`${E2E_CDN_URL}/`, ''));

    /** Cena de fixture (sem passar pelo chat) com a versão 1 `ready` e a master em disco. */
    async function fixtureScene(name: string) {
      const scene = await insertScene(h.dataSource, { name, widthPx: 384, heightPx: 768 });
      h.trackScene(scene.id);
      const { version, master } = await insertReadyVersion(h.dataSource, scene, 1);
      const files = new SceneFilesService(new ConfigService({ UPLOAD_DEST: h.uploadsDir }));
      await files.write(
        scene.id,
        version.id,
        path.basename(master.url),
        await solidPng(384, 768, [20, 120, 220]),
      );
      await h.dataSource.manager.update(
        TemplateScene,
        { id: scene.id },
        { currentVersionId: version.id },
      );
      return { scene, version, master, files };
    }

    it('cena com imagem aparece em GET /v1/templates, pela fila do worker, com o marcador da cena', async () => {
      const created = await newScene('E2E Tmpl Páscoa');
      expect(await templateOf('E2E Tmpl Páscoa')).toBeNull();

      const sent = await post(`/${created.id}/messages`, {
        content: 'campo verde com sol à direita',
        expectedRevision: 0,
      });
      expect(sent.status).toBe(202);
      const ready = await waitForScene(created.id, isReady);
      const template = await waitForTemplate('E2E Tmpl Páscoa');

      expect(template).toMatchObject({ name: 'E2E Tmpl Páscoa', type: 'full' });
      const config = template.configuration;
      expect(config.format).toBe('folheto-27x54');
      expect(config.source).toMatchObject({ kind: 'template-scene', sceneId: created.id });
      expect(config.source.versionId).toEqual(expect.any(String));
      expect(config.header).toMatchObject({ widthCm: 27.5, background: { type: 'image' } });
      for (const url of [config.bodyBackground.imageUrl, config.header.background.imageUrl]) {
        expect(url).toContain(`${E2E_CDN_URL}/templates/scene-${created.id}/`);
        await expect(fs.access(diskOf(url))).resolves.toBeUndefined();
      }
      // a tela da cena não muda por causa da sincronização
      const scene = await get(`/${created.id}`);
      expect(scene.body.data.revision).toBe(ready.revision);
    });

    it('voltar, camada e desfazer atualizam o template; a cena excluída o tira', async () => {
      const created = await newScene('E2E Tmpl Acompanha');
      await post(`/${created.id}/messages`, { content: 'campo verde', expectedRevision: 0 });
      const v1 = await waitForScene(created.id, isReady);
      await sync(created.id);
      const first = (await templateOf('E2E Tmpl Acompanha')) as NonNullable<
        Awaited<ReturnType<typeof templateOf>>
      >;

      // segunda imagem: o template troca de arquivos
      await post(`/${created.id}/messages`, {
        content: 'agora com céu azul e nuvens',
        expectedRevision: v1.revision,
      });
      const v2 = await waitForScene(created.id, (s) => isReady(s) && s.currentVersion.number === 2);
      await sync(created.id);
      const second = (await templateOf('E2E Tmpl Acompanha')) as NonNullable<
        Awaited<ReturnType<typeof templateOf>>
      >;
      expect(second.id).toBe(first.id);
      expect(second.configuration.source.pictorialKey).not.toBe(
        first.configuration.source.pictorialKey,
      );
      expect(second.configuration.bodyBackground.imageUrl).not.toBe(
        first.configuration.bodyBackground.imageUrl,
      );

      // voltar para a versão 1 (botão)
      const restored = await post(`/${created.id}/versions/${v1.currentVersion.id}/restore`);
      expect(restored.status).toBe(200);
      await sync(created.id);
      const back = (await templateOf('E2E Tmpl Acompanha')) as NonNullable<
        Awaited<ReturnType<typeof templateOf>>
      >;
      expect(back.configuration.source.pictorialKey).toBe(first.configuration.source.pictorialKey);

      // camada: texto no rodapé vira elemento, sem imagem nova
      const patched = await authed(http().patch(`/v1/template-scenes/${created.id}/elements`)).send(
        {
          expectedRevision: restored.body.data.revision,
          elements: [
            {
              id: 't1',
              kind: 'text',
              name: 'Texto',
              x: 0.5,
              y: 0.96,
              w: 0.6,
              aspect: 5,
              rotation: 0,
              z: 1,
              text: 'Ofertas da semana',
              fontSize: 6,
            },
          ],
        },
      );
      expect(patched.status).toBe(200);
      await sync(created.id);
      const layered = (await templateOf('E2E Tmpl Acompanha')) as NonNullable<
        Awaited<ReturnType<typeof templateOf>>
      >;
      expect(layered.configuration.footer.elements[0]).toMatchObject({
        type: 'text',
        content: 'Ofertas da semana',
      });
      expect(layered.configuration.bodyBackground.imageUrl).toBe(
        back.configuration.bodyBackground.imageUrl,
      );

      // desfazer pelo chat (volta uma versão)
      const undo = await post(`/${created.id}/messages`, {
        content: 'volta como estava antes',
        expectedRevision: patched.body.data.revision,
      });
      expect(undo.status).toBe(202);
      await waitForScene(
        created.id,
        (s) =>
          isReady(s) && s.currentVersion.operation === 'restore' && s.currentVersion.number > 4,
      );
      await sync(created.id);
      const undone = (await templateOf('E2E Tmpl Acompanha')) as NonNullable<
        Awaited<ReturnType<typeof templateOf>>
      >;
      expect(undone.configuration.source.versionId).not.toBe(
        layered.configuration.source.versionId,
      );
      expect(v2.currentVersion.number).toBe(2);

      // exclusão: o template some da lista e do detalhe
      const removed = await authed(http().delete(`/v1/template-scenes/${created.id}`));
      expect(removed.status).toBe(204);
      expect(await templateOf('E2E Tmpl Acompanha')).toBeNull();
      expect((await authed(http().get(`/v1/templates/${first.id}`))).status).toBe(404);
    });

    it('cena antiga, sem template, recebe o dele pela varredura do worker (backfill)', async () => {
      const { scene } = await fixtureScene('E2E Tmpl Antiga');
      // a mais antiga do banco passa na frente das que outros testes deixaram sem template
      await h.dataSource.query(
        `UPDATE template_scenes SET "createdAt" = '2000-01-01' WHERE id = $1`,
        [scene.id],
      );
      expect(await templateOf('E2E Tmpl Antiga')).toBeNull();

      const swept = await h.harness.templateSweep.sweep(1);
      expect(swept.queued).toBe(1);

      const template = await waitForTemplate('E2E Tmpl Antiga');
      expect(template.configuration.source.sceneId).toBe(scene.id);
    });

    it('falha da projeção mantém o template anterior', async () => {
      const { scene, files } = await fixtureScene('E2E Tmpl Falha');
      await sync(scene.id);
      const before = (await templateOf('E2E Tmpl Falha')) as NonNullable<
        Awaited<ReturnType<typeof templateOf>>
      >;
      const second = await insertReadyVersion(h.dataSource, scene, 2);
      await h.dataSource.manager.update(
        TemplateScene,
        { id: scene.id },
        { currentVersionId: second.version.id, revision: () => 'revision + 1' },
      );
      // a master da versão 2 não está em disco
      await expect(fs.access(files.absolutePath(second.master.url))).rejects.toThrow();

      await expect(sync(scene.id)).rejects.toThrow('Master da versão ausente');

      const after = (await templateOf('E2E Tmpl Falha')) as NonNullable<
        Awaited<ReturnType<typeof templateOf>>
      >;
      expect(after.configuration).toEqual(before.configuration);
      const failed = await h.dataSource.query(
        `SELECT metrics->'templateSync' AS failure FROM template_scene_versions WHERE id = $1`,
        [second.version.id],
      );
      expect(failed[0].failure).toMatchObject({ attempts: 1, error: 'Master da versão ausente' });
    });

    it('acesso negado: sem token, a lista de templates responde 401', async () => {
      const response = await http().get('/v1/templates');
      expect(response.status).toBe(401);
    });
  },
);
