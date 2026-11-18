import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { FlyerProClientGuardService } from './flyer-pro-client-guard.service';

/** Expurgo e contagem dos encartes Pro de um cliente (U9.5-1), com o `manager` e o `DataSource` simulados. */
describe('FlyerProClientGuardService', () => {
  const managerReturning = (ids: string[]) => {
    const query = jest.fn().mockResolvedValue([ids.map((id) => ({ id })), ids.length]);
    return { query, manager: { query } as unknown as EntityManager };
  };
  const build = (dataSourceQuery = jest.fn()) =>
    new FlyerProClientGuardService({ query: dataSourceQuery } as unknown as DataSource);

  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => log.mockRestore());

  describe('purgeDeletedOfClient', () => {
    it('apaga pelo manager recebido só os encartes do cliente com deletedAt preenchido e devolve os ids', async () => {
      const { query, manager } = managerReturning(['d1', 'd2']);
      const dataSourceQuery = jest.fn();

      const ids = await build(dataSourceQuery).purgeDeletedOfClient(manager, 'c1');

      expect(ids).toEqual(['d1', 'd2']);
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/^DELETE FROM "flyer_pro_documents"/);
      expect(sql).toContain('"clientId" = $1');
      expect(sql).toContain('"deletedAt" IS NOT NULL');
      expect(sql).toContain('RETURNING "id"');
      expect(params).toEqual(['c1']);
      expect(dataSourceQuery).not.toHaveBeenCalled();
    });

    it('registra uma linha de log com o clientId e os ids quando apaga ao menos um encarte', async () => {
      const { manager } = managerReturning(['d1', 'd2']);

      await build().purgeDeletedOfClient(manager, 'c1');

      expect(log).toHaveBeenCalledTimes(1);
      const line = log.mock.calls[0][0] as string;
      expect(line).toContain('c1');
      expect(line).toContain('d1');
      expect(line).toContain('d2');
    });

    it('sem encarte excluído: devolve lista vazia e não registra log', async () => {
      const { manager } = managerReturning([]);

      expect(await build().purgeDeletedOfClient(manager, 'c1')).toEqual([]);
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('countLiveOfClient', () => {
    it('conta pelo DataSource só os encartes do cliente com deletedAt nulo', async () => {
      const dataSourceQuery = jest.fn().mockResolvedValue([{ total: 2 }]);

      expect(await build(dataSourceQuery).countLiveOfClient('c1')).toBe(2);

      const [sql, params] = dataSourceQuery.mock.calls[0];
      expect(sql).toContain('"flyer_pro_documents"');
      expect(sql).toContain('"clientId" = $1');
      expect(sql).toContain('"deletedAt" IS NULL');
      expect(params).toEqual(['c1']);
    });

    it('cliente sem encarte vivo: 0', async () => {
      const dataSourceQuery = jest.fn().mockResolvedValue([{ total: 0 }]);

      expect(await build(dataSourceQuery).countLiveOfClient('c1')).toBe(0);
    });
  });
});
