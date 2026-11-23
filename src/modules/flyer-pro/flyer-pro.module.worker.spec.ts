import { fakeConfig } from '../ai/utils/openai-chat.testutil';
import { readEnrichConfig } from './config/flyer-pro-enrich.config';
import { FlyerProModule } from './flyer-pro.module';

/** O consumidor e o reconciliador do job só no worker e com a flag ligada (`onModuleInit`). */
describe('FlyerProModule.onModuleInit: o que sobe em cada processo', () => {
  const original = process.env.WORKER_ONLY;
  afterEach(() => {
    if (original === undefined) delete process.env.WORKER_ONLY;
    else process.env.WORKER_ONLY = original;
  });

  function build(env: Record<string, string> = {}) {
    const queue = { subscribe: jest.fn().mockResolvedValue(undefined) };
    const processor = { handle: jest.fn().mockResolvedValue(undefined) };
    const reconciler = { start: jest.fn() };
    const config = readEnrichConfig(fakeConfig(env), { warn: jest.fn() });
    const module = new FlyerProModule(
      queue as never,
      processor as never,
      reconciler as never,
      config,
    );
    return { module, queue, processor, reconciler };
  }

  it('worker com a flag do job ligada: registra o consumidor com a concorrência 2 e inicia o reconciliador', async () => {
    process.env.WORKER_ONLY = 'true';
    const { module, queue, reconciler, processor } = build();

    await module.onModuleInit();

    expect(queue.subscribe).toHaveBeenCalledWith('flyer_pro.enrich', 2, expect.any(Function));
    expect(reconciler.start).toHaveBeenCalledTimes(1);
    const handler = queue.subscribe.mock.calls[0][2] as (message: object) => Promise<void>;
    await handler({ jobId: 'job-1', seq: 3 });
    expect(processor.handle).toHaveBeenCalledWith({ jobId: 'job-1', seq: 3 });
  });

  it('a concorrência vem da variável: FLYER_PRO_ENRICH_CONCURRENCY=1 registra 1', async () => {
    process.env.WORKER_ONLY = 'true';
    const { module, queue } = build({ FLYER_PRO_ENRICH_CONCURRENCY: '1' });

    await module.onModuleInit();

    expect(queue.subscribe).toHaveBeenCalledWith('flyer_pro.enrich', 1, expect.any(Function));
  });

  it('worker com a flag desligada: nenhum consumidor e o reconciliador não roda', async () => {
    process.env.WORKER_ONLY = 'true';
    const { module, queue, reconciler } = build({ FLYER_PRO_ENRICH_ENABLED: 'false' });

    await module.onModuleInit();

    expect(queue.subscribe).not.toHaveBeenCalled();
    expect(reconciler.start).not.toHaveBeenCalled();
  });

  it('processo da API (sem WORKER_ONLY): o reconciliador não roda e nenhum lote é consumido', async () => {
    delete process.env.WORKER_ONLY;
    const { module, queue, reconciler } = build();

    await module.onModuleInit();

    expect(queue.subscribe).not.toHaveBeenCalled();
    expect(reconciler.start).not.toHaveBeenCalled();
  });

  it('WORKER_ONLY com outro valor que não true: trata como API', async () => {
    process.env.WORKER_ONLY = 'false';
    const { module, queue } = build();

    await module.onModuleInit();

    expect(queue.subscribe).not.toHaveBeenCalled();
  });
});
