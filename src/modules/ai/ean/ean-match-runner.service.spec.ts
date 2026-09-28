import { EanMatchItem } from './entities/ean-match-item.entity';
import { EanMatchJob } from './entities/ean-match-job.entity';
import { EanItemProcessor, EanMatchRunnerService, MAX_ATTEMPTS } from './ean-match-runner.service';

/** Store em memória que imita o contrato do EanMatchStore. */
class FakeStore {
  jobs = new Map<string, EanMatchJob>();
  itens = new Map<string, EanMatchItem>();

  addJob(id: string, custoTeto = 0): EanMatchJob {
    const job = {
      id,
      status: 'running',
      costUsd: '0',
      costCapUsd: String(custoTeto),
    } as EanMatchJob;
    this.jobs.set(id, job);
    return job;
  }

  addItem(jobId: string, n: number): EanMatchItem {
    const item = {
      id: `${jobId}-${n}`,
      jobId,
      rowNumber: n,
      status: 'pending',
      attempts: 0,
      lockedAt: null,
    } as unknown as EanMatchItem;
    this.itens.set(item.id, item);
    return item;
  }

  async jobsEmExecucao() {
    return [...this.jobs.values()].filter((j) => j.status === 'running');
  }
  async travarPendentes(jobId: string, limit: number) {
    const livres = [...this.itens.values()]
      .filter((i) => i.jobId === jobId && i.status === 'pending' && !i.lockedAt)
      .slice(0, limit);
    for (const i of livres) {
      i.lockedAt = new Date();
      i.attempts += 1;
    }
    return livres.map((i) => ({ ...i }));
  }
  async salvarItem(id: string, patch: Partial<EanMatchItem>) {
    Object.assign(this.itens.get(id)!, patch, { lockedAt: null });
  }
  async liberarItem(id: string) {
    this.itens.get(id)!.lockedAt = null;
  }
  async somarCusto(jobId: string, custo: number) {
    const job = this.jobs.get(jobId)!;
    job.costUsd = String(Number(job.costUsd) + custo);
    return { custo: Number(job.costUsd), teto: Number(job.costCapUsd) };
  }
  async mudarStatusSeExecutando(
    jobId: string,
    status: EanMatchJob['status'],
    error?: string | null,
  ) {
    const job = this.jobs.get(jobId)!;
    if (job.status !== 'running') return;
    job.status = status;
    job.error = error ?? null;
  }
  async contarAbertos(jobId: string) {
    return [...this.itens.values()].filter((i) => i.jobId === jobId && i.status === 'pending')
      .length;
  }
}

function criarRunner(store: FakeStore, processor: EanItemProcessor, concurrency = 2) {
  const config = {
    get: (k: string, def: string) => (k === 'EAN_JOB_CONCURRENCY' ? String(concurrency) : def),
  };
  return new EanMatchRunnerService(store as never, processor, config as never);
}

async function rodarAteParar(runner: EanMatchRunnerService, max = 50) {
  for (let i = 0; i < max; i++) if (!(await runner.tick())) return;
}

describe('EanMatchRunnerService', () => {
  it('processa todos os itens, finaliza e marca o job como done', async () => {
    const store = new FakeStore();
    const job = store.addJob('j1');
    for (let n = 1; n <= 5; n++) store.addItem('j1', n);
    const processor: EanItemProcessor = {
      processar: jest.fn(async () => ({ patch: { status: 'no-image' as const }, costUsd: 0 })),
      finalizarJob: jest.fn(async () => undefined),
    };
    const runner = criarRunner(store, processor);

    await rodarAteParar(runner);
    await runner.tick(); // passo vazio que detecta o fim

    expect(processor.processar).toHaveBeenCalledTimes(5);
    expect(processor.finalizarJob).toHaveBeenCalledWith(expect.objectContaining({ id: 'j1' }));
    expect(job.status).toBe('done');
  });

  it('reiniciar o runner não reprocessa itens já decididos', async () => {
    const store = new FakeStore();
    store.addJob('j1');
    for (let n = 1; n <= 4; n++) store.addItem('j1', n);
    const vistos: string[] = [];
    const processor: EanItemProcessor = {
      processar: jest.fn(async (item) => {
        vistos.push(item.id);
        return { patch: { status: 'no-image' as const }, costUsd: 0.01 };
      }),
      finalizarJob: jest.fn(async () => undefined),
    };

    // Primeiro processo: um passo só (2 itens), depois "morre".
    await criarRunner(store, processor).tick();
    // Novo processo retoma do banco.
    await rodarAteParar(criarRunner(store, processor));

    expect(vistos.sort()).toEqual(['j1-1', 'j1-2', 'j1-3', 'j1-4']);
  });

  it('pausa o job ao atingir o teto de custo, sem perder o progresso', async () => {
    const store = new FakeStore();
    const job = store.addJob('j1', 0.05);
    for (let n = 1; n <= 10; n++) store.addItem('j1', n);
    const processor: EanItemProcessor = {
      processar: jest.fn(async () => ({ patch: { status: 'review' as const }, costUsd: 0.02 })),
      finalizarJob: jest.fn(async () => undefined),
    };

    await rodarAteParar(criarRunner(store, processor, 1));

    expect(job.status).toBe('paused');
    expect(job.error).toMatch(/teto/);
    const decididos = [...store.itens.values()].filter((i) => i.status !== 'pending').length;
    expect(decididos).toBe(3); // 0.02 + 0.02 + 0.02 ≥ 0.05
    expect(processor.finalizarJob).not.toHaveBeenCalled();
  });

  it('falha transitória libera o item para nova tentativa', async () => {
    const store = new FakeStore();
    store.addJob('j1');
    const item = store.addItem('j1', 1);
    let chamadas = 0;
    const processor: EanItemProcessor = {
      processar: jest.fn(async () => {
        chamadas += 1;
        if (chamadas === 1) throw new Error('timeout da OpenAI');
        return { patch: { status: 'no-image' as const }, costUsd: 0 };
      }),
      finalizarJob: jest.fn(async () => undefined),
    };

    await rodarAteParar(criarRunner(store, processor));

    expect(item.status).toBe('no-image');
    expect(chamadas).toBe(2);
  });

  it(`depois de ${MAX_ATTEMPTS} falhas o item vai para revisão`, async () => {
    const store = new FakeStore();
    store.addJob('j1');
    const item = store.addItem('j1', 1);
    const processor: EanItemProcessor = {
      processar: jest.fn(async () => {
        throw new Error('sempre falha');
      }),
      finalizarJob: jest.fn(async () => undefined),
    };

    await rodarAteParar(criarRunner(store, processor));

    expect(item.status).toBe('review');
    expect(item.reviewReason).toBe('processing-error');
    expect(processor.processar).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });
});
