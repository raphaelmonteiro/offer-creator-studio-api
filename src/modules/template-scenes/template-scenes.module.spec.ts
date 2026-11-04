import { ConfigService } from '@nestjs/config';
import { QUEUES } from '../../shared/queue/animation-queue.service';
import { SceneTurnProcessor } from './processors/scene-turn.processor';
import { SceneReconcilerService } from './services/scene-reconciler.service';
import { TemplateScenesModule } from './template-scenes.module';

describe('TemplateScenesModule: consumer da fila', () => {
  const build = (env: Record<string, string>) => {
    const queue = { subscribe: jest.fn().mockResolvedValue(undefined) };
    const processor = { process: jest.fn().mockResolvedValue(undefined) };
    const reconciler = { start: jest.fn() };
    const module = new TemplateScenesModule(
      new ConfigService(env),
      queue as never,
      processor as unknown as SceneTurnProcessor,
      reconciler as unknown as SceneReconcilerService,
    );
    return { module, queue, processor, reconciler };
  };

  it('worker com a flag ligada: assina template_scene.turn e liga o reconciliador', async () => {
    const { module, queue, processor, reconciler } = build({
      TEMPLATE_SCENE_ENABLED: 'true',
      WORKER_ONLY: 'true',
    });
    await module.onModuleInit();

    expect(queue.subscribe).toHaveBeenCalledTimes(1);
    const [name, concurrency, handler] = queue.subscribe.mock.calls[0];
    expect(name).toBe(QUEUES.TEMPLATE_SCENE_TURN);
    expect(concurrency).toBe(1);
    await handler({ sceneId: 's', versionId: 'v' }, 'job-1');
    expect(processor.process).toHaveBeenCalledWith({ sceneId: 's', versionId: 'v' }, 'job-1');
    expect(reconciler.start).toHaveBeenCalledTimes(1);
  });

  it('usa TEMPLATE_SCENE_CONCURRENCY', async () => {
    const { module, queue } = build({
      TEMPLATE_SCENE_ENABLED: 'true',
      WORKER_ONLY: 'true',
      TEMPLATE_SCENE_CONCURRENCY: '3',
    });
    await module.onModuleInit();
    expect(queue.subscribe.mock.calls[0][1]).toBe(3);
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
