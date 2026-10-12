import { RenderPreflight, summarizeRenderPreflight } from '../ffmpeg/render-preflight';
import { RenderPreflightService } from '../ffmpeg/render-preflight.service';
import { SystemSettingsService } from './system-settings.service';
import {
  RENDER_PREFLIGHT_INTERVAL_MS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_KEY,
  WorkerHeartbeatService,
} from './worker-heartbeat.service';

const fakePreflight: RenderPreflight = summarizeRenderPreflight(
  [
    { id: 'ffmpeg', ok: true, version: '6.1.2' },
    { id: 'ffprobe', ok: true, version: '6.1.2' },
    { id: 'fonts', ok: true, version: '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf' },
    { id: 'browser', ok: false, version: null, detail: 'MC_RENDER_BROWSER não definido' },
  ],
  '2026-10-12T00:00:00.000Z',
);

describe('WorkerHeartbeatService', () => {
  const originalWorkerOnly = process.env.WORKER_ONLY;
  let settings: { set: jest.Mock };
  let preflight: { run: jest.Mock };
  let service: WorkerHeartbeatService;

  beforeEach(() => {
    jest.useFakeTimers();
    settings = { set: jest.fn().mockResolvedValue(undefined) };
    preflight = { run: jest.fn().mockResolvedValue(fakePreflight) };
    service = new WorkerHeartbeatService(
      settings as unknown as SystemSettingsService,
      preflight as unknown as RenderPreflightService,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    if (originalWorkerOnly === undefined) delete process.env.WORKER_ONLY;
    else process.env.WORKER_ONLY = originalWorkerOnly;
  });

  it('fora do worker (WORKER_ONLY != true) não bate nunca nem roda preflight', async () => {
    delete process.env.WORKER_ONLY;
    await service.onModuleInit();
    jest.advanceTimersByTime(WORKER_HEARTBEAT_INTERVAL_MS * 3);
    expect(settings.set).not.toHaveBeenCalled();
    expect(preflight.run).not.toHaveBeenCalled();
  });

  it('no worker: preflight no boot, primeiro batimento imediato com `render` + um a cada 15s', async () => {
    process.env.WORKER_ONLY = 'true';
    await service.onModuleInit();
    expect(preflight.run).toHaveBeenCalledTimes(1);
    expect(settings.set).toHaveBeenCalledTimes(1); // imediato, antes do intervalo

    await jest.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
    expect(settings.set).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
    expect(settings.set).toHaveBeenCalledTimes(3);

    const [key, value] = settings.set.mock.calls[0];
    expect(key).toBe(WORKER_HEARTBEAT_KEY);
    expect(value).toEqual({ at: expect.any(String), pid: process.pid, render: fakePreflight });
    expect(Number.isNaN(Date.parse(value.at))).toBe(false); // ISO válido
    expect(value.render.formats.talking_art.available).toBe(true);
    expect(value.render.formats.offer_carousel.missing).toEqual(['browser']);
  });

  it('preflight é refeito a cada hora e o batimento seguinte carrega o novo resultado', async () => {
    process.env.WORKER_ONLY = 'true';
    await service.onModuleInit();
    const updated = { ...fakePreflight, checkedAt: '2026-10-12T01:00:00.000Z' };
    preflight.run.mockResolvedValue(updated);
    await jest.advanceTimersByTimeAsync(RENDER_PREFLIGHT_INTERVAL_MS);
    expect(preflight.run).toHaveBeenCalledTimes(2);
    // o batimento que dispara no MESMO instante do preflight ainda leva o resultado antigo;
    // o seguinte (15s depois) já carrega o novo
    await jest.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
    const last = settings.set.mock.calls.at(-1)?.[1];
    expect(last.render.checkedAt).toBe('2026-10-12T01:00:00.000Z');
  });

  it('preflight que falha não impede o batimento (render ausente)', async () => {
    process.env.WORKER_ONLY = 'true';
    preflight.run.mockRejectedValue(new Error('spawn travou'));
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(settings.set).toHaveBeenCalledTimes(1);
    expect(settings.set.mock.calls[0][1]).toEqual({ at: expect.any(String), pid: process.pid });
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
