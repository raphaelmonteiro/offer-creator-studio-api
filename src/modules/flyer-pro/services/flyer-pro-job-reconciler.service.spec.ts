import { FlyerProJobReconcilerService } from './flyer-pro-job-reconciler.service';

describe('FlyerProJobReconcilerService.start (boot do worker e a cada 60 s)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function build() {
    const reconciler = new FlyerProJobReconcilerService({} as never, {} as never, {} as never);
    const reconcile = jest.spyOn(reconciler, 'reconcile').mockResolvedValue(0);
    return { reconciler, reconcile };
  }

  it('varre no boot, depois a cada minuto, e para ao destruir o módulo', async () => {
    const { reconciler, reconcile } = build();

    reconciler.start();
    expect(reconcile).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(reconcile).toHaveBeenCalledTimes(4);

    reconciler.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(180_000);
    expect(reconcile).toHaveBeenCalledTimes(4);
  });

  it('uma varredura que falha não derruba o worker nem para as seguintes', async () => {
    const { reconciler, reconcile } = build();
    reconcile.mockRejectedValueOnce(new Error('banco fora')).mockResolvedValue(0);

    reconciler.start();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(reconcile).toHaveBeenCalledTimes(2);
    reconciler.onModuleDestroy();
  });
});
