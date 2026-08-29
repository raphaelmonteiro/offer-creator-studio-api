import { SystemSettingsService } from './system-settings.service';
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_KEY,
  WorkerHeartbeatService,
} from './worker-heartbeat.service';

describe('WorkerHeartbeatService', () => {
  const originalWorkerOnly = process.env.WORKER_ONLY;
  let settings: { set: jest.Mock };
  let service: WorkerHeartbeatService;

  beforeEach(() => {
    jest.useFakeTimers();
    settings = { set: jest.fn().mockResolvedValue(undefined) };
    service = new WorkerHeartbeatService(settings as unknown as SystemSettingsService);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    if (originalWorkerOnly === undefined) delete process.env.WORKER_ONLY;
    else process.env.WORKER_ONLY = originalWorkerOnly;
  });

  it('fora do worker (WORKER_ONLY != true) não bate nunca', async () => {
    delete process.env.WORKER_ONLY;
    await service.onModuleInit();
    jest.advanceTimersByTime(WORKER_HEARTBEAT_INTERVAL_MS * 3);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('no worker: primeiro batimento imediato + um a cada 15s', async () => {
    process.env.WORKER_ONLY = 'true';
    await service.onModuleInit();
    expect(settings.set).toHaveBeenCalledTimes(1); // imediato, antes do intervalo

    await jest.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
    expect(settings.set).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
    expect(settings.set).toHaveBeenCalledTimes(3);

    const [key, value] = settings.set.mock.calls[0];
    expect(key).toBe(WORKER_HEARTBEAT_KEY);
    expect(value).toEqual({ at: expect.any(String), pid: process.pid });
    expect(Number.isNaN(Date.parse(value.at))).toBe(false); // ISO válido
  });

  it('erro no set não derruba o worker nem para o timer', async () => {
    process.env.WORKER_ONLY = 'true';
    settings.set.mockRejectedValue(new Error('postgres piscou'));
    await expect(service.onModuleInit()).resolves.toBeUndefined();

    settings.set.mockResolvedValue(undefined);
    await jest.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
    expect(settings.set).toHaveBeenCalledTimes(2); // continuou batendo
  });
});
