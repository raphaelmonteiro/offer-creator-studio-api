import { DataSource } from 'typeorm';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import {
  insertAsset,
  insertReadyVersion,
  insertScene,
  insertVersion,
  insertMessage,
} from '../testing/scene-fixtures';
import { errorBodyOf, errorOf, textElement } from '../testing/scene-test-helpers';
import { deleteTestScenes, describeIfSceneDb, openSceneTestDb } from '../testing/scene-test-db';
import { SceneLockService } from './scene-lock.service';
import { SceneReadService } from './scene-read.service';
import { SceneVersionsService } from './scene-versions.service';

describeIfSceneDb('SceneVersionsService (banco chroma_x_e2e)', () => {
  let dataSource: DataSource;
  let service: SceneVersionsService;
  const createdScenes: string[] = [];

  beforeAll(async () => {
    dataSource = await openSceneTestDb();
    service = new SceneVersionsService(
      dataSource,
      new SceneLockService(dataSource),
      new SceneReadService(dataSource),
    );
  });

  afterAll(async () => {
    await deleteTestScenes(dataSource, createdScenes);
    await dataSource.destroy();
  });

  /** Cena com `count` versões ready (cada uma com master própria); a última é a atual. */
  async function sceneWithVersions(name: string, count: number) {
    const scene = await insertScene(dataSource, { name });
    createdScenes.push(scene.id);
    const ready = [];
    for (let number = 1; number <= count; number++) {
      ready.push(await insertReadyVersion(dataSource, scene, number));
    }
    scene.currentVersionId = ready[count - 1].version.id;
    await dataSource.manager.save(scene);
    return { scene, ready };
  }

  const versionsOf = (sceneId: string) =>
    dataSource.manager.find(TemplateSceneVersion, { where: { sceneId }, order: { number: 'ASC' } });
  const revisionOf = async (sceneId: string) =>
    (await dataSource.manager.findOneByOrFail(TemplateScene, { id: sceneId })).revision;

  describe('restore', () => {
    it('Voltar pelo botão: restaura uma versão que o juiz reprovou, sem custo de imagem novo', async () => {
      const { scene, ready } = await sceneWithVersions('Restore não aplicada', 2);
      const attempt = await insertReadyVersion(dataSource, scene, 3, {
        metrics: { judge: { available: true, satisfied: 'nao' } },
        providerCostUsd: 0.05,
      });

      const detail = await service.restore(scene.id, attempt.version.id, null);

      expect(detail.currentVersion).toMatchObject({
        operation: 'restore',
        providerCostUsd: 0,
        parentVersionId: attempt.version.id,
      });
      expect(detail.currentVersion?.master?.id).toBe(attempt.master.id);
      expect(ready).toHaveLength(2);
      expect((await versionsOf(scene.id)).map((v) => v.number)).toEqual([1, 2, 3, 4]);
    });

    it('restaurar a versão 1 cria a versão 4 com a imagem da 1 e mantém as outras e as mensagens', async () => {
      const { scene, ready } = await sceneWithVersions('Restore ok', 3);
      ready[0].version.elements = [textElement('t1')] as never;
      await dataSource.manager.save(ready[0].version);
      await insertMessage(dataSource, scene.id, { content: 'oi' });

      const detail = await service.restore(scene.id, ready[0].version.id, null);

      const versions = await versionsOf(scene.id);
      expect(versions.map((v) => v.number)).toEqual([1, 2, 3, 4]);
      const restored = versions[3];
      expect(restored).toMatchObject({
        operation: 'restore',
        status: 'ready',
        parentVersionId: ready[0].version.id,
        masterAssetId: ready[0].master.id,
        previewAssetId: ready[0].preview.id,
        providerCostUsd: 0,
      });
      expect(restored.elements).toEqual(ready[0].version.elements);
      expect(detail.currentVersion?.id).toBe(restored.id);
      expect(detail.revision).toBe(1);
      expect(detail.messages).toHaveLength(1);
      expect(detail.versions.total).toBe(4);
    });

    it('master apagada: 410 VERSION_NOT_RESTORABLE com o motivo e nenhuma versão criada', async () => {
      const { scene, ready } = await sceneWithVersions('Restore 410', 3);
      await dataSource.manager.update(
        'template_scene_assets',
        { id: ready[0].master.id },
        { purgedAt: new Date() },
      );

      const error = await errorOf(service.restore(scene.id, ready[0].version.id, null));

      expect(error).toEqual({ status: 410, code: 'VERSION_NOT_RESTORABLE' });
      expect(await versionsOf(scene.id)).toHaveLength(3);
      expect(await revisionOf(scene.id)).toBe(0);
    });

    it('a mensagem do 410 traz details.reason master_purged', async () => {
      const { scene, ready } = await sceneWithVersions('Restore 410 detalhe', 2);
      await dataSource.manager.update(
        'template_scene_assets',
        { id: ready[0].master.id },
        { purgedAt: new Date() },
      );
      const body = await errorBodyOf(service.restore(scene.id, ready[0].version.id, null));
      expect(body.details).toEqual({ reason: 'master_purged' });
      expect(String(body.message)).toContain('20 versões mais recentes');
    });

    it('com versão em curso: 409 SCENE_BUSY', async () => {
      const { scene, ready } = await sceneWithVersions('Restore ocupada', 2);
      await insertVersion(dataSource, scene.id, {
        number: 3,
        status: 'running',
        step: 'generating',
      });
      expect(await errorOf(service.restore(scene.id, ready[0].version.id, null))).toEqual({
        status: 409,
        code: 'SCENE_BUSY',
      });
    });

    it('revisão antiga: 409 REVISION_CONFLICT', async () => {
      const { scene, ready } = await sceneWithVersions('Restore revisão', 2);
      expect(await errorOf(service.restore(scene.id, ready[0].version.id, null, 5))).toEqual({
        status: 409,
        code: 'REVISION_CONFLICT',
      });
    });

    it('versão de outra cena e versão que não está pronta', async () => {
      const a = await sceneWithVersions('Restore A', 1);
      const b = await sceneWithVersions('Restore B', 1);
      expect(await errorOf(service.restore(a.scene.id, b.ready[0].version.id, null))).toEqual({
        status: 404,
        code: 'VERSION_NOT_FOUND',
      });
      const failed = await insertVersion(dataSource, a.scene.id, { number: 2, status: 'failed' });
      expect(await errorOf(service.restore(a.scene.id, failed.id, null))).toEqual({
        status: 422,
        code: 'VERSION_NOT_READY',
      });
    });

    it('fecha a versão manual aberta', async () => {
      const { scene, ready } = await sceneWithVersions('Restore fecha manual', 2);
      await service.patchElements(
        scene.id,
        { expectedRevision: 0, elements: [textElement('t')] },
        null,
      );
      expect((await versionsOf(scene.id)).filter((v) => v.isOpenManual)).toHaveLength(1);

      await service.restore(scene.id, ready[0].version.id, null);

      expect((await versionsOf(scene.id)).filter((v) => v.isOpenManual)).toHaveLength(0);
    });

    it('dois restores ao mesmo tempo com a mesma revisão: um vence, o outro dá 409', async () => {
      const { scene, ready } = await sceneWithVersions('Restore concorrente', 3);
      const results = await Promise.allSettled([
        service.restore(scene.id, ready[0].version.id, null, 0),
        service.restore(scene.id, ready[1].version.id, null, 0),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason.getResponse().code).toBe('REVISION_CONFLICT');
      expect(await versionsOf(scene.id)).toHaveLength(4);
    });
  });

  describe('PATCH elements', () => {
    it('cria a versão manual aberta apontando para a master da atual', async () => {
      const { scene, ready } = await sceneWithVersions('Patch cria', 1);

      const detail = await service.patchElements(
        scene.id,
        { expectedRevision: 0, elements: [textElement('t1')] },
        null,
      );

      const manual = (await versionsOf(scene.id)).find((v) => v.operation === 'manual');
      expect(manual).toMatchObject({
        status: 'ready',
        isOpenManual: true,
        number: 2,
        parentVersionId: ready[0].version.id,
        masterAssetId: ready[0].master.id,
        previewAssetId: ready[0].preview.id,
      });
      expect(detail.currentVersion?.id).toBe(manual?.id);
      expect(detail.currentVersion?.elements).toHaveLength(1);
      expect(detail.revision).toBe(1);
    });

    it('ajustes seguidos acumulam numa só versão manual aberta', async () => {
      const { scene } = await sceneWithVersions('Patch acumula', 1);

      await service.patchElements(
        scene.id,
        { expectedRevision: 0, elements: [textElement('t', { x: 0.2 })] },
        null,
      );
      const second = await service.patchElements(
        scene.id,
        { expectedRevision: 1, elements: [textElement('t', { x: 0.2, fontFamily: 'Anton' })] },
        null,
      );

      const manuals = (await versionsOf(scene.id)).filter((v) => v.operation === 'manual');
      expect(manuals).toHaveLength(1);
      expect(manuals[0].elements[0]).toMatchObject({ x: 0.2, fontFamily: 'Anton' });
      expect(second.revision).toBe(2);
    });

    it('Camada antiga: um elemento generated gravado antes continua na lista e continua arrastável', async () => {
      const old = {
        id: 'gen-1',
        kind: 'generated',
        name: 'Balão 1',
        x: 0.3,
        y: 0.4,
        w: 0.2,
        aspect: 1,
        rotation: 0,
        z: 1,
      } as const;
      const scene = await insertScene(dataSource, { name: 'Camada antiga' });
      createdScenes.push(scene.id);
      const made = await insertReadyVersion(dataSource, scene, 1, { elements: [old] });
      scene.currentVersionId = made.version.id;
      await dataSource.manager.save(scene);

      const opened = await new SceneReadService(dataSource).loadDetail(scene.id);
      expect(opened.currentVersion?.elements).toEqual([old]);

      const detail = await service.patchElements(
        scene.id,
        { expectedRevision: 0, elements: [{ ...old, x: 0.7 }] as never },
        null,
      );
      expect(detail.currentVersion?.elements).toEqual([{ ...old, x: 0.7 }]);
    });

    it('revisão antiga: 409 REVISION_CONFLICT', async () => {
      const { scene } = await sceneWithVersions('Patch revisão', 1);
      expect(
        await errorOf(service.patchElements(scene.id, { expectedRevision: 3, elements: [] }, null)),
      ).toEqual({ status: 409, code: 'REVISION_CONFLICT' });
    });

    it('cena ocupada: 409 SCENE_BUSY', async () => {
      const { scene } = await sceneWithVersions('Patch ocupada', 1);
      await insertVersion(dataSource, scene.id, { number: 2, status: 'queued' });
      expect(
        await errorOf(service.patchElements(scene.id, { expectedRevision: 0, elements: [] }, null)),
      ).toEqual({ status: 409, code: 'SCENE_BUSY' });
    });

    it('cena sem imagem: 422 NO_CURRENT_VERSION', async () => {
      const scene = await insertScene(dataSource, { name: 'Patch sem imagem' });
      createdScenes.push(scene.id);
      expect(
        await errorOf(service.patchElements(scene.id, { expectedRevision: 0, elements: [] }, null)),
      ).toEqual({ status: 422, code: 'NO_CURRENT_VERSION' });
    });

    it('aceita o logo da própria cena e recusa asset de outra cena, apagado ou de papel errado', async () => {
      const a = await sceneWithVersions('Patch logo A', 1);
      const b = await sceneWithVersions('Patch logo B', 1);
      const logo = await insertAsset(dataSource, a.ready[0].version, 'logo');
      const foreign = await insertAsset(dataSource, b.ready[0].version, 'logo');
      const purged = await insertAsset(dataSource, a.ready[0].version, 'logo', {
        purgedAt: new Date(),
      });
      const logoEl = (assetId: string) => textElement('logo', { kind: 'logo', assetId });

      const ok = await service.patchElements(
        a.scene.id,
        { expectedRevision: 0, elements: [logoEl(logo.id)] },
        null,
      );
      expect(ok.currentVersion?.assets.map((x) => x.id)).toContain(logo.id);

      for (const asset of [foreign, purged, a.ready[0].master]) {
        expect(
          await errorOf(
            service.patchElements(
              a.scene.id,
              { expectedRevision: 1, elements: [logoEl(asset.id)] },
              null,
            ),
          ),
        ).toEqual({ status: 422, code: 'ASSET_NOT_IN_SCENE' });
      }
      expect(await revisionOf(a.scene.id)).toBe(1);
    });
  });
});
