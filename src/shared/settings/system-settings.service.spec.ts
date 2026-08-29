import { Repository } from 'typeorm';
import { SystemSetting } from './system-setting.entity';
import { SETTINGS_CACHE_TTL_MS, SystemSettingsService } from './system-settings.service';

/** Repositório fake: uma "tabela" em memória + espiões de findOneBy/query. */
function fakeRepo() {
  const table = new Map<string, unknown>();
  const repo = {
    table,
    findOneBy: jest.fn(({ key }: { key: string }) => {
      return Promise.resolve(
        table.has(key) ? ({ key, value: table.get(key) } as SystemSetting) : null,
      );
    }),
    query: jest.fn((_sql: string, [key, json]: [string, string]) => {
      table.set(key, JSON.parse(json));
      return Promise.resolve();
    }),
  };
  return repo as unknown as Repository<SystemSetting> & typeof repo;
}

describe('SystemSettingsService (cache de 10s por chave)', () => {
  let repo: ReturnType<typeof fakeRepo>;
  let service: SystemSettingsService;

  beforeEach(() => {
    jest.useFakeTimers();
    repo = fakeRepo();
    service = new SystemSettingsService(repo);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('get serve do cache dentro do TTL (1 SELECT para N leituras)', async () => {
    repo.table.set('mc_paused', true);
    expect(await service.get<boolean>('mc_paused')).toBe(true);
    expect(await service.get<boolean>('mc_paused')).toBe(true);
    expect(repo.findOneBy).toHaveBeenCalledTimes(1);
  });

  it('get expira o cache após o TTL e volta ao banco', async () => {
    repo.table.set('mc_paused', false);
    expect(await service.get<boolean>('mc_paused')).toBe(false);

    repo.table.set('mc_paused', true); // mudou no banco (outro processo)
    jest.advanceTimersByTime(SETTINGS_CACHE_TTL_MS - 1);
    expect(await service.get<boolean>('mc_paused')).toBe(false); // ainda cacheado

    jest.advanceTimersByTime(2); // cruza o TTL
    expect(await service.get<boolean>('mc_paused')).toBe(true);
    expect(repo.findOneBy).toHaveBeenCalledTimes(2);
  });

  it('ausência de linha também é cacheada como null', async () => {
    expect(await service.get('nao_existe')).toBeNull();
    expect(await service.get('nao_existe')).toBeNull();
    expect(repo.findOneBy).toHaveBeenCalledTimes(1);
  });

  it('cache é por chave — chaves diferentes não se atropelam', async () => {
    repo.table.set('a', 1);
    repo.table.set('b', 2);
    expect(await service.get<number>('a')).toBe(1);
    expect(await service.get<number>('b')).toBe(2);
    expect(repo.findOneBy).toHaveBeenCalledTimes(2);
  });

  it('set faz upsert e invalida o cache local da chave', async () => {
    repo.table.set('mc_paused', false);
    expect(await service.get<boolean>('mc_paused')).toBe(false); // popula o cache

    await service.set('mc_paused', true);
    expect(repo.query).toHaveBeenCalledTimes(1);
    // sem esperar TTL: a invalidação força releitura do banco
    expect(await service.get<boolean>('mc_paused')).toBe(true);
  });

  it('getFresh nunca usa o cache', async () => {
    repo.table.set('worker_heartbeat', { at: 't0' });
    await service.get('worker_heartbeat'); // popula o cache

    repo.table.set('worker_heartbeat', { at: 't1' });
    expect(await service.getFresh<{ at: string }>('worker_heartbeat')).toEqual({ at: 't1' });
    expect(repo.findOneBy).toHaveBeenCalledTimes(2);
  });
});
