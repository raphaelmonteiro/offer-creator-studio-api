import { DataSource } from 'typeorm';
import { criarDataSourceDeTeste, EAN_IT_ENABLED } from '../ean-test-db';
import {
  DotcompanyClient,
  DotcompanyIdempotencyError,
  DotcompanyNoCreditError,
  DotcompanyRateLimitedError,
  DotcompanyTransientError,
} from './dotcompany.client';
import { classifyEan, DotcompanyLookupService } from './dotcompany-lookup.service';

describe('classifyEan', () => {
  it.each([
    ['7891000100103', 'valid', '7891000100103'],
    ['789 1000-100103', 'valid', '7891000100103'],
    ['036000291452', 'valid', '0036000291452'], // UPC-A → EAN-13
    ['07891000100103', 'valid', '7891000100103'], // GTIN-14 com zero
    ['7891000100104', 'invalid', '7891000100104'],
    ['12345', 'invalid', '12345'],
    ['2000123000008', 'internal_use', '2000123000008'],
    ['7890000000017', 'internal_use', '7890000000017'],
  ])('%s → %s', (raw, status, ean) => {
    const c = classifyEan(raw);
    expect(c.status).toBe(status);
    expect(c.ean).toBe(ean);
  });
});

/**
 * Cache-first e passagem pelo controlador, contra Postgres real:
 *
 *   EAN_IT_DB_PORT=5433 EAN_IT_DB_NAME=ean_mig_test npx jest dotcompany-lookup
 */
const d = EAN_IT_ENABLED ? describe : describe.skip;

/** EANs válidos (checksum) só para estes testes, prefixo 7896 + sequência. */
function eanTeste(n: number): string {
  const base = `789699${String(n).padStart(6, '0')}`;
  const digits = base.split('').map(Number);
  let sum = 0;
  let w = 3;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += digits[i] * w;
    w = w === 3 ? 1 : 3;
  }
  return base + ((10 - (sum % 10)) % 10);
}

