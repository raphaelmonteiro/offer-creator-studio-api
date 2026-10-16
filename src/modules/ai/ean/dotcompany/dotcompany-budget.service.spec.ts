import { DataSource } from 'typeorm';
import { criarDataSourceDeTeste, EAN_IT_ENABLED } from '../ean-test-db';
import { DotcompanyBudgetService, spDayStart, spHourStart } from './dotcompany-budget.service';

describe('fuso de consumo (America/Sao_Paulo, UTC-3)', () => {
  it('hora e dia locais', () => {
    // 2099-01-02 02:30 UTC = 2099-01-01 23:30 em SP
    const d = new Date('2099-01-02T02:30:00Z');
    expect(spHourStart(d).toISOString()).toBe('2099-01-02T02:00:00.000Z');
    expect(spDayStart(d).toISOString()).toBe('2099-01-01T03:00:00.000Z');
  });
});

/**
 * Controlador de consumo contra Postgres real (contadores por hora e saldo
 * persistidos). Usa datas em 2099 para não colidir com outros testes:
 *
 *   EAN_IT_DB_PORT=5433 EAN_IT_DB_NAME=ean_mig_test npx jest dotcompany-budget
 */
const d = EAN_IT_ENABLED ? describe : describe.skip;

d('DotcompanyBudgetService (Postgres real)', () => {
  let ds: DataSource;
  const T0 = new Date('2099-03-10T13:05:00Z'); // 10:05 em SP

  beforeAll(async () => {
    ds = criarDataSourceDeTeste();
    await ds.initialize();
  });

  beforeEach(async () => {
    await ds.query(`DELETE FROM dotcompany_usage_hourly WHERE hour >= '2099-01-01'`);
    await ds.query(`DELETE FROM dotcompany_balance`);
  });

  afterAll(async () => {
    await ds.query(`DELETE FROM dotcompany_usage_hourly WHERE hour >= '2099-01-01'`);
    await ds.query(`DELETE FROM dotcompany_balance`);
    await ds.destroy();
  });

  function criar(env: Record<string, string> = {}, opts: { saldo?: number; token?: boolean } = {}) {
    const config = { get: (k: string) => env[k] };
    const client = {
      isConfigured: () => opts.token ?? true,
      usage: jest.fn(async () => ({ available: opts.saldo ?? 10_000, lowBalance: false })),
    };
    const email = { sendDotcompanyAlert: jest.fn(async (_p: { subject: string }) => undefined) };
    const svc = new DotcompanyBudgetService(config as never, ds, client as never, email as never);
    let agora = T0;
    svc.now = () => agora;
    return {
      svc,
      client,
      email,
      setNow: (dt: Date) => {
        agora = dt;
      },
    };
  }

  it('sem token nega com motivo no_token', async () => {
    const { svc } = criar({}, { token: false });
    expect(await svc.acquire({ kind: 'interactive', estimatedCredits: 4 })).toMatchObject({
      ok: false,
      reason: 'no_token',
    });
  });

  it('janela por minuto: a 31ª chamada no mesmo minuto é adiada para o próximo minuto', async () => {
    const { svc } = criar({ DOTCOMPANY_MAX_REQUESTS_HOUR: '1000' });
    for (let i = 0; i < 30; i++) {
      expect((await svc.acquire({ kind: 'batch', estimatedCredits: 0 })).ok).toBe(true);
    }
    const r = await svc.acquire({ kind: 'batch', estimatedCredits: 0 });
    expect(r).toMatchObject({ ok: false, reason: 'rate_window' });
    if (!r.ok) expect(r.retryAt?.toISOString()).toBe('2099-03-10T13:06:00.000Z');
  });

  it('usa o menor teto entre o configurado e o anunciado pela DotCompany', async () => {
    const { svc } = criar({ DOTCOMPANY_RPM: '600' });
    await svc.release({ kind: 'batch', rate: { limit: 30, remaining: 29, reset: null } });
    for (let i = 0; i < 30; i++) await svc.acquire({ kind: 'batch', estimatedCredits: 0 });
    expect((await svc.acquire({ kind: 'batch', estimatedCredits: 0 })).ok).toBe(false);
  });

  it('janela zerada nos headers bloqueia até o reset', async () => {
    const { svc } = criar();
    const reset = Math.floor(new Date('2099-03-10T13:05:40Z').getTime() / 1000);
    await svc.release({ kind: 'batch', rate: { limit: 30, remaining: 0, reset } });
    const r = await svc.acquire({ kind: 'interactive', estimatedCredits: 4 });
    expect(r).toMatchObject({ ok: false, reason: 'rate_window' });
    if (!r.ok) expect(r.retryAt?.getTime()).toBe(reset * 1000);
  });

  it('429 bloqueia pelo Retry-After', async () => {
    const { svc, setNow } = criar();
    svc.onRateLimited(30);
    expect((await svc.acquire({ kind: 'interactive', estimatedCredits: 4 })).ok).toBe(false);
    setNow(new Date(T0.getTime() + 31_000));
    expect((await svc.acquire({ kind: 'interactive', estimatedCredits: 4 })).ok).toBe(true);
  });

  it('limite de créditos por hora: nega até a próxima hora', async () => {
    const { svc, setNow } = criar({ DOTCOMPANY_MAX_CREDITS_HOUR: '400' });
    await svc.release({ kind: 'batch', credits: 380, found: 95 });
    const r = await svc.acquire({ kind: 'batch', estimatedCredits: 40 });
    expect(r).toMatchObject({ ok: false, reason: 'hour_limit' });
    if (!r.ok) expect(r.retryAt?.toISOString()).toBe('2099-03-10T14:00:00.000Z');

    setNow(new Date('2099-03-10T14:00:01Z'));
    expect((await svc.acquire({ kind: 'batch', estimatedCredits: 40 })).ok).toBe(true);
  });

  it('limite diário de requisições: nega até a meia-noite e avisa uma vez', async () => {
    const { svc, email } = criar({
      DOTCOMPANY_MAX_REQUESTS_DAY: '3',
      DOTCOMPANY_ALERT_EMAIL: 'ops@exemplo.com',
    });
    await svc.release({ kind: 'batch', requests: 3 });
    const r1 = await svc.acquire({ kind: 'interactive', estimatedCredits: 4 });
    const r2 = await svc.acquire({ kind: 'interactive', estimatedCredits: 4 });
    expect(r1).toMatchObject({ ok: false, reason: 'day_limit' });
    if (!r1.ok) expect(r1.retryAt?.toISOString()).toBe('2099-03-11T03:00:00.000Z');
    expect(r2.ok).toBe(false);
    await new Promise((res) => setImmediate(res));
    const alertas = email.sendDotcompanyAlert.mock.calls.filter(([p]) =>
      p.subject.includes('Limite diário'),
    );
    expect(alertas).toHaveLength(1);
  });

  it('contadores sobrevivem a um restart (novo serviço continua dos 80%)', async () => {
    const a = criar({ DOTCOMPANY_MAX_CREDITS_HOUR: '1000' });
    await a.svc.release({ kind: 'batch', credits: 800 });
    const b = criar({ DOTCOMPANY_MAX_CREDITS_HOUR: '1000' });
    expect((await b.svc.acquire({ kind: 'batch', estimatedCredits: 200 })).ok).toBe(true);
    expect(await b.svc.acquire({ kind: 'batch', estimatedCredits: 204 })).toMatchObject({
      ok: false,
      reason: 'hour_limit',
    });
  });

  it('reserva: o lote para, o encarte continua com o mesmo saldo', async () => {
    const { svc } = criar({ DOTCOMPANY_RESERVE_CREDITS: '400' }, { saldo: 420 });
    expect(await svc.acquire({ kind: 'batch', estimatedCredits: 400 })).toMatchObject({
      ok: false,
      reason: 'reserve',
    });
    expect((await svc.acquire({ kind: 'interactive', estimatedCredits: 400 })).ok).toBe(true);
  });

  it('402 zera o saldo e nega tudo até a recarga ser conferida', async () => {
    const { svc, client, setNow } = criar({}, { saldo: 0 });
    await svc.onNoCredit();
    await svc.refreshBalance(); // junta-se ao refresh disparado pelo 402
    expect(await svc.acquire({ kind: 'interactive', estimatedCredits: 4 })).toMatchObject({
      ok: false,
      reason: 'no_credit',
    });
    client.usage.mockResolvedValue({ available: 3000, lowBalance: false });
    setNow(new Date(T0.getTime() + 16 * 60_000)); // depois do refresh de 15 min
    expect((await svc.acquire({ kind: 'batch', estimatedCredits: 400 })).ok).toBe(true);
  });

  it('desconta o custo do saldo e avisa saldo baixo uma vez só (histerese)', async () => {
    const { svc, email } = criar(
      { DOTCOMPANY_ALERT_CREDITS: '1000', DOTCOMPANY_ALERT_EMAIL: 'ops@exemplo.com' },
      { saldo: 1100 },
    );
    await svc.refreshBalance();
    await svc.release({ kind: 'batch', credits: 200 }); // 900: cruza o limiar
    await svc.release({ kind: 'batch', credits: 100 }); // 800: continua abaixo
    const baixos = email.sendDotcompanyAlert.mock.calls.filter(([p]) =>
      p.subject.includes('baixo'),
    );
    expect(baixos).toHaveLength(1);
    expect((await svc.report()).balance.available).toBe(800);
  });

  it('relatório traz consumo da hora/dia/mês, limites e estado', async () => {
    const { svc } = criar();
    await svc.release({ kind: 'interactive', credits: 8, found: 2, notFound: 1 });
    const r = await svc.report();
    expect(r.hour).toMatchObject({ requests: 1, credits: 8, found: 2, notFound: 1 });
    expect(r.day.credits).toBe(8);
    expect(r.month.credits).toBe(8);
    expect(r.state).toBe('ok');
    expect(r.limits.rpm).toBe(30);
  });

  it('acquire simultâneos não passam do RPM (31 chamadas ao mesmo tempo → 30 ok)', async () => {
    const { svc } = criar({ DOTCOMPANY_MAX_REQUESTS_HOUR: '1000' });
    const rs = await Promise.all(
      Array.from({ length: 31 }, () => svc.acquire({ kind: 'batch', estimatedCredits: 0 })),
    );
    expect(rs.filter((r) => r.ok)).toHaveLength(30);
    expect(rs.filter((r) => !r.ok && r.reason === 'rate_window')).toHaveLength(1);
  });

  it('acquire simultâneos não passam do limite de créditos por hora (reserva em memória)', async () => {
    const { svc } = criar({ DOTCOMPANY_MAX_CREDITS_HOUR: '400' });
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => svc.acquire({ kind: 'interactive', estimatedCredits: 100 })),
    );
    expect(rs.filter((r) => r.ok)).toHaveLength(4);
    expect(rs.filter((r) => !r.ok).every((r) => r.reason === 'hour_limit')).toBe(true);
  });

  it('acquire simultâneos não passam do limite de requisições por hora', async () => {
    const { svc } = criar({ DOTCOMPANY_MAX_REQUESTS_HOUR: '5' });
    const rs = await Promise.all(
      Array.from({ length: 12 }, () => svc.acquire({ kind: 'interactive', estimatedCredits: 4 })),
    );
    expect(rs.filter((r) => r.ok)).toHaveLength(5);
  });

  it('release devolve a reserva: depois dele só vale o consumo gravado', async () => {
    const { svc } = criar({ DOTCOMPANY_MAX_CREDITS_HOUR: '400' });
    const a = await svc.acquire({ kind: 'interactive', estimatedCredits: 400 });
    expect(a).toMatchObject({ ok: true, reserved: 400 });
    expect((await svc.acquire({ kind: 'interactive', estimatedCredits: 4 })).ok).toBe(false);
    // O lote achou só 10 itens (40 créditos): a reserva de 400 some e fica o gasto real.
    await svc.release({ kind: 'interactive', credits: 40, reserved: a.reserved });
    expect((await svc.acquire({ kind: 'interactive', estimatedCredits: 300 })).ok).toBe(true);
  });

  it('peek não ocupa vaga nem apaga as vagas ocupadas por acquire concorrentes', async () => {
    const { svc } = criar({ DOTCOMPANY_MAX_REQUESTS_HOUR: '1000' });
    const [, , , peeked] = await Promise.all([
      svc.acquire({ kind: 'batch', estimatedCredits: 0 }),
      svc.acquire({ kind: 'batch', estimatedCredits: 0 }),
      svc.acquire({ kind: 'batch', estimatedCredits: 0 }),
      svc.peek({ kind: 'batch', estimatedCredits: 0 }),
    ]);
    expect(peeked.ok).toBe(true);
    // 3 vagas continuam ocupadas e o peek não ocupou nenhuma: restam 27.
    const rs = await Promise.all(
      Array.from({ length: 28 }, () => svc.acquire({ kind: 'batch', estimatedCredits: 0 })),
    );
    expect(rs.filter((r) => r.ok)).toHaveLength(27);
  });

  it('refundCredits volta para a hora do lançamento (atravessando hora e dia), com piso zero', async () => {
    const { svc, setNow } = criar({}, { saldo: 1000 });
    await svc.refreshBalance();
    // Estimado lançado às 23:05 de SP (02:05Z do dia seguinte); depois, consumo em outra hora e outro dia.
    const lancadoEm = new Date('2099-03-11T02:05:00Z');
    setNow(lancadoEm);
    await svc.release({ kind: 'batch', credits: 8 });
    setNow(new Date('2099-03-11T03:05:00Z')); // 00:05 do dia seguinte em SP
    await svc.release({ kind: 'batch', credits: 4 });
    setNow(new Date('2099-03-11T04:05:00Z'));
    await svc.refundCredits(6, lancadoEm);
    const rows: Array<{ credits: number }> = await ds.query(
      `SELECT credits FROM dotcompany_usage_hourly WHERE hour >= '2099-01-01' ORDER BY hour`,
    );
    expect(rows.map((r) => r.credits)).toEqual([2, 4]);
    // Pedir mais do que existe na hora nunca deixa contador negativo.
    await svc.refundCredits(100, lancadoEm);
    const after: Array<{ credits: number }> = await ds.query(
      `SELECT credits FROM dotcompany_usage_hourly WHERE hour >= '2099-01-01' ORDER BY hour`,
    );
    expect(after.map((r) => r.credits)).toEqual([0, 4]);
  });

  it('dois estornos concorrentes não deixam contador negativo nem somam o saldo duas vezes além do devido', async () => {
    const { svc } = criar({}, { saldo: 1000 });
    await svc.refreshBalance();
    await svc.release({ kind: 'batch', credits: 4 });
    await Promise.all([svc.refundCredits(4, T0), svc.refundCredits(4, T0)]);
    const rows: Array<{ credits: number }> = await ds.query(
      `SELECT credits FROM dotcompany_usage_hourly WHERE hour >= '2099-01-01'`,
    );
    expect(rows.every((r) => r.credits >= 0)).toBe(true);
    expect(rows[0].credits).toBe(0);
  });

  it('refundCredits devolve ao saldo se ele não foi conferido depois do lançamento e rearma os alertas', async () => {
    const { svc, setNow } = criar({ DOTCOMPANY_ALERT_CREDITS: '1000' }, { saldo: 1002 });
    await svc.refreshBalance(); // conferido em T0
    setNow(new Date(T0.getTime() + 60_000));
    const lancadoEm = new Date(T0.getTime() + 60_000);
    await svc.release({ kind: 'batch', credits: 4 }); // 998: abaixo do limiar
    await ds.query(`UPDATE dotcompany_balance SET "lowAlertSentAt" = now() WHERE id = 1`);
    await svc.refundCredits(4, lancadoEm);
    const [b] = await ds.query(
      `SELECT available, "lowAlertSentAt" FROM dotcompany_balance WHERE id = 1`,
    );
    expect(b.available).toBe(1002);
    expect(b.lowAlertSentAt).toBeNull(); // voltou acima do limiar: alerta rearmado
    expect((await svc.report()).balance.available).toBe(1002);
  });

  it('refundCredits não mexe no saldo conferido na DotCompany depois do lançamento', async () => {
    const { svc, setNow } = criar({}, { saldo: 1000 });
    const lancadoEm = T0;
    setNow(T0);
    await svc.release({ kind: 'batch', credits: 4 });
    setNow(new Date(T0.getTime() + 60_000));
    await svc.refreshBalance(); // /usage depois do lançamento: 1000 já é o real
    await svc.refundCredits(4, lancadoEm);
    const [b] = await ds.query(`SELECT available FROM dotcompany_balance WHERE id = 1`);
    expect(b.available).toBe(1000);
    const rows: Array<{ credits: number }> = await ds.query(
      `SELECT credits FROM dotcompany_usage_hourly WHERE hour >= '2099-01-01'`,
    );
    expect(rows[0].credits).toBe(0); // o contador por hora ainda é nosso e é desfeito
  });
});
