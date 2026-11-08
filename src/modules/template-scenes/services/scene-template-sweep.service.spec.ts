import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { Template } from '../../templates/entities/template.entity';
import { useSyncHarness } from '../testing/scene-template-sync-harness';
import { insertScene } from '../testing/scene-fixtures';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { fakeQueue } from '../testing/scene-test-helpers';
import { SceneTemplateSweepService } from './scene-template-sweep.service';

describeIfSceneDb('SceneTemplateSweepService (banco chroma_x_e2e)', () => {
  const h = useSyncHarness();
  let queue: ReturnType<typeof fakeQueue>;
  let sweep: SceneTemplateSweepService;

  beforeEach(() => {
    queue = fakeQueue();
    sweep = new SceneTemplateSweepService(h.dataSource, queue.service);
  });

  const queuedIds = () =>
    queue.publish.mock.calls
      .filter(([name]) => name === QUEUES.TEMPLATE_SCENE_TEMPLATE_SYNC)
      .map(([, data]) => (data as { sceneId: string }).sceneId);

  /** Cenas muito antigas passam na frente das que outros specs deixaram no banco. */
  const oldest = (sceneId: string) =>
    h.dataSource.query(`UPDATE template_scenes SET "createdAt" = '2000-01-01' WHERE id = $1`, [
      sceneId,
    ]);

  describe('Backfill das cenas antigas', () => {
    it('enfileira só as cenas com imagem e sem template; sem imagem continua sem; depois do job, não volta', async () => {
      const a = await h.readySmall();
      const b = await h.readySmall();
      const noImage = await h.queuedScene('sem imagem');
      for (const { scene } of [a, b, noImage]) await oldest(scene.id);

      const first = await sweep.sweep();

      expect(first.queued).toBeGreaterThanOrEqual(2);
      expect(queuedIds()).toEqual(expect.arrayContaining([a.scene.id, b.scene.id]));
      expect(queuedIds()).not.toContain(noImage.scene.id);
      const options = queue.publish.mock.calls.find(
        ([, data]) => (data as { sceneId: string }).sceneId === a.scene.id,
      )?.[2];
      expect(options).toEqual({ singletonKey: a.scene.id, retryLimit: 2 });

      await h.sync(a.scene.id);
      await h.sync(b.scene.id);
      queue.publish.mockClear();
      await sweep.sweep();
      expect(queuedIds()).not.toContain(a.scene.id);
      expect(queuedIds()).not.toContain(b.scene.id);
      expect(await h.templatesOf(noImage.scene.id)).toEqual([]);
    });

    it('no máximo `batch` cenas por passada', async () => {
      const scenes = [];
      for (let i = 0; i < 3; i += 1) {
        const { scene } = await h.readySmall();
        await oldest(scene.id);
        scenes.push(scene.id);
      }
      await h.dataSource.query(
        `UPDATE template_scenes SET "createdAt" = '1999-01-01' WHERE id = $1`,
        [scenes[0]],
      );

      const result = await sweep.sweep(1);

      expect(result.queued).toBe(1);
      expect(queuedIds()).toEqual([scenes[0]]);
    });

    it('o lote padrão é de 20 cenas', async () => {
      await sweep.sweep();
      expect(queuedIds().length).toBeLessThanOrEqual(20);
    });
  });

  describe('Template atrás da cena', () => {
    it('em dia: fora; com a revisão da cena à frente: dentro; com o template apagado: dentro', async () => {
      const { scene } = await h.readySmall();
      await oldest(scene.id);
      await h.sync(scene.id);
      await sweep.sweep();
      expect(queuedIds()).not.toContain(scene.id);

      await h.bumpRevision(scene.id);
      await sweep.sweep();
      expect(queuedIds()).toContain(scene.id);

      await h.sync(scene.id);
      queue.publish.mockClear();
      const template = await h.templateOf(scene.id);
      await h.dataSource.manager.delete(Template, { id: template.id });
      await sweep.sweep();
      expect(queuedIds()).toContain(scene.id);
    });
  });

  describe('Falha repetida', () => {
    const failures = (sceneId: string, versionId: string, attempts: number, revision: number) =>
      h.dataSource.query(
        `UPDATE template_scene_versions SET metrics = jsonb_set(metrics, '{templateSync}', $1::jsonb, true) WHERE id = $2`,
        [
          JSON.stringify({ attempts, sceneRevision: revision, error: 'x', failedAt: new Date() }),
          versionId,
        ],
      );

    it('com 3 falhas na revisão atual a cena não é enfileirada; com 2, é', async () => {
      const { scene, version } = await h.readySmall();
      await oldest(scene.id);
      await failures(scene.id, version.id, 2, 0);
      await sweep.sweep();
      expect(queuedIds()).toContain(scene.id);

      queue.publish.mockClear();
      await failures(scene.id, version.id, 3, 0);
      await sweep.sweep();
      expect(queuedIds()).not.toContain(scene.id);
    });

    it('quando a cena muda e a revisão sobe, ela volta a ser tentada', async () => {
      const { scene, version } = await h.readySmall();
      await oldest(scene.id);
      await failures(scene.id, version.id, 3, 0);
      await h.bumpRevision(scene.id);

      await sweep.sweep();

      expect(queuedIds()).toContain(scene.id);
    });
  });

  describe('Exclusão que escapou', () => {
    it('apaga o template da cena excluída e zera o ponteiro', async () => {
      const { scene } = await h.readySmall();
      await h.sync(scene.id);
      const template = await h.templateOf(scene.id);
      await h.dataSource.query(`UPDATE template_scenes SET "deletedAt" = now() WHERE id = $1`, [
        scene.id,
      ]);

      const result = await sweep.sweep();

      expect(result.removed).toBeGreaterThanOrEqual(1);
      expect(await h.templatesOf(scene.id)).toEqual([]);
      const row = await h.dataSource.query(
        `SELECT "approvedTemplateId" FROM template_scenes WHERE id = $1`,
        [scene.id],
      );
      expect(row[0].approvedTemplateId).toBeNull();
      expect(queuedIds()).not.toContain(scene.id);
      expect(template.id).toBeDefined();
    });

    it('não apaga template comum, nem o de outra cena, mesmo que o ponteiro aponte para ele', async () => {
      const common = await h.dataSource.manager.save(
        h.dataSource.manager.create(Template, {
          name: 'Natal',
          type: 'full',
          configuration: { format: 'folheto-27x54' },
        }),
      );
      const scene = await insertScene(h.dataSource, { name: 'Cena apagada' });
      h.trackScene(scene.id);
      await h.dataSource.query(
        `UPDATE template_scenes SET "deletedAt" = now(), "approvedTemplateId" = $1 WHERE id = $2`,
        [common.id, scene.id],
      );

      await sweep.sweep();

      expect(await h.dataSource.manager.findOneBy(Template, { id: common.id })).not.toBeNull();
      await h.dataSource.manager.delete(Template, { id: common.id });
    });

    it('cena viva não perde o template', async () => {
      const { scene } = await h.readySmall();
      await h.sync(scene.id);
      await sweep.sweep();
      expect(await h.templatesOf(scene.id)).toHaveLength(1);
    });
  });
});
