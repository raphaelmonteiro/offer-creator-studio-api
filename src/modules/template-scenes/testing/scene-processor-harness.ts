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
import { SceneCallRunner } from '../processors/scene-call-runner';
import { SceneDeriveFaceHandler } from '../processors/scene-derive-face.handler';
import { SceneRedrawHandler } from '../processors/scene-redraw.handler';
import { MockSceneVisionClient } from '../providers/mock-scene-vision.client';
import { SceneVisionClient } from '../providers/scene-vision-client';
import { SceneVisionService } from '../services/scene-vision.service';
import { SceneTurnProcessor } from '../processors/scene-turn.processor';
import { SceneTurnSupport } from '../processors/scene-turn-support';
import { SceneTurnState } from '../processors/scene-turn-state';
import { MockSceneImageProvider } from '../providers/mock-scene-image.provider';
import {
  SceneEditInput,
  SceneGenerateInput,
  SceneGenerateResult,
  SceneImageProvider,
} from '../providers/scene-image-provider';
import { SceneFilesService } from '../services/scene-files.service';
import { SceneLockService } from '../services/scene-lock.service';
import { DirectorPlan } from '../domain/scene-director-schema';
import { SceneElement } from '../domain/scene.types';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { buildSceneOutputs } from '../services/scene-output';
import { directorPlan } from './scene-director-fixtures';
import {
  insertAsset,
  insertMessage,
  insertScene,
  insertVersion,
  pointFace,
} from './scene-fixtures';
import { syntheticScenePng } from './synthetic-scene';
import { deleteTestScenes, openSceneTestDb } from './scene-test-db';
import { fakeQueue } from './scene-test-helpers';

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
    /** Fila falsa do `SceneTurnState`: recebe o job de sincronização do template quando a imagem fica pronta. */
    syncQueue: ReturnType<typeof fakeQueue>;
  };
  const createdScenes: string[] = [];

  beforeAll(async () => {
    Logger.overrideLogger(false);
    h.dataSource = await openSceneTestDb();
    h.uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-turn-'));
    h.files = new SceneFilesService(new ConfigService({ UPLOAD_DEST: h.uploadsDir }));
    h.syncQueue = fakeQueue();
    h.state = new SceneTurnState(new SceneLockService(h.dataSource), h.syncQueue.service);
  });

  beforeEach(() => h.syncQueue.publish.mockClear());

  afterAll(async () => {
    await deleteTestScenes(h.dataSource, createdScenes);
    await h.dataSource.destroy();
    await fs.rm(h.uploadsDir, { recursive: true, force: true });
  });

  /** Versão `ready` com master e prévia reais em disco (não torna a versão atual). */
  async function readyVersionLike(
    scene: { id: string },
    number: number,
    parentVersionId: string | null,
    masterPng?: Buffer,
    elements: SceneElement[] = [],
    extra: Partial<TemplateSceneVersion> = {},
  ) {
    const png = masterPng ?? (await syntheticScenePng(1024, 2048));
    const version = await insertVersion(h.dataSource, scene.id, {
      number,
      parentVersionId,
      elements,
      ...extra,
    });
    const outputs = await buildSceneOutputs(png);
    const assets: TemplateSceneAsset[] = [];
    for (const [role, file] of [
      ['master', outputs.master],
      ['preview', outputs.preview],
    ] as const) {
      const written = await h.files.write(scene.id, version.id, file.filename, file.buffer);
      assets.push(
        await insertAsset(h.dataSource, version, role, {
          url: written.url,
          width: file.width,
          height: file.height,
          bytes: written.bytes,
        }),
      );
    }
    version.masterAssetId = assets[0].id;
    version.previewAssetId = assets[1].id;
    await h.dataSource.manager.save(version);
    return { version, masterAsset: assets[0], previewAsset: assets[1] };
  }

  const config = (env: Record<string, string> = {}) =>
    new ConfigService({ TEMPLATE_SCENE_MOCK_LATENCY_MS: '0', ...env });

  return Object.assign(h, {
    mock: (env: Record<string, string> = {}) => new MockSceneImageProvider(config(env)),
    /** Processor do job de imagem com o provedor dado. */
    processorWith: (
      provider: SceneImageProvider,
      env: Record<string, string> = {},
      visionClient: SceneVisionClient = new MockSceneVisionClient(),
    ) => {
      const cfg = config(env);
      const support = new SceneTurnSupport(h.state, h.files, cfg);
      const calls = new SceneCallRunner(h.state, cfg);
      const vision = new SceneVisionService(cfg, visionClient);
      return new SceneTurnProcessor(
        h.state,
        new SceneRedrawHandler(support, calls, vision, provider),
        new SceneDeriveFaceHandler(support, calls, provider),
      );
    },
    /** Cena folheto 1920x3840 com uma versão `queued` e a mensagem do pedido. */
    async queuedScene(request: string, overrides: Partial<TemplateSceneVersion> = {}) {
      const scene = await insertScene(h.dataSource, { name: `Processor ${request.slice(0, 20)}` });
      createdScenes.push(scene.id);
      const version = await insertVersion(h.dataSource, scene.id, {
        number: 1,
        status: 'queued',
        ...overrides,
        metrics: {
          plan: directorPlan({
            turn_kind: 'imagem_nova',
            will_change_image: true,
            what_to_put: request,
          }),
          ...overrides.metrics,
        },
      });
      await insertMessage(h.dataSource, scene.id, {
        versionId: version.id,
        content: request,
        status: 'queued',
      });
      return { scene, version };
    },
    /**
     * Cena com a versão 1 `ready` e a master em disco (PNG sintético `width x height`, proporção do
     * folheto), pronta para receber um pedido de edição.
     */
    readyVersionLike,
    async readyScene(options: { width?: number; height?: number; elements?: SceneElement[] } = {}) {
      const width = options.width ?? 1024;
      const height = options.height ?? 2048;
      const scene = await insertScene(h.dataSource, {
        name: 'Processor edição',
        widthPx: width,
        heightPx: height,
      });
      createdScenes.push(scene.id);
      const master = await syntheticScenePng(width, height);
      const made = await readyVersionLike(scene, 1, null, master, options.elements ?? []);
      await pointFace(h.dataSource, scene, made.version.id);
      return {
        scene,
        master,
        version: made.version,
        masterAsset: made.masterAsset,
        previewAsset: made.previewAsset,
      };
    },
    /** Versão `queued` filha da atual, com o plano do Diretor já gravado (o que o consumer do Diretor deixa). */
    async queueRedraw(
      scene: { id: string; currentVersionId: string | null },
      turn: {
        plan: DirectorPlan;
        request: string;
        number?: number;
        operation?: TemplateSceneVersion['operation'];
        overrides?: Partial<TemplateSceneVersion>;
        attachments?: Array<{ assetId: string }>;
      },
    ) {
      const version = await insertVersion(h.dataSource, scene.id, {
        number: turn.number ?? 2,
        status: 'queued',
        operation: turn.operation ?? 'redraw',
        parentVersionId: scene.currentVersionId,
        ...turn.overrides,
        metrics: { plan: turn.plan, ...turn.overrides?.metrics },
      });
      await insertMessage(h.dataSource, scene.id, {
        versionId: version.id,
        content: turn.request,
        status: 'queued',
        attachments: turn.attachments ?? [],
      });
      return version;
    },
    /**
     * Grava a lista do que o cliente pediu. `sourceMessageId: 'turn'` vira a mensagem do cliente da versão (item do
     * turno, D-59); qualquer outro valor fica como está (item de outro turno).
     */
    async setBrief(sceneId: string, versionId: string, brief: TemplateScene['brief']) {
      const message = await h.dataSource.manager.findOneByOrFail(TemplateSceneMessage, {
        versionId,
        role: 'user',
      });
      await h.dataSource.manager.update(
        TemplateScene,
        { id: sceneId },
        {
          brief: brief.map((item) =>
            item.sourceMessageId === 'turn' ? { ...item, sourceMessageId: message.id } : item,
          ),
        },
      );
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
    /**
     * Provedor controlado: devolve o resultado ou lança o erro, e registra as chamadas. `edit` usa o mesmo
     * comportamento quando não vem explícito.
     */
    fakeProvider(
      behavior: (input: SceneGenerateInput) => Promise<SceneGenerateResult>,
      others: {
        edit?: (input: SceneEditInput) => Promise<SceneGenerateResult>;
      } = {},
    ) {
      const generate = jest.fn(behavior);
      const edit = jest.fn<Promise<SceneGenerateResult>, [SceneEditInput]>(others.edit ?? behavior);
      return {
        provider: { name: 'mock', generate, edit } as SceneImageProvider,
        generate,
        edit,
      };
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
