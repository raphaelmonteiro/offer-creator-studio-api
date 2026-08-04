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
