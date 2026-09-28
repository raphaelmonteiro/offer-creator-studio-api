import { DataSource } from 'typeorm';
import { EanMatchItem } from './entities/ean-match-item.entity';
import { EanMatchJob } from './entities/ean-match-job.entity';
import { EanMatchStore } from './ean-match.store';
import { criarDataSourceDeTeste, EAN_IT_ENABLED } from './ean-test-db';

/**
 * Teste de integração contra um Postgres real — valida o SQL do SKIP LOCKED e
 * o formato de retorno do driver. Roda só com EAN_IT_DB_PORT/EAN_IT_DB_NAME
 * apontando para um banco DESCARTÁVEL já migrado, por exemplo:
 *
 *   EAN_IT_DB_PORT=5433 EAN_IT_DB_NAME=ean_mig_test npx jest ean-match.store
 */
const d = EAN_IT_ENABLED ? describe : describe.skip;

d('EanMatchStore (Postgres real)', () => {
  let ds: DataSource;
  let store: EanMatchStore;
  let jobId: string;

  beforeAll(async () => {
    ds = criarDataSourceDeTeste();
    await ds.initialize();
    store = new EanMatchStore(ds);
  });

  beforeEach(async () => {
    const job = await ds.getRepository(EanMatchJob).save({
      status: 'running',
      fileHash: 'x'.repeat(64),
      costCapUsd: '1.0000',
    });
    jobId = job.id;
    await ds.getRepository(EanMatchItem).insert(
      [1, 2, 3, 4, 5].map((n) => ({
        jobId,
        rowNumber: n,
        ean: '7891000100103',
        description: `P${n}`,
      })),
    );
  });

  afterEach(async () => {
    await ds.getRepository(EanMatchJob).delete({ id: jobId });
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('dois processos concorrentes nunca travam o mesmo item', async () => {
    const [a, b] = await Promise.all([
      store.travarPendentes(jobId, 3),
      store.travarPendentes(jobId, 3),
    ]);
    const ids = [...a, ...b].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(5);
    expect([...a, ...b].every((i) => i.attempts === 1 && i.lockedAt)).toBe(true);
  });

  it('item decidido não volta; item liberado volta', async () => {
    const [x, y] = await store.travarPendentes(jobId, 2);
    await store.salvarItem(x.id, { status: 'no-image' }, 0.0123);
    await store.liberarItem(y.id);

    const proximos = (await store.travarPendentes(jobId, 10)).map((i) => i.id);
    expect(proximos).not.toContain(x.id);
    expect(proximos).toContain(y.id);

    const salvo = await ds.getRepository(EanMatchItem).findOneByOrFail({ id: x.id });
    expect(salvo.lockedAt).toBeNull();
    expect(Number(salvo.costUsd)).toBeCloseTo(0.0123, 4);
  });

  it('trava abandonada há mais de 10 minutos é recuperada', async () => {
    const [x] = await store.travarPendentes(jobId, 1);
    await ds.query(
      `UPDATE ean_match_items SET "lockedAt" = now() - interval '11 minutes' WHERE id = $1`,
      [x.id],
    );
    const ids = (await store.travarPendentes(jobId, 10)).map((i) => i.id);
    expect(ids).toContain(x.id);
  });

  it('soma custo e respeita pausa manual', async () => {
    expect(await store.somarCusto(jobId, 0.4)).toEqual({ custo: 0.4, teto: 1 });
    await ds.query(`UPDATE ean_match_jobs SET status = 'paused' WHERE id = $1`, [jobId]);
    await store.mudarStatusSeExecutando(jobId, 'done');
    const job = await ds.getRepository(EanMatchJob).findOneByOrFail({ id: jobId });
    expect(job.status).toBe('paused');
    expect(await store.contarAbertos(jobId)).toBe(5);
  });
});
