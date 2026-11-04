import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { TemplateScenesGcRunner } from './template-scenes-gc.runner';
import { UploadsGcService } from './uploads-gc.service';

/** Subida do GC das cenas: independente de animações e comerciais, e só no worker. */
describe('UploadsGcService: GC das cenas de template', () => {
  const env = { ...process.env };
  let runner: { run: jest.Mock };

  const build = (config: Record<string, string>) => {
    runner = {
      run: jest.fn().mockResolvedValue({ selected: 0, deleted: 0, dryRun: true, files: [] }),
    };
    const service = new UploadsGcService(
      { getRepository: jest.fn(), query: jest.fn().mockResolvedValue([]) } as unknown as DataSource,
      new ConfigService(config),
      runner as unknown as TemplateScenesGcRunner,
    );
    jest.spyOn(service, 'runOnce').mockResolvedValue({} as never);
    return service;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.WORKER_ONLY = 'true';
  });
  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...env };
  });

  const FIVE_MIN = 5 * 60 * 1000;

  it('com animações e comerciais desligados e a flag da cena ligada, agenda só o GC das cenas', async () => {
    const service = build({
      ANIMATIONS_ENABLED: 'false',
      MC_ENABLED: 'false',
      TEMPLATE_SCENE_ENABLED: 'true',
    });
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(FIVE_MIN + 1);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(service.runOnce).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('com tudo desligado não agenda nada', async () => {
    const service = build({ ANIMATIONS_ENABLED: 'false', MC_ENABLED: 'false' });
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(FIVE_MIN + 1);
    expect(runner.run).not.toHaveBeenCalled();
    expect(service.runOnce).not.toHaveBeenCalled();
  });

  it('com animações ligadas e a cena desligada, roda só a varredura antiga', async () => {
    const service = build({});
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(FIVE_MIN + 1);
    expect(service.runOnce).toHaveBeenCalledTimes(1);
    expect(runner.run).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('com as duas frentes ligadas, roda as duas', async () => {
    const service = build({ TEMPLATE_SCENE_ENABLED: 'true' });
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(FIVE_MIN + 1);
    expect(service.runOnce).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('falha do GC das cenas não derruba a varredura antiga', async () => {
    const service = build({ TEMPLATE_SCENE_ENABLED: 'true' });
    runner.run.mockRejectedValue(new Error('boom'));
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(FIVE_MIN + 1);
    expect(service.runOnce).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('fora do worker (API) não agenda', async () => {
    process.env.WORKER_ONLY = 'false';
    const service = build({ TEMPLATE_SCENE_ENABLED: 'true' });
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(FIVE_MIN + 1);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('runTemplateScenes repassa o dryRun e não depende do GC_DRY_RUN global', async () => {
    const service = build({});
    await service.runTemplateScenes({ dryRun: false });
    expect(runner.run).toHaveBeenCalledWith({ dryRun: false });
  });
});
