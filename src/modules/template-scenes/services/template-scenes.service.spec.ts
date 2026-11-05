import { DataSource } from 'typeorm';
import { SceneLockService } from './scene-lock.service';
import { SceneReadService } from './scene-read.service';
import { TemplateScenesService } from './template-scenes.service';
import { TemplateScene } from '../entities/template-scene.entity';
import {
  insertMessage,
  insertReadyVersion,
  insertScene,
  insertVersion,
} from '../testing/scene-fixtures';
import { errorOf } from '../testing/scene-test-helpers';
import {
  createTestUser,
  deleteTestScenes,
  describeIfSceneDb,
  openSceneTestDb,
} from '../testing/scene-test-db';

describeIfSceneDb('TemplateScenesService (banco chroma_x_e2e)', () => {
  let dataSource: DataSource;
  let service: TemplateScenesService;
  const createdScenes: string[] = [];

  beforeAll(async () => {
    dataSource = await openSceneTestDb();
    const reads = new SceneReadService(dataSource);
    service = new TemplateScenesService(dataSource, new SceneLockService(dataSource), reads);
  });

  afterAll(async () => {
    await deleteTestScenes(dataSource, createdScenes);
    await dataSource.destroy();
  });

  const track = async (scene: Promise<TemplateScene> | TemplateScene) => {
    const created = await scene;
    createdScenes.push(created.id);
    return created;
  };

  describe('Criar cena', () => {
    it('folheto retrato: tamanho nativo 1920x3840, revision 0 e nenhuma versão', async () => {
      const user = await createTestUser(dataSource);
      const detail = await service.create({ name: 'Páscoa', formatId: 'folheto-27x54' }, user.id);
      createdScenes.push(detail.id);

      expect(detail).toMatchObject({
        name: 'Páscoa',
        formatId: 'folheto-27x54',
        widthPx: 1920,
        heightPx: 3840,
        revision: 0,
        createdByUserId: user.id,
        currentVersion: null,
        activeVersion: null,
        messages: [],
      });
      expect(detail.versions).toMatchObject({ items: [], total: 0 });
      expect(detail.zones.header.h).toBeCloseTo(6 / 54, 6);
      expect(detail.pixelsPerCm).toBeCloseTo(69.8182, 4);
    });

    it.each(['spread-55x55', 'instagram-feed', 'nao-existe'])(
      'formato %s não suportado: 422 e nada é gravado',
      async (formatId) => {
        const name = `Nao suportado ${formatId} ${Date.now()}`;
        const result = await errorOf(service.create({ name, formatId }, null));
        expect(result).toEqual({ status: 422, code: 'SCENE_FORMAT_UNSUPPORTED' });
        expect(await dataSource.manager.countBy(TemplateScene, { name })).toBe(0);
      },
    );
  });

  describe('Listar, abrir e excluir', () => {
    it('lista leve com autor, prévia da versão atual e paginação; prévia apagada vira nula', async () => {
      const user = await createTestUser(dataSource, 'Maria Autora');
      const scene = await track(
        insertScene(dataSource, { name: 'Lista A', createdByUserId: user.id }),
      );
      const ready = await insertReadyVersion(dataSource, scene, 1);
      scene.currentVersionId = ready.version.id;
      await dataSource.manager.save(scene);

      const page = await service.list(1, 50);
      const item = page.data.find((entry) => entry.id === scene.id);
      expect(item).toMatchObject({
        name: 'Lista A',
        createdByName: 'Maria Autora',
        previewUrl: ready.preview.url,
      });
      expect(item).not.toHaveProperty('versions');
      expect(item).not.toHaveProperty('messages');
      expect(page.pagination).toMatchObject({ page: 1, limit: 50 });

      await dataSource.manager.update(
        'template_scene_assets',
        { id: ready.preview.id },
        { purgedAt: new Date() },
      );
      const after = await service.list(1, 50);
      expect(after.data.find((entry) => entry.id === scene.id)?.previewUrl).toBeNull();
    });

    it('a lista respeita o limite da página', async () => {
      await track(insertScene(dataSource, { name: 'Lista B' }));
      await track(insertScene(dataSource, { name: 'Lista C' }));
      const page = await service.list(1, 1);
      expect(page.data).toHaveLength(1);
      expect(page.pagination.total).toBeGreaterThanOrEqual(2);
      expect(page.pagination.totalPages).toBeGreaterThanOrEqual(2);
    });

    it('voltar outro dia: abre a cena com a versão atual, as 3 versões e as 6 mensagens em ordem', async () => {
      const scene = await track(insertScene(dataSource, { name: 'Voltar outro dia' }));
      const v1 = await insertReadyVersion(dataSource, scene, 1);
      await insertReadyVersion(dataSource, scene, 2);
      const v3 = await insertReadyVersion(dataSource, scene, 3);
      scene.currentVersionId = v3.version.id;
      await dataSource.manager.save(scene);
      for (let i = 1; i <= 6; i++) {
        await insertMessage(dataSource, scene.id, {
          content: `mensagem ${i}`,
          role: i % 2 ? 'user' : 'assistant',
          createdAt: new Date(Date.UTC(2026, 10, 3, 10, i)),
        });
      }
      await dataSource.manager.update(
        'template_scene_assets',
        { id: v1.master.id },
        { purgedAt: new Date() },
      );

      const detail = await service.get(scene.id);

      expect(detail.currentVersion?.id).toBe(v3.version.id);
      expect(detail.currentVersion?.master?.url).toBe(v3.master.url);
      expect(detail.versions.items.map((v) => v.number)).toEqual([3, 2, 1]);
      expect(detail.messages.map((m) => m.content)).toEqual(
        [1, 2, 3, 4, 5, 6].map((i) => `mensagem ${i}`),
      );
      const oldest = detail.versions.items.find((v) => v.number === 1);
      expect(oldest).toMatchObject({ restorable: false, restorableReason: 'master_purged' });
      expect(detail.versions.items.find((v) => v.number === 2)?.restorable).toBe(true);
    });

    it('devolve só as 50 últimas mensagens', async () => {
      const scene = await track(insertScene(dataSource, { name: 'Muitas mensagens' }));
      for (let i = 1; i <= 55; i++) {
        await insertMessage(dataSource, scene.id, {
          content: `m${i}`,
          createdAt: new Date(Date.UTC(2026, 10, 3, 10, 0, i)),
        });
      }
      const detail = await service.get(scene.id);
      expect(detail.messages).toHaveLength(50);
      expect(detail.messages[0].content).toBe('m6');
      expect(detail.messages[49].content).toBe('m55');
    });

    it('expõe a versão em curso como activeVersion', async () => {
      const scene = await track(insertScene(dataSource, { name: 'Em curso' }));
      const running = await insertVersion(dataSource, scene.id, {
        number: 1,
        status: 'running',
        step: 'generating',
      });
      const detail = await service.get(scene.id);
      expect(detail.activeVersion).toMatchObject({
        id: running.id,
        status: 'running',
        step: 'generating',
      });
    });

    it('cena inexistente: 404 SCENE_NOT_FOUND', async () => {
      expect(await errorOf(service.get('00000000-0000-4000-8000-000000000000'))).toEqual({
        status: 404,
        code: 'SCENE_NOT_FOUND',
      });
    });

    it('excluir: some da lista, GET dá 404, a revisão sobe e repetir dá 404', async () => {
      const scene = await track(insertScene(dataSource, { name: 'Excluir' }));

      await service.remove(scene.id);

      expect(
        (await service.list(1, 50)).data.find((entry) => entry.id === scene.id),
      ).toBeUndefined();
      expect(await errorOf(service.get(scene.id))).toEqual({
        status: 404,
        code: 'SCENE_NOT_FOUND',
      });
      const row = await dataSource.manager.findOne(TemplateScene, {
        where: { id: scene.id },
        withDeleted: true,
      });
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.revision).toBe(1);
      expect(await errorOf(service.remove(scene.id))).toEqual({
        status: 404,
        code: 'SCENE_NOT_FOUND',
      });
    });

    it('excluir durante a geração marca o cancelamento da versão em curso', async () => {
      const scene = await track(insertScene(dataSource, { name: 'Excluir em curso' }));
      const running = await insertVersion(dataSource, scene.id, {
        number: 1,
        status: 'running',
        step: 'generating',
      });

      await service.remove(scene.id);

      const version = await dataSource.query(
        `SELECT status, "cancelRequestedAt" FROM template_scene_versions WHERE id = $1`,
        [running.id],
      );
      expect(version[0].status).toBe('running');
      expect(version[0].cancelRequestedAt).not.toBeNull();
    });
  });
});
