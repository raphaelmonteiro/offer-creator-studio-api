import { DataSource } from 'typeorm';
import { criarDataSourceDeTeste, EAN_IT_ENABLED } from '../ean-test-db';
import { EanImportStore } from './ean-import.store';
import { EanImportJob } from './entities/ean-import-job.entity';

/**
 * Integração contra Postgres real (SKIP LOCKED, transições condicionais):
 *
 *   EAN_IT_DB_PORT=5433 EAN_IT_DB_NAME=ean_mig_test npx jest ean-import.store
 */
const d = EAN_IT_ENABLED ? describe : describe.skip;

d('EanImportStore (Postgres real)', () => {
  // Com várias suítes de integração em paralelo o banco divide a carga (R13).
  jest.setTimeout(30_000);

  let ds: DataSource;
  let store: EanImportStore;
  const jobs: string[] = [];

  beforeAll(async () => {
    ds = criarDataSourceDeTeste();
    await ds.initialize();
    store = new EanImportStore(ds);
  });

  afterEach(async () => {
    if (jobs.length) await ds.getRepository(EanImportJob).delete(jobs.splice(0));
  });

  afterAll(async () => ds.destroy());

  async function novoJob(n = 5, hash: string | null = null) {
    const job = await store.criarJob({
      kind: 'file',
      fileHash: hash,
      costCapCredits: 400,
      rows: [
        ...Array.from({ length: n }, (_, i) => ({
          rowNumber: i + 1,
          ean: `78910001001${String(i).padStart(2, '0')}`,
          description: `P${i + 1}`,
        })),
        {
          rowNumber: n + 1,
          ean: '7891000100100',
          description: 'repetido',
          result: 'duplicate' as const,
        },
      ],
    });
    jobs.push(job.id);
    return job;
  }

  it('cria o job com as linhas; linha já decidida nasce done', async () => {
    const job = await novoJob(3);
    expect(job.totalRows).toBe(4);
    expect(await store.contarAbertos(job.id)).toBe(3);
    expect((await store.contagens(job.id)).duplicate).toBe(1);
  });

  it('mesmo hash é encontrado (base do "mesmo arquivo → mesmo job")', async () => {
    const hash = 'a'.repeat(64);
    const job = await novoJob(1, hash);
    expect((await store.buscarPorHash(hash))?.id).toBe(job.id);
  });

  it('dois runners não travam o mesmo item (SKIP LOCKED)', async () => {
    const job = await novoJob(5);
    const [a, b] = await Promise.all([
      store.travarPendentes(job.id, 3),
      store.travarPendentes(job.id, 3),
    ]);
    const ids = [...a, ...b].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(5);
  });

  it('item concluído não volta; item liberado volta, sem perder a tentativa da espera', async () => {
    const job = await novoJob(2);
    const [i1, i2] = await store.travarPendentes(job.id, 2);
    await store.concluirItem(i1.id, { result: 'imported', galleryImageId: null });
    await store.liberarItens([i2.id], true);

    const de_novo = await store.travarPendentes(job.id, 10);
    expect(de_novo.map((i) => i.id)).toEqual([i2.id]);
    expect(de_novo[0].attempts).toBe(1);
    expect((await store.contagens(job.id)).imported).toBe(1);
  });

  it('transição condicional não atropela pausa manual', async () => {
    const job = await novoJob(1);
    expect(await store.mudarStatus(job.id, ['pending'], 'paused')).toBe(true);
    expect(await store.mudarStatus(job.id, ['running', 'pending'], 'waiting_budget')).toBe(false);
    expect((await store.buscarJob(job.id))?.status).toBe('paused');
  });

  it('jobsParaRodar inclui espera vencida, exclui espera futura e pausa manual', async () => {
    const vencido = await novoJob(1);
    const futuro = await novoJob(1);
    const pausado = await novoJob(1);
    await store.mudarStatus(vencido.id, ['pending'], 'waiting_budget', {
      waitReason: 'hour_limit',
      waitUntil: new Date(Date.now() - 1000),
    });
    await store.mudarStatus(futuro.id, ['pending'], 'waiting_budget', {
      waitReason: 'day_limit',
      waitUntil: new Date(Date.now() + 3_600_000),
    });
    await store.mudarStatus(pausado.id, ['pending'], 'paused');

    const ids = (await store.jobsParaRodar()).map((j) => j.id);
    expect(ids).toContain(vencido.id);
    expect(ids).not.toContain(futuro.id);
    expect(ids).not.toContain(pausado.id);
  });

  it('soma custo e devolve o teto', async () => {
    const job = await novoJob(1);
    expect(await store.somarCusto(job.id, 40)).toEqual({ custo: 40, teto: 400 });
    expect(await store.somarCusto(job.id, 8)).toEqual({ custo: 48, teto: 400 });
  });

  it('lista itens por resultado com paginação', async () => {
    const job = await novoJob(3);
    const r = await store.listarItens(job.id, { result: 'pending', limit: 2 });
    expect(r.total).toBe(3);
    expect(r.items).toHaveLength(2);
  });

  it('trava exatamente `limit` itens', async () => {
    const job = await novoJob(5);
    const travados = await store.travarPendentes(job.id, 1);
    expect(travados).toHaveLength(1);
    const [{ n }] = await ds.query(
      `SELECT count(*)::int AS n FROM ean_import_items WHERE "jobId" = $1 AND "lockedAt" IS NOT NULL`,
      [job.id],
    );
    expect(n).toBe(1);
  });
});
