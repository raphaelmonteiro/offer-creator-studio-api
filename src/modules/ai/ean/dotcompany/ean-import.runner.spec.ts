// O binário do sharp não carrega no host (macOS); o runner não o usa aqui.
jest.mock('sharp', () => jest.fn());

import { DataSource } from 'typeorm';
import { criarDataSourceDeTeste, EAN_IT_ENABLED } from '../ean-test-db';
import { classifyEan, LookupOutcome, LookupSummary } from './dotcompany-lookup.service';
import { EanImportStore } from './ean-import.store';
import { EanImportRunner } from './ean-import.runner';
import { EanImportJob } from './entities/ean-import-job.entity';

/**
 * Runner contra Postgres real (store de verdade), com DotCompany, fotos e
 * controlador falsos:
 *
 *   EAN_IT_DB_PORT=5433 EAN_IT_DB_NAME=ean_mig_test npx jest ean-import.runner
 */
const d = EAN_IT_ENABLED ? describe : describe.skip;

const E1 = '7891000100103';
const E2 = '7622300873554';
const E3 = '7894900011517';

/** DotCompany falsa: sabe quais EANs existem e pode recusar por orçamento. */
class FakeDotcompany {
  existentes = new Set([E1, E2, E3]);
  bloqueio: { reason: 'no_credit' | 'day_limit' | 'reserve'; retryAt: Date | null } | null = null;
  consultas = 0;

  async findCached() {
    return new Map();
  }

  async resolve(inputs: string[]): Promise<LookupSummary> {
    const outcomes = new Map<string, LookupOutcome>();
    if (this.bloqueio) {
      for (const i of inputs) {
        outcomes.set(i, {
          ean: i,
          input: i,
          status: 'blocked',
          blockReason: this.bloqueio.reason,
          retryAt: this.bloqueio.retryAt,
        });
      }
      return {
        outcomes,
        credits: 0,
        requests: 0,
        blocked: { ...this.bloqueio, message: 'x' },
        authError: null,
      };
    }
    this.consultas += 1;
    let credits = 0;
    for (const i of inputs) {
      const ean = classifyEan(i).ean;
      if (this.existentes.has(ean)) {
        credits += 4;
        outcomes.set(i, { ean, input: i, status: 'found', lookup: { ean } as never });
      } else outcomes.set(i, { ean, input: i, status: 'not_found' });
    }
    return { outcomes, credits, requests: 1, blocked: null, authError: null };
  }
}

/** Galeria falsa: uma foto por EAN, como o índice único garante na real. */
class FakeFotos {
  galeria = new Map<string, string>();
  async importMany(items: Array<{ ean: string }>) {
    const r = new Map();
    for (const { ean } of items) {
      const existe = this.galeria.get(ean);
      if (existe) r.set(ean, { ean, status: 'already_exists', galleryImageId: existe });
      else {
        const id = `00000000-0000-4000-8000-${String(this.galeria.size + 1).padStart(12, '0')}`;
        this.galeria.set(ean, id);
        r.set(ean, { ean, status: 'imported', galleryImageId: id });
      }
    }
    return r;
  }
}

