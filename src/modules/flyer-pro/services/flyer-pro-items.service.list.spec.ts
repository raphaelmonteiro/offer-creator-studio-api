import { HttpException } from '@nestjs/common';
import { itemRow } from './flyer-pro-documents.service.testutil';
import { makeItemsManager, makeItemsService } from './flyer-pro-items.service.testutil';

const CURSOR = '2026-11-14T13:05:40.412377Z';

/** O serviço de leitura sobre um `manager` que devolve os itens e o cursor dados, e diz se o encarte existe. */
function makeList(options: { exists?: boolean; items?: unknown[]; cursor?: string } = {}) {
  const { exists = true, items = [], cursor = CURSOR } = options;
  const manager = Object.assign(makeItemsManager(), {
    findOne: jest.fn().mockResolvedValue(exists ? { id: 'd1' } : null),
  });
  manager.query.mockImplementation((sql: string) =>
    Promise.resolve(sql.startsWith('SELECT to_char') ? [{ cursor }] : items),
  );
  const { service, dataSource } = makeItemsService(manager);
  return { service, manager, dataSource };
}

describe('FlyerProItemsService.list: leitura dos itens (N12)', () => {
  it('sem updatedAfter lê todos por position e id, na forma dos itens da abertura, e devolve o cursor do banco', async () => {
    const rows = [
      itemRow({ id: 'a', position: 0, ean: '7891000100103' }),
      itemRow({ id: 'b', position: 1 }),
    ];
    const { service, manager } = makeList({ items: rows });

    const page = await service.list('d1');

    expect(page.cursor).toBe(CURSOR);
    expect(page.items.map((item) => [item.id, item.eanValid])).toEqual([
      ['a', true],
      ['b', null],
    ]);
    expect(page.items[0]).not.toHaveProperty('documentId');
    const [itemsCall] = manager.query.mock.calls;
    expect(itemsCall[0]).toContain('ORDER BY "position" ASC, "id" ASC');
    expect(itemsCall[1]).toEqual(['d1', null]);
  });

  it('com updatedAfter compara "updatedAt" com o instante recebido (microssegundos, sem passar por Date) na mesma ordem', async () => {
    const { service, manager } = makeList();

    await service.list('d1', CURSOR);

    const [itemsCall, cursorCall] = manager.query.mock.calls;
    expect(itemsCall[0]).toContain('"updatedAt" > $2::timestamptz');
    expect(itemsCall[0]).toContain('ORDER BY "position" ASC, "id" ASC');
    expect(itemsCall[1]).toEqual(['d1', CURSOR]);
    expect(cursorCall[1]).toEqual(['d1', CURSOR]);
  });

  it('o valor sem fuso é lido como UTC; o que tem fuso segue como veio', async () => {
    const { service, manager } = makeList();

    await service.list('d1', '2026-11-14T13:05:40.412377');
    await service.list('d1', '2026-11-14T13:05:40-03:00');

    expect(manager.query.mock.calls[0][1]).toEqual(['d1', '2026-11-14T13:05:40.412377Z']);
    expect(manager.query.mock.calls[2][1]).toEqual(['d1', '2026-11-14T13:05:40-03:00']);
  });

  it('o cursor é calculado no banco em texto: o maior updatedAt devolvido, ou o updatedAfter, ou o createdAt do encarte', async () => {
    const { service, manager } = makeList({ cursor: '2026-11-14T13:02:11.000000Z' });

    const page = await service.list('d1');

    const sql: string = manager.query.mock.calls[1][0];
    expect(sql).toContain(`to_char(`);
    expect(sql).toContain(`AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`);
    expect(sql.indexOf('max("updatedAt")')).toBeLessThan(sql.indexOf('$2::timestamptz,'));
    expect(sql.indexOf('$2::timestamptz,')).toBeLessThan(sql.indexOf('"createdAt"'));
    expect(page).toEqual({ items: [], cursor: '2026-11-14T13:02:11.000000Z' });
  });

  it('nada mudou desde o cursor: items vazio e o mesmo cursor', async () => {
    const { service } = makeList({ items: [], cursor: CURSOR });

    await expect(service.list('d1', CURSOR)).resolves.toEqual({ items: [], cursor: CURSOR });
  });

  it('não grava nada e lê numa transação REPEATABLE READ', async () => {
    const { service, manager, dataSource } = makeList({ items: [itemRow()] });

    await service.list('d1');

    expect(dataSource.transaction).toHaveBeenCalledWith('REPEATABLE READ', expect.any(Function));
    const verbs = manager.query.mock.calls.map(([sql]) => sql.split(' ')[0]);
    expect(verbs.every((verb) => verb === 'SELECT')).toBe(true);
  });

  it('encarte inexistente ou excluído é 404 FLYER_PRO_NOT_FOUND e nenhum item é lido', async () => {
    const { service, manager } = makeList({ exists: false });

    const error = (await service.list('d1').catch((caught: unknown) => caught)) as HttpException;

    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toMatchObject({ code: 'FLYER_PRO_NOT_FOUND' });
    expect(manager.query).not.toHaveBeenCalled();
  });
});
