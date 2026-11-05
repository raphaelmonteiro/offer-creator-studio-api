import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { SceneTurnProcessor } from '../processors/scene-turn.processor';
import { SceneTurnState } from '../processors/scene-turn-state';
import { MockSceneImageProvider } from '../providers/mock-scene-image.provider';
import {
  SceneGenerateInput,
  SceneGenerateResult,
  SceneImageProvider,
} from '../providers/scene-image-provider';
import { SceneFilesService } from '../services/scene-files.service';
import { SceneLockService } from '../services/scene-lock.service';
import { insertMessage, insertScene, insertVersion } from './scene-fixtures';
import { deleteTestScenes, openSceneTestDb } from './scene-test-db';

/**
 * Preparo comum dos specs do `SceneTurnProcessor` (banco `chroma_x_e2e`, arquivos em pasta
 * temporária, mock de latência 0). Chame dentro do `describeIfSceneDb`.
 */
export function useProcessorHarness() {
  const h = {} as {
    dataSource: DataSource;
    uploadsDir: string;
    files: SceneFilesService;
    state: SceneTurnState;
  };
  const createdScenes: string[] = [];

  beforeAll(async () => {
    Logger.overrideLogger(false);
    h.dataSource = await openSceneTestDb();
    h.uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-turn-'));
    h.files = new SceneFilesService(new ConfigService({ UPLOAD_DEST: h.uploadsDir }));
    h.state = new SceneTurnState(new SceneLockService(h.dataSource));
  });

  afterAll(async () => {
    await deleteTestScenes(h.dataSource, createdScenes);
    await h.dataSource.destroy();
    await fs.rm(h.uploadsDir, { recursive: true, force: true });
  });

  const config = (env: Record<string, string> = {}) =>
    new ConfigService({ TEMPLATE_SCENE_MOCK_LATENCY_MS: '0', ...env });

  return Object.assign(h, {
    mock: (env: Record<string, string> = {}) => new MockSceneImageProvider(config(env)),
    processorWith: (provider: SceneImageProvider, env: Record<string, string> = {}) =>
      new SceneTurnProcessor(h.state, h.files, config(env), provider),
    /** Cena folheto 1920x3840 com uma versão `queued` e a mensagem do pedido. */
    async queuedScene(request: string, overrides: Partial<TemplateSceneVersion> = {}) {
      const scene = await insertScene(h.dataSource, { name: `Processor ${request.slice(0, 20)}` });
      createdScenes.push(scene.id);
      const version = await insertVersion(h.dataSource, scene.id, {
        number: 1,
        status: 'queued',
        ...overrides,
      });
      await insertMessage(h.dataSource, scene.id, {
        versionId: version.id,
        content: request,
        status: 'queued',
      });
      return { scene, version };
    },
    trackScene: (id: string) => createdScenes.push(id),
    job: (sceneId: string, versionId: string) => ({ sceneId, versionId }),
    versionOf: (id: string) => h.dataSource.manager.findOneByOrFail(TemplateSceneVersion, { id }),
    sceneOf: (id: string) => h.dataSource.manager.findOneByOrFail(TemplateScene, { id }),
    messagesOf: (sceneId: string) =>
      h.dataSource.manager.find(TemplateSceneMessage, {
        where: { sceneId },
        order: { createdAt: 'ASC' },
      }),
    /** Provedor controlado: devolve o resultado ou lança o erro, e registra as chamadas. */
    fakeProvider(behavior: (input: SceneGenerateInput) => Promise<SceneGenerateResult>) {
      const generate = jest.fn(behavior);
      return { provider: { name: 'mock', generate } as SceneImageProvider, generate };
    },
    okResult: async (costUsd: number | null = 0.1365): Promise<SceneGenerateResult> => ({
      buffer: await sharp({
        create: { width: 1920, height: 3840, channels: 3, background: '#468' },
      })
        .png()
        .toBuffer(),
      usage: null,
      costUsd,
      requestId: 'req_1',
      latencyMs: 1234,
    }),
  });
}
