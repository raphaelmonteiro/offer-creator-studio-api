import { DataSource } from 'typeorm';
import { criarDataSourceDeTeste, EAN_IT_ENABLED } from '../ean-test-db';
import { DotcompanyNoCreditError } from './dotcompany.client';
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
  beforeEach(async () => ds.query(`DELETE FROM dotcompany_lookups WHERE ean LIKE '789699%'`));
  afterAll(async () => {
    await ds.query(`DELETE FROM dotcompany_lookups WHERE ean LIKE '789699%'`);
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
          : { ok: true, reason: null, retryAt: null, message: null },
      ),
      release: jest.fn(async () => undefined),
      onNoCredit: jest.fn(async () => undefined),
      onRateLimited: jest.fn(),
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
});
