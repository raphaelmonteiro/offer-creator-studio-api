import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { AnimationQueueService, pgBossTransactionDb, QUEUES } from './animation-queue.service';

/**
 * Enfileiramento transacional (regressão do e2e F2, 12/10/2026): o step de
 * TTS criado e enfileirado na transação do `prepare` tinha o job gravado pelo
 * pool PRÓPRIO do pg-boss — o worker consumiu o job antes do COMMIT, não
 * achou o step, descartou o job e o step ficou `queued` 174 s até o
 * reconciliador. Com `manager` em transação ativa, o INSERT do job usa o
 * MESMO query runner (só fica visível no commit; some no rollback).
 */
describe('AnimationQueueService — enfileiramento transacional', () => {
  const runnerWith = (overrides: Record<string, unknown> = {}) => ({
    isReleased: false,
    isTransactionActive: true,
    query: jest.fn().mockResolvedValue({ records: [{ id: 'job-1' }], affected: 1, raw: [] }),
    ...overrides,
  });
  const managerWith = (runner: unknown) => ({ queryRunner: runner }) as unknown as EntityManager;

  describe('pgBossTransactionDb', () => {
    it('sem manager, sem query runner, transação inativa ou runner liberado → null (pool do pg-boss)', () => {
      expect(pgBossTransactionDb(undefined)).toBeNull();
      expect(pgBossTransactionDb(managerWith(undefined))).toBeNull();
      expect(
        pgBossTransactionDb(managerWith(runnerWith({ isTransactionActive: false }))),
      ).toBeNull();
      expect(pgBossTransactionDb(managerWith(runnerWith({ isReleased: true })))).toBeNull();
    });

    it('com transação ativa executa no MESMO query runner (resultado estruturado → {rows,rowCount})', async () => {
      const runner = runnerWith();
      const db = pgBossTransactionDb(managerWith(runner));
      expect(db).not.toBeNull();
      const result = await db!.executeSql('INSERT INTO pgboss.job ... RETURNING id', ['a', 'b']);
      expect(runner.query).toHaveBeenCalledWith(
        'INSERT INTO pgboss.job ... RETURNING id',
        ['a', 'b'],
        true,
      );
      expect(result).toEqual({ rows: [{ id: 'job-1' }], rowCount: 1 });
    });

    it('INSERT sem linha (singleton já existente) → rowCount 0; affected ausente usa o nº de linhas', async () => {
      const none = runnerWith({ query: jest.fn().mockResolvedValue({ records: [], affected: 0 }) });
      expect(await pgBossTransactionDb(managerWith(none))!.executeSql('x', [])).toEqual({
        rows: [],
        rowCount: 0,
      });
      const noAffected = runnerWith({
        query: jest.fn().mockResolvedValue({ records: [{ id: 'j' }] }),
      });
      expect(await pgBossTransactionDb(managerWith(noAffected))!.executeSql('x', [])).toEqual({
        rows: [{ id: 'j' }],
        rowCount: 1,
      });
    });
  });

  describe('publish', () => {
    let service: AnimationQueueService;
    let send: jest.Mock;

    beforeEach(() => {
      service = new AnimationQueueService({ get: jest.fn() } as unknown as ConfigService);
      send = jest.fn().mockResolvedValue('job-1');
      (service as unknown as { boss: unknown }).boss = { send };
    });

    it('com o manager da transação: o send leva `db` sobre o query runner dela', async () => {
      const runner = runnerWith();
      await service.publish(
        QUEUES.MC_TTS,
        { stepId: 'st-1' },
        { expireInSeconds: 300, manager: managerWith(runner) },
      );
      expect(send).toHaveBeenCalledTimes(1);
      const options = send.mock.calls[0][2];
      expect(options).toEqual(
        expect.objectContaining({ expireInSeconds: 300, retryLimit: 3, db: expect.any(Object) }),
      );
      expect(options).not.toHaveProperty('manager');
      await options.db.executeSql('SQL', [1]);
      expect(runner.query).toHaveBeenCalledWith('SQL', [1], true);
    });

    it('sem manager (ou fora de transação): sem `db` — pool próprio do pg-boss, como antes', async () => {
      await service.publish(QUEUES.MC_TTS, { stepId: 'st-1' }, { expireInSeconds: 300 });
      await service.publish(
        QUEUES.MC_TTS,
        { stepId: 'st-2' },
        {
          manager: managerWith(runnerWith({ isTransactionActive: false })),
        },
      );
      expect(send.mock.calls[0][2]).not.toHaveProperty('db');
      expect(send.mock.calls[1][2]).not.toHaveProperty('db');
    });
  });
});
