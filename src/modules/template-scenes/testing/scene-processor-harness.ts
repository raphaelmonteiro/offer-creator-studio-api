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
import { SceneAddElementHandler } from '../processors/scene-add-element.handler';
import { SceneCallRunner } from '../processors/scene-call-runner';
import { SceneEditHandler } from '../processors/scene-edit.handler';
import { SceneGenerateHandler } from '../processors/scene-generate.handler';
import { SceneLayerHandler } from '../processors/scene-layer.handler';
import { SceneTurnProcessor } from '../processors/scene-turn.processor';
import { SceneTurnSupport } from '../processors/scene-turn-support';
import { SceneTurnState } from '../processors/scene-turn-state';
import { MockSceneVisionClient } from '../providers/mock-scene-vision.client';
import { SceneVisionClient } from '../providers/scene-vision-client';
import { SceneImageService } from '../services/scene-image.service';
import { SceneVisionService } from '../services/scene-vision.service';
import { MockSceneImageProvider } from '../providers/mock-scene-image.provider';
import {
  SceneEditInput,
  SceneGenerateInput,
  SceneGenerateResult,
  SceneImageProvider,
} from '../providers/scene-image-provider';
import { SceneFilesService } from '../services/scene-files.service';
import { SceneLockService } from '../services/scene-lock.service';
import { SceneClassification } from '../domain/scene-operation.classifier';
import { SceneElement } from '../domain/scene.types';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { buildSceneOutputs } from '../services/scene-output';
import { insertAsset, insertMessage, insertScene, insertVersion } from './scene-fixtures';
import { syntheticScenePng } from './synthetic-scene';
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

  /** Versão `ready` com master e prévia reais em disco (não torna a versão atual). */
  async function readyVersionLike(
    scene: { id: string },
    number: number,
    parentVersionId: string | null,
    masterPng?: Buffer,
    elements: SceneElement[] = [],
  ) {
    const png = masterPng ?? (await syntheticScenePng(1024, 2048));
    const version = await insertVersion(h.dataSource, scene.id, {
      number,
      parentVersionId,
      elements,
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
    /** Processor com todos os tratadores; a visão é o mock (sem custo) a menos que se passe outra. */
    processorWith: (
      provider: SceneImageProvider,
      env: Record<string, string> = {},
      visionClient: SceneVisionClient = new MockSceneVisionClient(),
    ) => {
      const cfg = config(env);
      const support = new SceneTurnSupport(h.state, h.files, cfg);
      const calls = new SceneCallRunner(h.state, cfg);
      const vision = new SceneVisionService(cfg, visionClient);
      const images = new SceneImageService(cfg);
      return new SceneTurnProcessor(
        h.state,
        new SceneGenerateHandler(support, calls, vision, provider),
        new SceneEditHandler(support, calls, images, vision, provider),
        new SceneLayerHandler(support),
        new SceneAddElementHandler(support, calls, provider),
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
      scene.currentVersionId = made.version.id;
      await h.dataSource.manager.save(scene);
      return {
        scene,
        master,
        version: made.version,
        masterAsset: made.masterAsset,
        previewAsset: made.previewAsset,
      };
    },
    /** Versão `queued` filha da atual com o plano já classificado (o que o service grava ao enfileirar). */
    async queueTurn(
      scene: { id: string; currentVersionId: string | null },
      turn: {
        plan: SceneClassification;
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
        operation:
          turn.operation ??
          (turn.plan.operation === 'global_regenerate'
            ? 'generate'
            : (turn.plan.operation as TemplateSceneVersion['operation'])),
        parentVersionId: scene.currentVersionId,
        metrics: { plan: turn.plan },
        ...turn.overrides,
      });
      await insertMessage(h.dataSource, scene.id, {
        versionId: version.id,
        content: turn.request,
        status: 'queued',
        attachments: turn.attachments ?? [],
      });
      return version;
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
     * Provedor controlado: devolve o resultado ou lança o erro, e registra as chamadas. `edit` e
     * `generateTransparent` usam o mesmo comportamento quando não vêm explícitos.
     */
    fakeProvider(
      behavior: (input: SceneGenerateInput) => Promise<SceneGenerateResult>,
      others: {
        edit?: (input: SceneEditInput) => Promise<SceneGenerateResult>;
        transparent?: (input: SceneGenerateInput) => Promise<SceneGenerateResult>;
      } = {},
    ) {
      const generate = jest.fn(behavior);
      const edit = jest.fn<Promise<SceneGenerateResult>, [SceneEditInput]>(others.edit ?? behavior);
      const generateTransparent = jest.fn(others.transparent ?? behavior);
      return {
        provider: { name: 'mock', generate, edit, generateTransparent } as SceneImageProvider,
        generate,
        edit,
        generateTransparent,
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