d('EanImportRunner (Postgres real)', () => {
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

  function runner(dc: FakeDotcompany, fotos: FakeFotos) {
    const budget = { now: () => new Date(), limits: { balanceRefreshMs: 15 * 60_000 } };
    const config = { get: (_k: string, def: string) => def };
    return new EanImportRunner(
      store,
      dc as never,
      fotos as never,
      budget as never,
      config as never,
    );
  }

  async function job(eans: string[], extra: { costCapCredits?: number } = {}) {
    const j = await store.criarJob({
      kind: 'file',
      costCapCredits: extra.costCapCredits ?? 0,
      rows: eans.map((ean, i) => ({ rowNumber: i + 1, ean, description: `P${i}` })),
    });
    jobs.push(j.id);
    return j;
  }

  async function rodar(r: EanImportRunner, max = 10) {
    for (let i = 0; i < max; i++) if (!(await r.tick())) break;
    await r.tick(); // passo vazio que fecha o job
  }

  it('processa o cadastro e fecha o relatório por linha', async () => {
    const dc = new FakeDotcompany();
    const j = await job([E1, E2, '7891000100104', '2000123000008', '7891000999998']);
    await rodar(runner(dc, new FakeFotos()));
    const c = await store.contagens(j.id);
    expect(c).toMatchObject({ imported: 2, invalid: 1, internal_use: 1, not_found: 1, pending: 0 });
    const fim = await store.buscarJob(j.id);
    expect(fim?.status).toBe('done');
    expect(fim?.costCredits).toBe(8);
  });

  it('dois jobs com o mesmo EAN geram uma foto só', async () => {
    const dc = new FakeDotcompany();
    const fotos = new FakeFotos();
    const a = await job([E1]);
    const b = await job([E1]);
    await rodar(runner(dc, fotos));
    expect(fotos.galeria.size).toBe(1);
    expect((await store.contagens(a.id)).imported + (await store.contagens(b.id)).imported).toBe(1);
    expect(
      (await store.contagens(a.id)).already_exists + (await store.contagens(b.id)).already_exists,
    ).toBe(1);
  });

  it('sem saldo: espera sozinho e retoma depois da recarga', async () => {
    const dc = new FakeDotcompany();
    dc.bloqueio = { reason: 'no_credit', retryAt: new Date(Date.now() + 60_000) };
    const r = runner(dc, new FakeFotos());
    const j = await job([E1, E2]);
    await r.tick();
    let s = await store.buscarJob(j.id);
    expect(s).toMatchObject({ status: 'waiting_budget', waitReason: 'no_credit' });
    expect(await store.contarAbertos(j.id)).toBe(2);

    // Ainda dentro da espera: não toca no job.
    await r.tick();
    expect(dc.consultas).toBe(0);

    // Recarga: o controlador libera e o próximo refresh (waitUntil) chega.
    dc.bloqueio = null;
    await ds.query(
      `UPDATE ean_import_jobs SET "waitUntil" = now() - interval '1 second' WHERE id = $1`,
      [j.id],
    );
    await rodar(r);
    s = await store.buscarJob(j.id);
    expect(s?.status).toBe('done');
    expect((await store.contagens(j.id)).imported).toBe(2);
  });

  it('limite diário: espera até o dia seguinte e volta sozinho', async () => {
    const dc = new FakeDotcompany();
    const amanha = new Date(Date.now() + 12 * 3_600_000);
    dc.bloqueio = { reason: 'day_limit', retryAt: amanha };
    const r = runner(dc, new FakeFotos());
    const j = await job([E3]);
    await r.tick();
    const s = await store.buscarJob(j.id);
    expect(s?.waitReason).toBe('day_limit');
    expect(s?.waitUntil?.getTime()).toBe(amanha.getTime());

    dc.bloqueio = null;
    await ds.query(
      `UPDATE ean_import_jobs SET "waitUntil" = now() - interval '1 second' WHERE id = $1`,
      [j.id],
    );
    await rodar(r);
    expect((await store.buscarJob(j.id))?.status).toBe('done');
  });

  it('pausa manual não volta sozinha', async () => {
    const dc = new FakeDotcompany();
    const r = runner(dc, new FakeFotos());
    const j = await job([E1]);
    await store.mudarStatus(j.id, ['pending'], 'paused');
    await rodar(r);
    expect((await store.buscarJob(j.id))?.status).toBe('paused');
    expect(dc.consultas).toBe(0);
  });

  it('reinício: um runner novo continua das pendentes sem refazer as concluídas', async () => {
    const dc = new FakeDotcompany();
    const fotos = new FakeFotos();
    const j = await job([E1, E2]);
    // Simula o processo morrendo com E1 já concluída.
    const [i1] = await store.travarPendentes(j.id, 1);
    await store.concluirItem(i1.id, { result: 'imported', galleryImageId: null });
    await rodar(runner(dc, fotos));
    expect(fotos.galeria.has(E1)).toBe(false);
    expect(fotos.galeria.has(E2)).toBe(true);
    expect((await store.buscarJob(j.id))?.status).toBe('done');
  });

  it('teto do job: para antes de um lote que passaria do teto', async () => {
    const dc = new FakeDotcompany();
    const j = await job([E1, E2, E3], { costCapCredits: 8 });
    await rodar(runner(dc, new FakeFotos()));
    const s = await store.buscarJob(j.id);
    expect(s?.status).toBe('paused_cap');
    expect(dc.consultas).toBe(0);
    expect(await store.contarAbertos(j.id)).toBe(3);
  });
});
