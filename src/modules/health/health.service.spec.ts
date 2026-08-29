import { DataSource } from 'typeorm';
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
    expect(res.data.worker).toEqual({ lastSeenAt: null, healthy: false });
    // health NÃO pode servir cache velho → getFresh, com a chave certa
    expect(settings.getFresh).toHaveBeenCalledWith(WORKER_HEARTBEAT_KEY);
  });

  it('batimento recente (< 60s) → healthy=true', async () => {
    const at = new Date(Date.now() - 5_000).toISOString();
    settings.getFresh.mockResolvedValue({ at, pid: 123 });
    const res = await service.check();
    expect(res.data.worker).toEqual({ lastSeenAt: at, healthy: true });
  });

  it('batimento velho (>= 60s) → healthy=false, mas lastSeenAt preservado', async () => {
    const at = new Date(Date.now() - WORKER_HEARTBEAT_STALE_MS - 1_000).toISOString();
    settings.getFresh.mockResolvedValue({ at, pid: 123 });
    const res = await service.check();
    expect(res.data.worker).toEqual({ lastSeenAt: at, healthy: false });
  });

  it('erro ao ler o heartbeat (ex.: migration ainda não rodou) degrada sem derrubar o health', async () => {
    settings.getFresh.mockRejectedValue(new Error('relation "system_settings" does not exist'));
    const res = await service.check();
    expect(res.data.status).toBe('ok');
    expect(res.data.worker).toEqual({ lastSeenAt: null, healthy: false });
  });
});
