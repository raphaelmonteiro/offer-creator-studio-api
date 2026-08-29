import { ResourceGuardService } from './resource-guard.service';

const GB = 1024 * 1024 * 1024;

describe('ResourceGuardService — admission control com histerese (TDD §6.5)', () => {
  let guard: ResourceGuardService;

  beforeEach(() => {
    guard = new ResourceGuardService();
  });

  it('permite jobs pesados com recursos saudáveis', () => {
    guard.evaluate(0.3, 2 * GB);
    expect(guard.admitHeavyJob()).toBe(true);
  });

  it('degrada quando a média móvel de CPU passa de 80%', () => {
    guard.evaluate(0.95, 2 * GB);
    expect(guard.admitHeavyJob()).toBe(false);
  });

  it('degrada com RAM livre abaixo de 500MB mesmo com CPU ok', () => {
    guard.evaluate(0.2, 100 * 1024 * 1024);
    expect(guard.admitHeavyJob()).toBe(false);
  });

  it('histerese: só recupera abaixo de 65% sustentado por 30s', () => {
    const t0 = 1_000_000;
    guard.evaluate(0.95, 2 * GB, t0);
    expect(guard.admitHeavyJob()).toBe(false);

    // média ainda contaminada pela amostra alta — mesmo com amostras baixas,
    // precisa da janela baixar E sustentar 30s
    guard.evaluate(0.1, 2 * GB, t0 + 5_000);
    guard.evaluate(0.1, 2 * GB, t0 + 10_000);
    guard.evaluate(0.1, 2 * GB, t0 + 15_000); // média já < 0.65, inicia contagem…
    expect(guard.admitHeavyJob()).toBe(false); // …mas ainda não deu 30s

    guard.evaluate(0.1, 2 * GB, t0 + 50_000); // 35s depois do início da recuperação
    expect(guard.admitHeavyJob()).toBe(true);
  });

  it('pico durante a recuperação zera a contagem (anti-flapping)', () => {
    const t0 = 1_000_000;
    guard.evaluate(0.95, 2 * GB, t0);
    guard.evaluate(0.1, 2 * GB, t0 + 5_000);
    guard.evaluate(0.1, 2 * GB, t0 + 10_000);
    guard.evaluate(0.1, 2 * GB, t0 + 15_000); // começa a recuperar
    guard.evaluate(0.99, 2 * GB, t0 + 20_000); // pico → reset
    guard.evaluate(0.1, 2 * GB, t0 + 25_000);
    expect(guard.admitHeavyJob()).toBe(false); // contagem recomeçou
  });
});

describe('ResourceGuardService — gate de disco (plano-comerciais §11)', () => {
  const originalEnv = process.env.RESOURCE_GUARD_MIN_DISK_GB;
  let guard: ResourceGuardService;

  beforeEach(() => {
    delete process.env.RESOURCE_GUARD_MIN_DISK_GB;
    guard = new ResourceGuardService();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.RESOURCE_GUARD_MIN_DISK_GB;
    else process.env.RESOURCE_GUARD_MIN_DISK_GB = originalEnv;
  });

  it('degrada com menos de 5 GB livres (default), mesmo com CPU/RAM ok', () => {
    guard.evaluate(0.2, 2 * GB, Date.now(), 4 * GB);
    expect(guard.admitHeavyJob()).toBe(false);
    expect(guard.getState()).toEqual({ degraded: true, reason: 'disk' });
  });

  it('não degrada com disco acima do mínimo', () => {
    guard.evaluate(0.2, 2 * GB, Date.now(), 50 * GB);
    expect(guard.admitHeavyJob()).toBe(true);
    expect(guard.getState()).toEqual({ degraded: false, reason: null });
  });

  it('disco não amostrado (null) não degrada — comportamento dos specs antigos', () => {
    guard.evaluate(0.2, 2 * GB);
    expect(guard.admitHeavyJob()).toBe(true);
  });

  it('respeita RESOURCE_GUARD_MIN_DISK_GB customizado', () => {
    process.env.RESOURCE_GUARD_MIN_DISK_GB = '10';
    guard.evaluate(0.2, 2 * GB, Date.now(), 8 * GB); // 8 GB < 10 GB → degrada
    expect(guard.admitHeavyJob()).toBe(false);
    expect(guard.getState().reason).toBe('disk');
  });

  it('recuperação de disco segue a MESMA histerese de 30s sustentados', () => {
    const t0 = 1_000_000;
    guard.evaluate(0.1, 2 * GB, t0, 1 * GB); // degrada por disco
    expect(guard.admitHeavyJob()).toBe(false);

    guard.evaluate(0.1, 2 * GB, t0 + 5_000, 20 * GB); // disco saudável, inicia contagem…
    expect(guard.admitHeavyJob()).toBe(false); // …mas ainda não deu 30s

    guard.evaluate(0.1, 2 * GB, t0 + 20_000, 1 * GB); // disco caiu de novo → reset
    guard.evaluate(0.1, 2 * GB, t0 + 25_000, 20 * GB); // recomeça a contagem
    guard.evaluate(0.1, 2 * GB, t0 + 40_000, 20 * GB); // só 15s de recuperação
    expect(guard.admitHeavyJob()).toBe(false);

    guard.evaluate(0.1, 2 * GB, t0 + 60_000, 20 * GB); // 35s sustentados
    expect(guard.admitHeavyJob()).toBe(true);
    expect(guard.getState()).toEqual({ degraded: false, reason: null });
  });

  it('prioridade do motivo: cpu > ram > disk quando mais de um recurso está ruim', () => {
    guard.evaluate(0.95, 100 * 1024 * 1024, Date.now(), 1 * GB);
    expect(guard.getState().reason).toBe('cpu');

    const guard2 = new ResourceGuardService();
    guard2.evaluate(0.2, 100 * 1024 * 1024, Date.now(), 1 * GB);
    expect(guard2.getState().reason).toBe('ram');
  });
});
