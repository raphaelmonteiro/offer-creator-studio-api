import { DataSource } from 'typeorm';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { insertReadyVersion, insertScene } from '../testing/scene-fixtures';
import { textElement } from '../testing/scene-test-helpers';
import { deleteTestScenes, describeIfSceneDb, openSceneTestDb } from '../testing/scene-test-db';
import { SceneLockService } from './scene-lock.service';
import { SceneReadService } from './scene-read.service';
import { SceneVersionsService } from './scene-versions.service';

const PROMO = [{ text: 'Promoção de Páscoa', zone: 'footer' }];
const OFERTA = [{ text: 'Oferta de Páscoa', zone: 'footer' }];

/** `metrics.paintedText` nas versões que não chamam o modelo de imagem: restaurar e mexer na camada à mão (R66). */
describeIfSceneDb('Texto pintado nas versões do REST (banco chroma_x_e2e)', () => {
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

  async function sceneWithTwo(name: string, paintedByVersion: unknown[][]) {
    const scene = await insertScene(dataSource, { name });
    createdScenes.push(scene.id);
    const ready = [];
    for (const [index, lines] of paintedByVersion.entries()) {
      ready.push(
        await insertReadyVersion(dataSource, scene, index + 1, {
          metrics: { paintedText: lines },
        }),
      );
    }
    scene.currentVersionId = ready[ready.length - 1].version.id;
    await dataSource.manager.save(scene);
    return { scene, ready };
  }

  const versionsOf = (sceneId: string) =>
    dataSource.manager.find(TemplateSceneVersion, { where: { sceneId }, order: { number: 'ASC' } });

  it('Texto pintado volta com o desfazer pelo botão: a restauração copia o campo da origem', async () => {
    const { scene, ready } = await sceneWithTwo('Restore texto pintado', [PROMO, OFERTA]);

    await service.restore(scene.id, ready[0].version.id, null);

    const restored = (await versionsOf(scene.id))[2];
    expect(restored.operation).toBe('restore');
    expect(restored.metrics.paintedText).toEqual(PROMO);
  });

  it('Texto pintado sobrevive à camada à mão: a versão manual copia o campo da atual', async () => {
    const { scene } = await sceneWithTwo('Patch texto pintado', [PROMO]);

    await service.patchElements(
      scene.id,
      { expectedRevision: 0, elements: [textElement('t1')] },
      null,
    );

    const manual = (await versionsOf(scene.id)).find((v) => v.operation === 'manual');
    expect(manual?.metrics.paintedText).toEqual(PROMO);
  });

  it('versão sem texto pintado não ganha o campo na restauração nem na camada à mão', async () => {
    const { scene, ready } = await sceneWithTwo('Restore sem texto', [[], []]);
    await service.restore(scene.id, ready[0].version.id, null);
    await service.patchElements(
      scene.id,
      { expectedRevision: 1, elements: [textElement('t1')] },
      null,
    );
    const versions = await versionsOf(scene.id);
    expect(versions[2].metrics.paintedText).toBeUndefined();
    expect(versions[3].metrics.paintedText).toBeUndefined();
  });
});
