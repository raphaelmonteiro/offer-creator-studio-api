import { ConfigService } from '@nestjs/config';
import { QUEUES } from '../../shared/queue/animation-queue.service';
import { SceneDirectorProcessor } from './processors/scene-director.processor';
import { SceneTurnProcessor } from './processors/scene-turn.processor';
import { SceneReconcilerService } from './services/scene-reconciler.service';
import { TemplateScenesModule } from './template-scenes.module';

describe('TemplateScenesModule: consumer da fila', () => {
  const build = (env: Record<string, string>) => {
    const queue = { subscribe: jest.fn().mockResolvedValue(undefined) };
    const processor = { process: jest.fn().mockResolvedValue(undefined) };
    const director = { process: jest.fn().mockResolvedValue(undefined) };
    const reconciler = { start: jest.fn() };
    const module = new TemplateScenesModule(
      new ConfigService(env),
      queue as never,
      processor as unknown as SceneTurnProcessor,
      director as unknown as SceneDirectorProcessor,
      reconciler as unknown as SceneReconcilerService,
    );
    return { module, queue, processor, director, reconciler };
  };

  it('worker com a flag ligada: assina a imagem e o Diretor e liga o reconciliador', async () => {
    const { module, queue, processor, director, reconciler } = build({
      TEMPLATE_SCENE_ENABLED: 'true',
      WORKER_ONLY: 'true',
    });
    await module.onModuleInit();

    expect(queue.subscribe).toHaveBeenCalledTimes(2);
    const [turn, directorSub] = queue.subscribe.mock.calls;
    expect(turn[0]).toBe(QUEUES.TEMPLATE_SCENE_TURN);
    expect(turn[1]).toBe(1);
    await turn[2]({ sceneId: 's', versionId: 'v' }, 'job-1');
    expect(processor.process).toHaveBeenCalledWith({ sceneId: 's', versionId: 'v' }, 'job-1');
    expect(directorSub[0]).toBe(QUEUES.TEMPLATE_SCENE_DIRECTOR);
    expect(directorSub[1]).toBe(4);
    await directorSub[2]({ sceneId: 's', versionId: 'v' }, 'job-2');
    expect(director.process).toHaveBeenCalledWith({ sceneId: 's', versionId: 'v' }, 'job-2');
    expect(reconciler.start).toHaveBeenCalledTimes(1);
  });

  it('usa TEMPLATE_SCENE_CONCURRENCY e TEMPLATE_SCENE_DIRECTOR_CONCURRENCY, cada um o seu', async () => {
    const { module, queue } = build({
      TEMPLATE_SCENE_ENABLED: 'true',
      WORKER_ONLY: 'true',
      TEMPLATE_SCENE_CONCURRENCY: '3',
      TEMPLATE_SCENE_DIRECTOR_CONCURRENCY: '6',
    });
    await module.onModuleInit();
    expect(queue.subscribe.mock.calls[0][1]).toBe(3);
    expect(queue.subscribe.mock.calls[1][1]).toBe(6);
  });

  it('concorrência inválida volta ao padrão', async () => {
    const { module, queue } = build({
      TEMPLATE_SCENE_ENABLED: 'true',
      WORKER_ONLY: 'true',
      TEMPLATE_SCENE_CONCURRENCY: '0',
      TEMPLATE_SCENE_DIRECTOR_CONCURRENCY: 'abc',
    });
    await module.onModuleInit();
    expect([queue.subscribe.mock.calls[0][1], queue.subscribe.mock.calls[1][1]]).toEqual([1, 4]);
  });

  it.each([
    ['flag desligada', { TEMPLATE_SCENE_ENABLED: 'false', WORKER_ONLY: 'true' }],
    ['flag ausente', { WORKER_ONLY: 'true' }],
    ['processo da API (sem WORKER_ONLY)', { TEMPLATE_SCENE_ENABLED: 'true' }],
  ])('%s: o consumer não sobe', async (_label, env) => {
    const { module, queue, reconciler } = build(env);
    await module.onModuleInit();
    expect(queue.subscribe).not.toHaveBeenCalled();
    expect(reconciler.start).not.toHaveBeenCalled();
  });
});