d('DotcompanyLookupService (Postgres real)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = criarDataSourceDeTeste();
    await ds.initialize();
  });
  const limpar = async () => {
    await ds.query(`DELETE FROM dotcompany_lookups WHERE ean LIKE '789699%'`);
    await ds.query(`DELETE FROM dotcompany_pending_batches WHERE gtins::text LIKE '%789699%'`);
  };
  beforeEach(limpar);
  afterAll(async () => {
    await limpar();
    await ds.destroy();
  });

  function criar(encontrados: Set<string>, opts: { negar?: boolean } = {}) {
    const client = {
      lookupBatch: jest.fn(async (gtins: string[]) => ({
        items: gtins.map((g) =>
          encontrados.has(g)
            ? {
                gtin: g,
                encontrado: true,
                produto: { gtin: g, nome: `PRODUTO ${g}`, imagem_url: `https://img/${g}.png` },
              }
            : { gtin: g, encontrado: false, produto: null },
        ),
        creditsCharged: null,
        rate: null,
        requestId: 'r',
        status: 200,
      })),
      lookupSingle: jest.fn(),
    };
    let agora = new Date('2026-10-10T12:00:00Z');
    const budget = {
      now: () => agora,
      acquire: jest.fn(async () =>
        opts.negar
          ? {
              ok: false,
              reason: 'reserve',
              retryAt: new Date('2026-10-10T12:15:00Z'),
              message: 'reserva',
            }
          : { ok: true, reason: null, retryAt: null, message: null, reserved: 4 },
      ),
      release: jest.fn(async () => undefined),
      onNoCredit: jest.fn(async () => undefined),
      onRateLimited: jest.fn(),
      refundCredits: jest.fn(async () => undefined),
    };
    const svc = new DotcompanyLookupService(ds, client as never, budget as never);
    return { svc, client, budget, setNow: (dt: Date) => (agora = dt) };
  }

  it('inválido e uso interno não chamam a DotCompany', async () => {
    const { svc, client } = criar(new Set());
    const r = await svc.resolve(['7891000100104', '2000123000008'], { kind: 'batch' });
    expect(r.outcomes.get('7891000100104')?.status).toBe('invalid');
    expect(r.outcomes.get('2000123000008')?.status).toBe('internal_use');
    expect(client.lookupBatch).not.toHaveBeenCalled();
  });

  it('lote com acertos e faltas: tudo no cache, custo = 4 × encontrados', async () => {
    const eans = Array.from({ length: 100 }, (_, i) => eanTeste(i));
    const { svc, budget } = criar(new Set(eans.slice(0, 80)));
    const r = await svc.resolve(eans, { kind: 'batch' });
    expect(r.credits).toBe(320);
    expect(budget.release).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 320, found: 80, notFound: 20 }),
    );
    const [{ n }] = await ds.query(
      `SELECT count(*)::int AS n FROM dotcompany_lookups WHERE ean LIKE '789699%'`,
    );
    expect(n).toBe(100);
    expect(r.outcomes.get(eans[0])?.status).toBe('found');
    expect(r.outcomes.get(eans[99])?.status).toBe('not_found');
  });

  it('mesmo EAN em dois cadastros: uma única chamada; a segunda sai do cache', async () => {
    const e = eanTeste(500);
    const { svc, client } = criar(new Set([e]));
    await svc.resolve([e], { kind: 'batch' });
    const r = await svc.resolve([e], { kind: 'batch' });
    expect(client.lookupBatch).toHaveBeenCalledTimes(1);
    expect(r.outcomes.get(e)).toMatchObject({ status: 'found', cached: true });
    expect(r.credits).toBe(0);
  });

  it('não encontrado: sem chamada antes da nova tentativa; consulta depois dela', async () => {
    const e = eanTeste(600);
    const { svc, client, setNow } = criar(new Set());
    await svc.resolve([e], { kind: 'batch' });
    await svc.resolve([e], { kind: 'batch' });
    expect(client.lookupBatch).toHaveBeenCalledTimes(1);
    setNow(new Date('2026-11-15T12:00:00Z')); // > 30 dias
    await svc.resolve([e], { kind: 'batch' });
    expect(client.lookupBatch).toHaveBeenCalledTimes(2);
  });

  it('chamada negada pelo controlador não chega à DotCompany', async () => {
    const e = eanTeste(700);
    const { svc, client } = criar(new Set([e]), { negar: true });
    const r = await svc.resolve([e], { kind: 'batch' });
    expect(client.lookupBatch).not.toHaveBeenCalled();
    expect(r.outcomes.get(e)).toMatchObject({ status: 'blocked', blockReason: 'reserve' });
    expect(r.blocked?.reason).toBe('reserve');
  });

  it('402 avisa o controlador e deixa os EANs pendentes (bloqueados), sem marcar erro', async () => {
    const e = eanTeste(800);
    const { svc, client, budget } = criar(new Set([e]));
    client.lookupBatch.mockRejectedValueOnce(
      new DotcompanyNoCreditError('402', 402, 'INSUFFICIENT_CREDITS', null),
    );
    const r = await svc.resolve([e], { kind: 'batch' });
    expect(budget.onNoCredit).toHaveBeenCalled();
    expect(r.outcomes.get(e)).toMatchObject({ status: 'blocked', blockReason: 'no_credit' });
    const rows = await ds.query(`SELECT 1 FROM dotcompany_lookups WHERE ean = $1`, [e]);
    expect(rows).toHaveLength(0);
  });

  it('a chave do resultado é o valor de entrada (UPC-A casa com o EAN-13 do cache)', async () => {
    const { svc, client } = criar(new Set(['0036000291452']));
    const r = await svc.resolve(['036000291452'], { kind: 'batch' });
    expect(client.lookupBatch).toHaveBeenCalledWith(['0036000291452'], expect.anything());
    expect(r.outcomes.get('036000291452')).toMatchObject({ status: 'found', ean: '0036000291452' });
    await ds.query(`DELETE FROM dotcompany_lookups WHERE ean = '0036000291452'`);
  });

  it('o mesmo EAN consultado em paralelo (encarte + job) paga uma vez só', async () => {
    const e = eanTeste(900);
    const { svc, client, budget } = criar(new Set([e]));
    client.lookupBatch.mockImplementationOnce(async (gtins: string[]) => {
      await new Promise((r) => setTimeout(r, 80));
      return {
        items: gtins.map((g) => ({
          gtin: g,
          encontrado: true,
          produto: { gtin: g, nome: `PRODUTO ${g}`, imagem_url: null },
        })),
        creditsCharged: null,
        rate: null,
        requestId: 'r',
        status: 200,
      };
    });
    const [a, b] = await Promise.all([
      svc.resolve([e], { kind: 'interactive' }),
      svc.resolve([e], { kind: 'batch' }),
    ]);
    expect(client.lookupBatch).toHaveBeenCalledTimes(1);
    expect(budget.acquire).toHaveBeenCalledTimes(1);
    expect(a.outcomes.get(e)).toMatchObject({ status: 'found', cached: false });
    expect(b.outcomes.get(e)).toMatchObject({ status: 'found', cached: true });
    expect(a.credits + b.credits).toBe(4);
  });

  it('EAN em voo + EAN novo: o segundo chamador consulta só o que ninguém consultou', async () => {
    const e1 = eanTeste(910);
    const e2 = eanTeste(911);
    const { svc, client } = criar(new Set([e1, e2]));
    const original = client.lookupBatch.getMockImplementation()!;
    client.lookupBatch.mockImplementationOnce(async (g: string[]) => {
      await new Promise((r) => setTimeout(r, 60));
      return original(g);
    });
    await Promise.all([
      svc.resolve([e1], { kind: 'interactive' }),
      svc.resolve([e1, e2], { kind: 'batch' }),
    ]);
    const pedidos = (client.lookupBatch.mock.calls as unknown as string[][][]).map((c) => c[0]);
    expect(pedidos.flat().filter((x) => x === e1)).toHaveLength(1);
    expect(pedidos.flat().filter((x) => x === e2)).toHaveLength(1);
  });

  it('consulta em voo que falhou: quem esperava tenta por conta própria', async () => {
    const e = eanTeste(920);
    const { svc, client } = criar(new Set([e]));
    client.lookupBatch.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 40));
      throw new Error('rede');
    });
    const [a, b] = await Promise.all([
      svc.resolve([e], { kind: 'interactive' }),
      svc.resolve([e], { kind: 'batch' }),
    ]);
    // Quem chegou primeiro à frente da fila é o dono da consulta que falhou.
    expect([a, b].map((r) => r.outcomes.get(e)?.status).sort()).toEqual(['error', 'found']);
    expect(client.lookupBatch).toHaveBeenCalledTimes(2);
  });

  /** Timeout do próprio cliente: o que o DotcompanyClient real lança depois das tentativas. */
  const timeoutDoCliente = () =>
    new DotcompanyTransientError(
      'DotCompany POST /catalogo/gtin/batch: falha de rede (timeout de 15000ms).',
      null,
      null,
      null,
      'timeout',
    );

  /** Resposta 5xx do servidor (o cliente não repete sozinho): a DotCompany não cobra. */
  const erro5xx = () =>
    new DotcompanyTransientError(
      'DotCompany POST /catalogo/gtin/batch → 503',
      503,
      null,
      'req-5xx',
      'http_5xx',
    );
  const conflito = (code: string) => new DotcompanyIdempotencyError('409', 409, code, null);
  const chaveDaChamada = (client: { lookupBatch: jest.Mock }, n: number) =>
    ((client.lookupBatch.mock.calls[n] as unknown[])[1] as { idempotencyKey: string })
      .idempotencyKey;

  function respostaOk(gtins: string[], extra: { replay?: boolean; credits?: number | null } = {}) {
    return {
      items: gtins.map((g) => ({
        gtin: g,
        encontrado: true,
        produto: { gtin: g, nome: `PRODUTO ${g}`, imagem_url: null },
      })),
      creditsCharged: extra.credits ?? null,
      rate: null,
      requestId: 'r',
      status: 200,
      replay: extra.replay ?? false,
    };
  }

  const creditosLancados = (release: jest.Mock) =>
    (release.mock.calls as unknown as Array<[{ credits?: number }]>).map((c) => c[0].credits ?? 0);

  const pendentes = (e: string) =>
    ds.query(
      `SELECT "idempotencyKey", gtins, attempts, "creditsRecorded", "creditsRecordedAt", "lastOutcome", "retryNotBefore"
         FROM dotcompany_pending_batches WHERE gtins ? $1`,
      [e],
    );

  it('timeout do cliente: grava o lote pendente com a chave e lança o custo estimado', async () => {
    const e = eanTeste(930);
    const { svc, client, budget } = criar(new Set([e]));
    client.lookupBatch.mockRejectedValueOnce(timeoutDoCliente());
    const r = await svc.resolve([e], { kind: 'interactive' });
    expect(r.outcomes.get(e)?.status).toBe('error');
    expect(budget.release).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 4, errors: 1, reserved: 4 }),
    );
    const [p] = await pendentes(e);
    const chave = (client.lookupBatch.mock.calls[0] as unknown[])[1] as { idempotencyKey: string };
    expect(p).toMatchObject({
      idempotencyKey: chave.idempotencyKey,
      gtins: [e],
      attempts: 1,
      lastOutcome: 'timeout',
    });
    expect(p.creditsRecorded).toBe(4);
  });

  it('próxima resolução repete o MESMO lote com a MESMA chave; replay não soma custo de novo', async () => {
    const [e, f] = [eanTeste(931), eanTeste(932)];
    const { svc, client, budget } = criar(new Set([e, f]));
    client.lookupBatch.mockRejectedValueOnce(timeoutDoCliente());
    await svc.resolve([e, f], { kind: 'batch' });
    const chave = (client.lookupBatch.mock.calls[0] as unknown[])[1] as { idempotencyKey: string };
    client.lookupBatch.mockImplementationOnce(async (g: string[]) =>
      respostaOk(g, { replay: true, credits: 8 }),
    );
    budget.release.mockClear();

    // Só um dos dois EANs é pedido agora: o lote repetido continua sendo o original, inteiro.
    const r = await svc.resolve([f], { kind: 'batch' });
    expect(client.lookupBatch).toHaveBeenCalledTimes(2);
    expect(client.lookupBatch).toHaveBeenLastCalledWith([e, f], {
      idempotencyKey: chave.idempotencyKey,
    });
    expect(r.outcomes.get(f)).toMatchObject({ status: 'found', cached: false });
    // 8 créditos reais - 8 já lançados na incerteza (4 × 2 itens) = nada novo no consumo.
    expect(budget.release).toHaveBeenCalledTimes(1);
    expect(budget.release).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 0, found: 2, reserved: 4 }),
    );
    expect(await pendentes(e)).toHaveLength(0);
    // Resolvido e em cache: uma terceira resolução não chama de novo.
    await svc.resolve([e], { kind: 'batch' });
    expect(client.lookupBatch).toHaveBeenCalledTimes(2);
  });

  it('o servidor não tinha processado (sem replay): só a diferença sobre o estimado é lançada', async () => {
    const e = eanTeste(933);
    const { svc, client, budget } = criar(new Set([e]));
    client.lookupBatch.mockRejectedValueOnce(timeoutDoCliente());
    await svc.resolve([e], { kind: 'batch' });
    budget.release.mockClear();
    const r = await svc.resolve([e], { kind: 'batch' });
    expect(r.outcomes.get(e)?.status).toBe('found');
    expect(budget.release).toHaveBeenCalledWith(expect.objectContaining({ credits: 0, found: 1 }));
  });

  it('o job que chega com os mesmos EANs não monta lote novo enquanto há pendente', async () => {
    const [a, b, c] = [eanTeste(934), eanTeste(935), eanTeste(936)];
    const { svc, client } = criar(new Set([a, b, c]));
    client.lookupBatch.mockRejectedValueOnce(timeoutDoCliente());
    await svc.resolve([a, b], { kind: 'interactive' }); // encarte: incerto
    const chave = (client.lookupBatch.mock.calls[0] as unknown[])[1] as { idempotencyKey: string };
    await svc.resolve([a, c], { kind: 'batch' }); // job `flyer`
    const chamadas = client.lookupBatch.mock.calls as unknown as Array<
      [string[], { idempotencyKey: string }]
    >;
    expect(chamadas).toHaveLength(3);
    expect(chamadas[1]).toEqual([[a, b], { idempotencyKey: chave.idempotencyKey }]);
    expect(chamadas[2][0]).toEqual([c]);
    expect(chamadas[2][1].idempotencyKey).not.toBe(chave.idempotencyKey);
  });

  it('timeout → mesma chave → 409 IN_FLIGHT (ainda processando) → espera ≥ 30 s → replay: nenhum custo extra, nunca chave nova', async () => {
    const e = eanTeste(937);
    const { svc, client, budget, setNow } = criar(new Set([e]));
    client.lookupBatch.mockRejectedValueOnce(timeoutDoCliente());
    await svc.resolve([e], { kind: 'batch' });

    client.lookupBatch.mockRejectedValueOnce(conflito('IDEMPOTENCY_IN_FLIGHT'));
    const r2 = await svc.resolve([e], { kind: 'batch' });
    expect(client.lookupBatch).toHaveBeenCalledTimes(2);
    expect(chaveDaChamada(client, 1)).toBe(chaveDaChamada(client, 0));
    expect(r2.outcomes.get(e)).toMatchObject({ status: 'blocked', blockReason: 'batch_in_flight' });
    expect(r2.blocked?.reason).toBe('batch_in_flight');
    const [p] = await pendentes(e);
    expect(p).toMatchObject({ attempts: 1, creditsRecorded: 4, lastOutcome: 'timeout' });
    expect(p.retryNotBefore).not.toBeNull();

    // Dentro dos 30 s: nem chega ao controlador nem à DotCompany.
    setNow(new Date('2026-10-10T12:00:20Z'));
    budget.acquire.mockClear();
    const r3 = await svc.resolve([e], { kind: 'batch' });
    expect(client.lookupBatch).toHaveBeenCalledTimes(2);
    expect(budget.acquire).not.toHaveBeenCalled();
    expect(r3.outcomes.get(e)).toMatchObject({ status: 'blocked', blockReason: 'batch_in_flight' });

    // Depois do intervalo: a MESMA chave devolve o replay (o servidor já completou e cobrou 4).
    setNow(new Date('2026-10-10T12:00:40Z'));
    client.lookupBatch.mockImplementationOnce(async (g: string[]) =>
      respostaOk(g, { replay: true, credits: 4 }),
    );
    const r4 = await svc.resolve([e], { kind: 'batch' });
    expect(r4.outcomes.get(e)?.status).toBe('found');
    expect(client.lookupBatch).toHaveBeenCalledTimes(3);
    expect(chaveDaChamada(client, 2)).toBe(chaveDaChamada(client, 0));
    // Lançado: 4 (estimado da incerteza) + 0 (IN_FLIGHT) + 0 (replay: real 4 − 4 já lançado).
    expect(creditosLancados(budget.release)).toEqual([4, 0, 0]);
    expect(await pendentes(e)).toHaveLength(0);
    expect(budget.refundCredits).not.toHaveBeenCalled();
  });

  it('5xx → ORPHANED: chave nova; nada lançado pelo 5xx, o custo final é só o real', async () => {
    const e = eanTeste(1043);
    const { svc, client, budget } = criar(new Set([e]));
    client.lookupBatch.mockRejectedValueOnce(erro5xx());
    const r1 = await svc.resolve([e], { kind: 'batch' });
    expect(r1.outcomes.get(e)?.status).toBe('error');
    expect(budget.release).toHaveBeenLastCalledWith(expect.objectContaining({ errors: 1 }));
    expect(creditosLancados(budget.release)).toEqual([0]);
    const [p] = await pendentes(e);
    expect(p).toMatchObject({ lastOutcome: 'http_5xx', creditsRecorded: null });

    client.lookupBatch.mockRejectedValueOnce(conflito('IDEMPOTENCY_KEY_ORPHANED'));
    const r2 = await svc.resolve([e], { kind: 'batch' });
    expect(r2.outcomes.get(e)?.status).toBe('found');
    expect(client.lookupBatch).toHaveBeenCalledTimes(3);
    expect(chaveDaChamada(client, 1)).toBe(chaveDaChamada(client, 0));
    expect(chaveDaChamada(client, 2)).not.toBe(chaveDaChamada(client, 0));
    expect(creditosLancados(budget.release)).toEqual([0, 0, 4]);
    expect(budget.refundCredits).not.toHaveBeenCalled();
    expect(await pendentes(e)).toHaveLength(0);
  });

  it('timeout → 5xx na repetição → ORPHANED: o estimado do timeout é desfeito (último desfecho = 5xx), custo final = só o real', async () => {
    const e = eanTeste(1045);
    const { svc, client, budget } = criar(new Set([e]));
    client.lookupBatch.mockRejectedValueOnce(timeoutDoCliente());
    await svc.resolve([e], { kind: 'batch' });
    client.lookupBatch.mockRejectedValueOnce(erro5xx());
    await svc.resolve([e], { kind: 'batch' });
    const [p] = await pendentes(e);
    expect(p).toMatchObject({ lastOutcome: 'http_5xx', creditsRecorded: 4 });
    expect(p.creditsRecordedAt).toBeInstanceOf(Date);

    client.lookupBatch.mockRejectedValueOnce(conflito('IDEMPOTENCY_KEY_ORPHANED'));
    const r = await svc.resolve([e], { kind: 'batch' });
    expect(r.outcomes.get(e)?.status).toBe('found');
    expect(budget.refundCredits).toHaveBeenCalledTimes(1);
    expect(budget.refundCredits).toHaveBeenCalledWith(4, expect.any(Date));
    const lancado = (creditosLancados(budget.release) as number[]).reduce((a, b) => a + b, 0);
    expect(lancado - 4).toBe(4); // 4 (estimado) + 4 (real) − 4 (estorno) = só o real
    expect(chaveDaChamada(client, 3)).not.toBe(chaveDaChamada(client, 0));
  });

  it('5xx → IN_FLIGHT (reserva presa) → ORPHANED: o IN_FLIGHT não apaga o desfecho 5xx; uma única chave nova no fim', async () => {
    const e = eanTeste(1046);
    const { svc, client, budget, setNow } = criar(new Set([e]));
    client.lookupBatch.mockRejectedValueOnce(erro5xx());
    await svc.resolve([e], { kind: 'batch' });
    client.lookupBatch.mockRejectedValueOnce(conflito('IDEMPOTENCY_IN_FLIGHT'));
    await svc.resolve([e], { kind: 'batch' });
    expect(await pendentes(e)).toEqual([
      expect.objectContaining({ lastOutcome: 'http_5xx', attempts: 1 }),
    ]);
    setNow(new Date('2026-10-10T12:03:30Z'));
    client.lookupBatch.mockRejectedValueOnce(conflito('IDEMPOTENCY_KEY_ORPHANED'));
    const r = await svc.resolve([e], { kind: 'batch' });
    expect(r.outcomes.get(e)?.status).toBe('found');
    const chaves = new Set(
      (client.lookupBatch.mock.calls as unknown[][]).map(
        (c) => (c[1] as { idempotencyKey: string }).idempotencyKey,
      ),
    );
    expect(chaves.size).toBe(2);
    expect(creditosLancados(budget.release)).toEqual([0, 0, 0, 4]);
  });

  it('timeout → ORPHANED: resultado incerto, o estimado é mantido (conservador) e a chave nova cobra o real', async () => {
    const e = eanTeste(1047);
    const { svc, client, budget } = criar(new Set([e]));
    client.lookupBatch.mockRejectedValueOnce(timeoutDoCliente());
    await svc.resolve([e], { kind: 'batch' });
    client.lookupBatch.mockRejectedValueOnce(conflito('IDEMPOTENCY_KEY_ORPHANED'));
    const r = await svc.resolve([e], { kind: 'batch' });
    expect(r.outcomes.get(e)?.status).toBe('found');
    expect(budget.refundCredits).not.toHaveBeenCalled();
    // 4 (estimado do timeout, mantido) + 0 (409) + 4 (real da chave nova).
    expect(creditosLancados(budget.release)).toEqual([4, 0, 4]);
    expect(chaveDaChamada(client, 2)).not.toBe(chaveDaChamada(client, 0));
  });

  it('429: EANs blocked/rate_window, janela bloqueada, nenhum custo; o lote é reenviado depois com a mesma chave', async () => {
    const e = eanTeste(1048);
    const { svc, client, budget, setNow } = criar(new Set([e]));
    client.lookupBatch.mockRejectedValueOnce(
      new DotcompanyRateLimitedError('429', 2, null, 'RATE_LIMITED', null),
    );
    const r = await svc.resolve([e], { kind: 'interactive' });
    expect(r.outcomes.get(e)).toMatchObject({ status: 'blocked', blockReason: 'rate_window' });
    expect(r.blocked?.reason).toBe('rate_window');
    expect(budget.onRateLimited).toHaveBeenCalledWith(2, null);
    expect(creditosLancados(budget.release)).toEqual([0]);
    expect(await pendentes(e)).toEqual([expect.objectContaining({ lastOutcome: 'http_4xx' })]);
    const rows = await ds.query(`SELECT 1 FROM dotcompany_lookups WHERE ean = $1`, [e]);
    expect(rows).toHaveLength(0);

    // Depois da janela: mesma chave. Se o servidor ainda segura a reserva, é IN_FLIGHT (não erro).
    setNow(new Date('2026-10-10T12:01:00Z'));
    client.lookupBatch.mockRejectedValueOnce(conflito('IDEMPOTENCY_IN_FLIGHT'));
    const r2 = await svc.resolve([e], { kind: 'interactive' });
    expect(chaveDaChamada(client, 1)).toBe(chaveDaChamada(client, 0));
    expect(r2.outcomes.get(e)).toMatchObject({ status: 'blocked', blockReason: 'batch_in_flight' });
    expect(budget.refundCredits).not.toHaveBeenCalled();
  });

  it('lote fechado por outro chamador entre a leitura e o reenvio não é reenviado nem contado de novo (R27)', async () => {
    const e = eanTeste(1049);
    const { client, budget, svc } = criar(new Set([e]));
    client.lookupBatch.mockRejectedValueOnce(timeoutDoCliente());
    await svc.resolve([e], { kind: 'batch' });
    client.lookupBatch.mockClear();
    budget.release.mockClear();
    // Outro chamador fecha o lote logo antes do reenvio: apaga o pendente e grava o resultado no cache.
    const fechando = Object.create(ds) as DataSource;
    fechando.query = (async (sql: string, params?: unknown[]) => {
      if (String(sql).includes('SET attempts = attempts + 1')) {
        await ds.query(`DELETE FROM dotcompany_pending_batches WHERE gtins ? $1`, [e]);
        await ds.query(
          `INSERT INTO dotcompany_lookups (ean, status, raw, "fetchedAt") VALUES ($1, 'found', $2::jsonb, now())
           ON CONFLICT (ean) DO UPDATE SET status = 'found', raw = EXCLUDED.raw`,
          [e, JSON.stringify({ gtin: e, encontrado: true, produto: { gtin: e, nome: 'X' } })],
        );
      }
      return ds.query(sql, params);
    }) as DataSource['query'];
    const svc2 = new DotcompanyLookupService(fechando, client as never, budget as never);
    const r = await svc2.resolve([e], { kind: 'batch' });
    expect(client.lookupBatch).not.toHaveBeenCalled();
    expect(r.outcomes.get(e)).toMatchObject({ status: 'found', cached: true });
    expect(budget.release).toHaveBeenCalledTimes(1);
    expect(budget.release).toHaveBeenCalledWith(
      expect.objectContaining({ requests: 0, reserved: 4 }),
    );
  });

  it('com o DotcompanyClient real: nenhum retry interno do lote; 5xx → IN_FLIGHT → ORPHANED → chave nova', async () => {
    const e = eanTeste(1050);
    const fetchMock = jest.fn();
    const config = {
      get: (k: string) => (k === 'DOTCOMPANY_API_TOKEN' ? 'dc_test.segredo' : undefined),
    };
    const real = new DotcompanyClient(config as never);
    const sleep = jest.fn(async () => undefined);
    real.fetchImpl = fetchMock as never;
    real.sleep = sleep;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      });
    const { budget, setNow } = criar(new Set([e]));
    const svc = new DotcompanyLookupService(ds, real, budget as never);
    const chave = (n: number) =>
      (fetchMock.mock.calls[n] as [string, { headers: Record<string, string> }])[1].headers[
        'Idempotency-Key'
      ];

    fetchMock.mockResolvedValueOnce(json(503, {}));
    const r1 = await svc.resolve([e], { kind: 'batch' });
    expect(r1.outcomes.get(e)?.status).toBe('error');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(json(409, {}, { 'X-Error-Code': 'IDEMPOTENCY_IN_FLIGHT' }));
    const r2 = await svc.resolve([e], { kind: 'batch' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r2.outcomes.get(e)).toMatchObject({ status: 'blocked', blockReason: 'batch_in_flight' });

    setNow(new Date('2026-10-10T12:04:00Z'));
    fetchMock.mockResolvedValueOnce(json(409, {}, { 'X-Error-Code': 'IDEMPOTENCY_KEY_ORPHANED' }));
    fetchMock.mockResolvedValueOnce(
      json(200, {
        itens: [{ gtin: e, encontrado: true, produto: { gtin: e, nome: 'X', imagem_url: null } }],
      }),
    );
    const r3 = await svc.resolve([e], { kind: 'batch' });
    expect(r3.outcomes.get(e)?.status).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(chave(1)).toBe(chave(0));
    expect(chave(2)).toBe(chave(0));
    expect(chave(3)).not.toBe(chave(0));
    expect(sleep).not.toHaveBeenCalled();
    expect(creditosLancados(budget.release)).toEqual([0, 0, 0, 4]);
  });

  it('409 IN_FLIGHT na primeira chamada: lote fica pendente com a mesma chave, sem custo e sem chave nova', async () => {
    const e = eanTeste(938);
    const { svc, client, budget } = criar(new Set([e]));
    client.lookupBatch.mockRejectedValueOnce(conflito('IDEMPOTENCY_IN_FLIGHT'));
    const r = await svc.resolve([e], { kind: 'batch' });
    expect(client.lookupBatch).toHaveBeenCalledTimes(1);
    expect(r.outcomes.get(e)).toMatchObject({ status: 'blocked', blockReason: 'batch_in_flight' });
    expect(creditosLancados(budget.release)).toEqual([0]);
    expect(await pendentes(e)).toHaveLength(1);
  });

  it('IDEMPOTENCY_KEY_CONFLICT é bug nosso: loga, não lança custo e usa chave nova', async () => {
    const e = eanTeste(939);
    const { svc, client, budget } = criar(new Set([e]));
    client.lookupBatch.mockRejectedValueOnce(
      new DotcompanyIdempotencyError('409', 409, 'IDEMPOTENCY_KEY_CONFLICT', null),
    );
    const r = await svc.resolve([e], { kind: 'batch' });
    expect(r.outcomes.get(e)?.status).toBe('found');
    const lancado = creditosLancados(budget.release);
    expect(lancado).toEqual([0, 4]);
  });

  it('erro conclusivo (402) descarta o pendente', async () => {
    const e = eanTeste(941);
    const { svc, client } = criar(new Set([e]));
    client.lookupBatch.mockRejectedValueOnce(
      new DotcompanyNoCreditError('402', 402, 'INSUFFICIENT_CREDITS', null),
    );
    await svc.resolve([e], { kind: 'batch' });
    expect(await pendentes(e)).toHaveLength(0);
  });

  it('pendente mais velho que 24 h é descartado em vez de repetido', async () => {
    const e = eanTeste(942);
    const { svc, client, setNow } = criar(new Set([e]));
    client.lookupBatch.mockRejectedValueOnce(timeoutDoCliente());
    await svc.resolve([e], { kind: 'batch' });
    setNow(new Date('2026-10-12T12:00:00Z'));
    await ds.query(`UPDATE dotcompany_pending_batches SET "createdAt" = $2 WHERE gtins ? $1`, [
      e,
      new Date('2026-10-10T12:00:00Z'),
    ]);
    await svc.resolve([e], { kind: 'batch' });
    const chamadas = client.lookupBatch.mock.calls as unknown as Array<
      [string[], { idempotencyKey: string }]
    >;
    expect(chamadas[1][1].idempotencyKey).not.toBe(chamadas[0][1].idempotencyKey);
  });

  it('orçamento negado: chamadores com mais de 100 EANs sobrepostos terminam (sem espera infinita)', async () => {
    const eans = Array.from({ length: 220 }, (_, i) => eanTeste(2000 + i));
    const y = eanTeste(1999);
    const { svc, budget } = criar(new Set(eans));
    // 1ª chamada ao controlador (o "runner" que consulta y) fica presa e depois é negada.
    let soltar!: () => void;
    const presa = new Promise<void>((r) => (soltar = r));
    const negado = {
      ok: false,
      reason: 'reserve',
      retryAt: new Date('2026-10-10T12:15:00Z'),
      message: 'reserva',
    };
    budget.acquire.mockImplementationOnce(async () => {
      await presa;
      return negado as never;
    });
    budget.acquire.mockImplementation(async () => negado as never);

    const runner = svc.resolve([y], { kind: 'batch' });
    await new Promise((r) => setTimeout(r, 30));
    // C espera y (do runner) e é dono de 2 lotes; o 1º é negado e o 2º ficaria preso.
    const c = svc.resolve([y, ...eans.slice(0, 200)], { kind: 'batch' });
    await new Promise((r) => setTimeout(r, 100));
    // P sobrepõe o 2º lote de C e passa de 100 EANs.
    const p = svc.resolve([...eans.slice(100, 200), ...eans.slice(200, 220)], { kind: 'batch' });
    const prazo = new Promise<string>((r) => setTimeout(() => r('travou'), 3000));
    expect(await Promise.race([p.then(() => 'ok'), prazo])).toBe('ok'); // runner ainda preso
    soltar();
    const todos = await Promise.race([
      Promise.all([runner, c, p]).then(() => 'ok'),
      new Promise<string>((r) => setTimeout(() => r('travou'), 3000)),
    ]);
    expect(todos).toBe('ok');
  });

  it('refreshOne: consulta paga sem resposta lança o estimado (4) e não repete sozinha', async () => {
    const e = eanTeste(943);
    const { svc, client, budget } = criar(new Set([e]));
    client.lookupSingle.mockRejectedValueOnce(timeoutDoCliente());
    const r = await svc.refreshOne(e, { kind: 'batch' });
    expect(r.status).toBe('error');
    expect(client.lookupSingle).toHaveBeenCalledTimes(1);
    expect(budget.release).toHaveBeenCalledTimes(1);
    expect(budget.release).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 4, errors: 1, reserved: 4 }),
    );
  });

  it('refreshOne: falha ao gravar depois do release não libera a reserva duas vezes', async () => {
    const e = eanTeste(944);
    const { client, budget } = criar(new Set([e]));
    client.lookupSingle.mockResolvedValueOnce({
      notModified: false,
      item: { gtin: e, encontrado: true, produto: { gtin: e, nome: 'X', imagem_url: null } },
      etag: 'W/"1"',
      creditsCharged: 4,
      rate: null,
      requestId: 'r',
      status: 200,
      replay: false,
    });
    const quebrado = Object.create(ds) as DataSource;
    quebrado.query = (async (sql: string, params?: unknown[]) => {
      if (String(sql).includes('INSERT INTO dotcompany_lookups')) throw new Error('disco cheio');
      return ds.query(sql, params);
    }) as DataSource['query'];
    const svc2 = new DotcompanyLookupService(quebrado, client as never, budget as never);
    const r = await svc2.refreshOne(e, { kind: 'batch' });
    expect(r.status).toBe('error');
    expect(budget.release).toHaveBeenCalledTimes(1);
  });

  it('o lote devolvido repassa a reserva ao release', async () => {
    const e = eanTeste(940);
    const { svc, budget } = criar(new Set([e]));
    await svc.resolve([e], { kind: 'batch' });
    expect(budget.release).toHaveBeenCalledWith(expect.objectContaining({ reserved: 4 }));
  });
});
