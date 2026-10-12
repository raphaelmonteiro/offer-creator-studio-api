import { DataSource } from 'typeorm';
import { summarizeRenderPreflight } from '../../shared/ffmpeg/render-preflight';
import { SystemSettingsService } from '../../shared/settings/system-settings.service';
import { WORKER_HEARTBEAT_KEY } from '../../shared/settings/worker-heartbeat.service';
import { HealthService, WORKER_HEARTBEAT_STALE_MS } from './health.service';

describe('HealthService — worker heartbeat no payload', () => {
  let dataSource: { query: jest.Mock };
  let settings: { getFresh: jest.Mock };
  let service: HealthService;

  beforeEach(() => {
    dataSource = { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    settings = { getFresh: jest.fn().mockResolvedValue(null) };
    service = new HealthService(
      dataSource as unknown as DataSource,
      settings as unknown as SystemSettingsService,
    );
  });

  it('mantém o formato existente e adiciona worker (sem batimento → unhealthy)', async () => {
    const res = await service.check();
    expect(res.success).toBe(true);
    // campos pré-existentes intactos
    expect(res.data.status).toBe('ok');
    expect(res.data.database).toBe('connected');
    expect(res.data.version).toBeDefined();
    // campo novo
    expect(res.data.worker).toEqual({ lastSeenAt: null, healthy: false, render: null });
    // health NÃO pode servir cache velho → getFresh, com a chave certa
    expect(settings.getFresh).toHaveBeenCalledWith(WORKER_HEARTBEAT_KEY);
  });

  it('batimento recente (< 60s) → healthy=true', async () => {
    const at = new Date(Date.now() - 5_000).toISOString();
    settings.getFresh.mockResolvedValue({ at, pid: 123 });
    const res = await service.check();
    expect(res.data.worker).toEqual({ lastSeenAt: at, healthy: true, render: null });
  });

  it('batimento velho (>= 60s) → healthy=false, mas lastSeenAt preservado', async () => {
    const at = new Date(Date.now() - WORKER_HEARTBEAT_STALE_MS - 1_000).toISOString();
    settings.getFresh.mockResolvedValue({ at, pid: 123 });
    const res = await service.check();
    expect(res.data.worker).toEqual({ lastSeenAt: at, healthy: false, render: null });
  });

  it('erro ao ler o heartbeat (ex.: migration ainda não rodou) degrada sem derrubar o health', async () => {
    settings.getFresh.mockRejectedValue(new Error('relation "system_settings" does not exist'));
    const res = await service.check();
    expect(res.data.status).toBe('ok');
    expect(res.data.worker).toEqual({ lastSeenAt: null, healthy: false, render: null });
  });
});

describe('HealthService — preflight de render por formato (design D14)', () => {
  let settings: { getFresh: jest.Mock };
  let service: HealthService;

  beforeEach(() => {
    settings = { getFresh: jest.fn() };
    service = new HealthService(
      { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) } as unknown as DataSource,
      settings as unknown as SystemSettingsService,
    );
  });

  it('expõe render por formato quando o worker publicou o preflight', async () => {
    const render = summarizeRenderPreflight(
      [
        { id: 'ffmpeg', ok: true, version: '6.1.2' },
        { id: 'ffprobe', ok: true, version: '6.1.2' },
        { id: 'fonts', ok: true, version: '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf' },
        { id: 'browser', ok: false, version: null, detail: 'MC_RENDER_BROWSER não definido' },
      ],
      '2026-10-12T00:00:00.000Z',
    );
    settings.getFresh.mockResolvedValue({ at: new Date().toISOString(), pid: 1, render });
    const { data } = await service.check();
    expect(data.worker.healthy).toBe(true);
    expect(data.worker.render).toEqual({
      checkedAt: '2026-10-12T00:00:00.000Z',
      // sem o caminho da fonte: o health é público
      versions: { ffmpeg: '6.1.2', ffprobe: '6.1.2' },
      details: { browser: 'MC_RENDER_BROWSER não definido' },
      formats: {
        scenes: { available: true, missing: [] },
        talking_art: { available: true, missing: [] },
        offer_carousel: { available: false, missing: ['browser'] },
      },
    });
    // a lista bruta de checagens não vai para o health
    expect((data.worker.render as Record<string, unknown>).checks).toBeUndefined();
  });

  it('compositor ausente → todos os formatos indisponíveis com o item faltante', async () => {
    const render = summarizeRenderPreflight(
      [
        { id: 'ffmpeg', ok: false, version: null, detail: 'ffmpeg: não encontrado' },
        { id: 'ffprobe', ok: true, version: '6.1.2' },
        { id: 'fonts', ok: true, version: 'fc-list: DejaVu' },
        { id: 'browser', ok: false, version: null, detail: 'MC_RENDER_BROWSER não definido' },
      ],
      '2026-10-12T00:00:00.000Z',
    );
    settings.getFresh.mockResolvedValue({ at: new Date().toISOString(), pid: 1, render });
    const { data } = await service.check();
    expect(data.worker.render?.formats.talking_art).toEqual({
      available: false,
      missing: ['ffmpeg'],
    });
    expect(data.worker.render?.formats.offer_carousel.missing).toEqual(['ffmpeg', 'browser']);
  });
});
