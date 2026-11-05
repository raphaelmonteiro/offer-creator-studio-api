import { DataSource } from 'typeorm';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { SceneLockService } from '../services/scene-lock.service';
import { SceneTurnService } from '../services/scene-turn.service';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { insertReadyVersion, insertScene } from './scene-fixtures';
import { deleteTestScenes, openSceneTestDb } from './scene-test-db';

export interface TurnServiceHarness {
  dataSource: DataSource;
  service: SceneTurnService;
  publish: jest.Mock;
  /** Cena sem versão. */
  newScene(name: string): Promise<TemplateScene>;
  /** Cena com a versão 1 pronta (revisão 0). */
  readyScene(name: string, elements?: TemplateSceneVersion['elements']): Promise<TemplateScene>;
  send(
    sceneId: string,
    body: Record<string, unknown>,
    revision?: number,
  ): ReturnType<SceneTurnService['sendMessage']>;
  versionsOf(sceneId: string): Promise<TemplateSceneVersion[]>;
  sceneOf(id: string): Promise<TemplateScene>;
}

/** Banco, serviço do turno com a fila falsa e atalhos de cena, para as specs do envio de mensagem. */
export function useTurnServiceHarness(): TurnServiceHarness {
  const createdScenes: string[] = [];
  const h = {} as TurnServiceHarness;

  beforeAll(async () => {
    h.dataSource = await openSceneTestDb();
  });
  beforeEach(() => {
    h.publish = jest.fn(async () => `job-${h.publish.mock.calls.length}`);
    h.service = new SceneTurnService(h.dataSource, new SceneLockService(h.dataSource), {
      publish: h.publish,
    } as unknown as AnimationQueueService);
  });
  afterAll(async () => {
    await deleteTestScenes(h.dataSource, createdScenes);
    await h.dataSource.destroy();
  });

  h.newScene = async (name) => {
    const scene = await insertScene(h.dataSource, { name });
    createdScenes.push(scene.id);
    return scene;
  };
  h.readyScene = async (name, elements = []) => {
    const scene = await h.newScene(name);
    const { version } = await insertReadyVersion(h.dataSource, scene, 1, { elements });
    scene.currentVersionId = version.id;
    await h.dataSource.manager.save(scene);
    return scene;
  };
  h.send = (sceneId, body, revision = 0) =>
    h.service.sendMessage(
      sceneId,
      { content: 'x', expectedRevision: revision, ...body } as never,
      null,
    );
  h.versionsOf = (sceneId) =>
    h.dataSource.manager.find(TemplateSceneVersion, {
      where: { sceneId },
      order: { number: 'ASC' },
    });
  h.sceneOf = (id) => h.dataSource.manager.findOneByOrFail(TemplateScene, { id });
  return h;
}
