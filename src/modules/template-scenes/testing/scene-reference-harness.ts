import * as sharp from 'sharp';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { MockSceneVisionClient } from '../providers/mock-scene-vision.client';
import { CONCEPT_PROMPT_START } from '../providers/mock-scene-reference-concept';
import { SceneVisionClient } from '../providers/scene-vision-client';
import { SceneLockService } from '../services/scene-lock.service';
import { SceneReferenceService } from '../services/scene-reference.service';
import { readOf } from '../services/scene-reference-state';
import { SceneTurnService } from '../services/scene-turn.service';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { insertScene } from './scene-fixtures';
import { useProcessorHarness } from './scene-processor-harness';
import { fakeQueue } from './scene-test-helpers';

/** Formatos do estudo: nome, formato, tamanho nativo e layout. */
export const SCENE_27X40 = {
  formatId: 'folheto-27x40',
  artWidthCm: 27.5,
  artHeightCm: 41,
  widthPx: 2352,
  heightPx: 3504,
};
export const SCENE_TABLOID = {
  formatId: 'folheto-54x40',
  artWidthCm: 55,
  artHeightCm: 41,
  widthPx: 3328,
  heightPx: 2480,
  layout: 'tabloid' as const,
};

/** JPEG sólido para o envio. */
export const jpeg = (width: number, height: number): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: '#2a5' } })
    .jpeg()
    .toBuffer();

export const uploadedFile = async (name = 'junina.jpg', size: [number, number] = [1200, 1800]) => {
  const buffer = await jpeg(...size);
  return { buffer, mimetype: 'image/jpeg', size: buffer.length, originalname: name };
};

/**
 * Cliente de visão que responde ao prompt da ficha com o JSON dado (ou com o texto/erro de `reply`) e ao juiz como o
 * `MockSceneVisionClient`. Registra os prompts recebidos.
 */
export function conceptVision(
  reply: (prompt: string) => unknown | Promise<unknown>,
  usage = { prompt_tokens: 2355, completion_tokens: 1210 },
) {
  const judge = new MockSceneVisionClient();
  const prompts: string[] = [];
  const compare = jest.fn(async (input: Parameters<SceneVisionClient['compare']>[0]) => {
    if (!input.prompt.startsWith(CONCEPT_PROMPT_START)) return judge.compare(input);
    prompts.push(input.prompt);
    const body = await reply(input.prompt);
    return {
      text: typeof body === 'string' ? body : JSON.stringify(body),
      usage,
      requestId: 'req_ficha',
      latencyMs: 5,
    };
  });
  return { client: { compare } as SceneVisionClient, compare, prompts };
}

/** Preparo do envio, da leitura e da geração por referência: banco `chroma_x_e2e`, fila falsa e o worker real. */
export function useReferenceHarness() {
  const h = useProcessorHarness();
  const queue = fakeQueue();
  const make = () => {
    const locks = new SceneLockService(h.dataSource);
    const service = new SceneReferenceService(
      h.dataSource,
      locks,
      queue.service as AnimationQueueService,
      h.files,
    );
    const turns = new SceneTurnService(h.dataSource, locks, queue.service as AnimationQueueService);
    return { service, turns };
  };
  beforeEach(() => queue.publish.mockClear());

  return Object.assign(h, {
    publish: queue.publish,
    api: () => make().service,
    turns: () => make().turns,
    async newScene(overrides: Partial<TemplateScene> = SCENE_27X40) {
      const scene = await insertScene(h.dataSource, { name: 'Referência', ...overrides });
      h.trackScene(scene.id);
      return scene;
    },
    async revisionOf(sceneId: string): Promise<number> {
      return (await h.sceneOf(sceneId)).revision;
    },
    /** Envia o encarte com a revisão atual da cena. */
    async upload(sceneId: string, name?: string, size?: [number, number]) {
      return make().service.upload(sceneId, await uploadedFile(name, size), {
        expectedRevision: String(await h.sceneOf(sceneId).then((s) => s.revision)),
        userId: null,
      });
    },
    /** Roda o job `template_scene.turn` da versão com o provedor e a visão dados. */
    async run(
      sceneId: string,
      versionId: string,
      using: { vision?: SceneVisionClient; provider?: ReturnType<typeof h.fakeProvider> } = {},
    ) {
      const fake = using.provider ?? h.fakeProvider(async () => h.okResult(0.14));
      await h.processorWith(fake.provider, {}, using.vision).process({ sceneId, versionId });
      return fake;
    },
    /** Envia e lê o encarte: devolve a leitura `proposed` (visão do mock, ou a dada). */
    async proposed(scene: TemplateScene, vision?: SceneVisionClient) {
      const sent = await this.upload(scene.id);
      await this.run(scene.id, sent.versionId, { vision });
      return sent;
    },
    /** Cena com a ficha do mock proposta, pronta para gerar. */
    async proposedScene(overrides?: Partial<TemplateScene>) {
      const scene = await this.newScene(overrides);
      const read = await this.proposed(scene);
      return { scene, read, revision: await this.revisionOf(scene.id) };
    },
    revise: (sceneId: string, revision: number, note: string) =>
      make().service.revise(sceneId, { expectedRevision: revision, note, userId: null }),
    generate: (sceneId: string, revision: number) =>
      make().service.generate(sceneId, { expectedRevision: revision, userId: null }),
    async versions(sceneId: string): Promise<TemplateSceneVersion[]> {
      return h.dataSource.manager.find(TemplateSceneVersion, {
        where: { sceneId },
        order: { number: 'ASC' },
      });
    },
    async referenceState(versionId: string) {
      return readOf(await h.versionOf(versionId));
    },
    assetsOf: (sceneId: string, role: string) =>
      h.dataSource.manager.find(TemplateSceneAsset, { where: { sceneId, role: role as never } }),
  });
}
