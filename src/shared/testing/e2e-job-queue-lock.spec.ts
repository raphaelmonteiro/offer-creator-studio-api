import type { DataSource } from 'typeorm';
import { holdJobQueueLock } from './e2e-job-queue-lock';

const FAST = { timeoutMs: 60, pollMs: 5 };

/** Um `DataSource` cuja trava responde `locked` na ordem dada (a última resposta se repete). */
function fakeDataSource(answers: boolean[], unlockFails = false) {
  let polls = 0;
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) {
      return [{ locked: answers[Math.min(polls++, answers.length - 1)] }];
    }
    if (unlockFails) throw new Error('conexão perdida');
    return [{ pg_advisory_unlock: true }];
  });
  const runner = {
    connect: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query,
  };
  const dataSource = { createQueryRunner: () => runner } as unknown as DataSource;
  return { dataSource, runner, query };
}

const sqlOf = (query: jest.Mock) => query.mock.calls.map(([sql]) => sql as string);

describe('holdJobQueueLock (PV-9)', () => {
  it('trava livre: toma na primeira tentativa e só devolve a conexão quando a função devolvida roda', async () => {
    const { dataSource, runner, query } = fakeDataSource([true]);

    const release = await holdJobQueueLock(dataSource, FAST);

    expect(sqlOf(query)).toEqual([expect.stringContaining('pg_try_advisory_lock')]);
    expect(runner.release).not.toHaveBeenCalled();
    await release();
    expect(sqlOf(query)[1]).toContain('pg_advisory_unlock');
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('trava ocupada: tenta de novo até o outro spec soltar e então a segura', async () => {
    const { dataSource, query } = fakeDataSource([false, false, true]);

    await holdJobQueueLock(dataSource, FAST);

    expect(query).toHaveBeenCalledTimes(3);
  });

  it('prazo estourado: lança e devolve a conexão ao pool, sem consulta pendente nem destravar o que não tomou', async () => {
    const { dataSource, runner, query } = fakeDataSource([false]);

    await expect(holdJobQueueLock(dataSource, FAST)).rejects.toThrow(/Trava da fila de e2e/);

    expect(runner.release).toHaveBeenCalledTimes(1);
    expect(sqlOf(query).every((sql) => sql.includes('pg_try_advisory_lock'))).toBe(true);
  });

  it('conexão que falha ao abrir: devolve a conexão e lança o erro', async () => {
    const { dataSource, runner } = fakeDataSource([true]);
    runner.connect.mockRejectedValue(new Error('sem conexão'));

    await expect(holdJobQueueLock(dataSource, FAST)).rejects.toThrow('sem conexão');

    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('soltar com a conexão já perdida: não lança e a conexão volta ao pool', async () => {
    const { dataSource, runner } = fakeDataSource([true], true);
    const release = await holdJobQueueLock(dataSource, FAST);

    await expect(release()).resolves.toBeUndefined();

    expect(runner.release).toHaveBeenCalledTimes(1);
  });
});
