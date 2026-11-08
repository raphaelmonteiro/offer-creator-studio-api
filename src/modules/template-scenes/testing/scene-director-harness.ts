import { ConfigService } from '@nestjs/config';
import { TemplateScene } from '../entities/template-scene.entity';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { SceneDirectorProcessor } from '../processors/scene-director.processor';
import { SceneDirectorState } from '../processors/scene-director-state';
import { SceneDirectorClient, SceneDirectorCall } from '../providers/scene-director-client';
import { SceneDirectorContextService } from '../services/scene-director-context';
import { SceneDirectorService } from '../services/scene-director.service';
import { SceneLockService } from '../services/scene-lock.service';
import { SceneTurnService } from '../services/scene-turn.service';
import { directorPlan, PlanOverrides } from './scene-director-fixtures';
import { insertScene } from './scene-fixtures';
import { useProcessorHarness } from './scene-processor-harness';

/** Custo de uma chamada do Diretor com o `usage` padrão dos testes (2.600 de entrada, 350 de saída). */
export const DIRECTOR_USAGE = { input_tokens: 2600, output_tokens: 350 };
export const DIRECTOR_CALL_COST = 0.000435;

/** Resposta do cliente do Diretor com o plano em JSON, como o provedor devolve. */
export const directorAnswer = (
  plan: PlanOverrides | string,
  usage: object | null = DIRECTOR_USAGE,
) => ({
  text: typeof plan === 'string' ? plan : JSON.stringify(directorPlan(plan)),
  usage,
  requestId: 'req_dir',
  latencyMs: 12,
});

/**
 * Banco, fila falsa, POST real, Diretor com cliente controlado e a fila de imagem falsa: o que os specs do
 * consumer do Diretor precisam. Chame dentro do `describeIfSceneDb`.
 */
type Respond = (
  call: SceneDirectorCall,
  attempt: number,
) => Promise<ReturnType<typeof directorAnswer>>;

export interface TurnOptions {
  extra?: Record<string, unknown>;
  brief?: TemplateScene['brief'];
  env?: Record<string, string>;
  /** Cena sem imagem (a primeira mensagem), em vez da cena com a versão 1 pronta. */
  noImage?: boolean;
}

export function useDirectorHarness() {
  const base = useProcessorHarness();
  const queue = {
    publish: jest.fn<Promise<string>, [string, Record<string, unknown>, Record<string, unknown>?]>(
      async () => `job-${Date.now()}-${Math.random()}`,
    ),
  };
  const queueService = queue as unknown as AnimationQueueService;

  const build = (
    client: SceneDirectorClient,
    env: Record<string, string> = {},
    publish: AnimationQueueService = queueService,
  ) => {
    const config = new ConfigService({ TEMPLATE_SCENE_MOCK_LATENCY_MS: '0', ...env });
    const locks = new SceneLockService(base.dataSource);
    const state = new SceneDirectorState(locks, publish, config, base.files);
    const contexts = new SceneDirectorContextService(base.dataSource, base.files);
    return new SceneDirectorProcessor(state, contexts, new SceneDirectorService(config, client));
  };

  beforeEach(() => {
    queue.publish.mockClear();
  });

  const directorClient = (respond: Respond) => {
    let attempt = 0;
    const plan = jest.fn((call: SceneDirectorCall) => {
      attempt += 1;
      return respond(call, attempt);
    });
    return { client: { plan } as SceneDirectorClient, plan };
  };

  const post = async (sceneId: string, content: string, extra: Record<string, unknown> = {}) => {
    const scene = await base.sceneOf(sceneId);
    const turns = new SceneTurnService(
      base.dataSource,
      new SceneLockService(base.dataSource),
      queueService,
    );
    queue.publish.mockClear();
    return turns.sendMessage(
      sceneId,
      { content, expectedRevision: scene.revision, ...extra } as never,
      null,
    );
  };

  const newScene = async (name: string) => {
    const scene = await insertScene(base.dataSource, { name });
    base.trackScene(scene.id);
    return scene;
  };

  /** Cena (com imagem, salvo `noImage`), POST real e o consumer do Diretor rodando com a resposta dada. */
  const runTurn = async (
    content: string,
    respond: Respond | Parameters<typeof directorAnswer>[0],
    options: TurnOptions = {},
  ) => {
    const scene = options.noImage ? await newScene('Sem imagem') : (await base.readyScene()).scene;
    if (options.brief) {
      await base.dataSource.manager.update(
        TemplateScene,
        { id: scene.id },
        { brief: options.brief },
      );
    }
    const sent = await post(scene.id, content, options.extra);
    const { client, plan } = directorClient(
      typeof respond === 'function' ? respond : async () => directorAnswer(respond),
    );
    const processor = build(client, options.env);
    queue.publish.mockClear();
    await processor.process({ sceneId: scene.id, versionId: sent.versionId }, 'job-d');
    return { scene, sent, plan, processor, version: await base.versionOf(sent.versionId) };
  };

  return Object.assign(base, {
    queue,
    runTurn,
    /** Cliente do Diretor que responde com o que o teste manda, e registra as chamadas. */
    directorClient,
    directorProcessor: build,
    turns: () =>
      new SceneTurnService(base.dataSource, new SceneLockService(base.dataSource), queueService),
    /** Envia a mensagem pelo POST real (revisão atual da cena) e devolve o resultado. */
    post,
  });
}
