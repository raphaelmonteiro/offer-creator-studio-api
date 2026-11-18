import type { FlyerProImportRow } from '../views/flyer-pro-import.view';
import { makeImportsService } from './flyer-pro-imports.service.testutil';

const DOCUMENT = '2c1d7e9b-4f6a-4b1e-9a3d-7e5f0c8b6a21';
const HASH = '9f2c1a7b3d4e5f60';

const importRow = (over: Partial<FlyerProImportRow> = {}): FlyerProImportRow => ({
  id: '9a0c4e12-77b3-4c5d-8e21-0f3a6b9d2c44',
  documentId: DOCUMENT,
  fileName: 'lista-piccin.csv',
  fileKind: 'csv',
  fileHash: HASH,
  detectedFormat: 'csv',
  mode: 'append',
  rowCount: 5,
  acceptedCount: 4,
  rejected: [{ row: 7, reason: 'PRICE_MISSING', raw: 'FEIJAO CARIOCA' }],
  createdByUserId: 'u1',
  createdByName: 'Ana',
  createdAt: new Date('2026-11-14T13:04:02.000Z'),
  ...over,
});

/** O `manager` da leitura: o encarte (ou nenhum), o total e a página. */
function makeReader({ document = { id: DOCUMENT }, total = 1, rows = [importRow()] } = {}) {
  const manager = {
    findOne: jest.fn().mockResolvedValue(document),
    query: jest.fn(
      (sql: string, _params?: unknown[]): Promise<unknown> =>
        Promise.resolve(sql.startsWith('SELECT count') ? [{ total }] : rows),
    ),
  };
  const { service, dataSource } = makeImportsService(manager);
  const statements = () => manager.query.mock.calls.map(([sql, params]) => ({ sql, params }));
  return { service, dataSource, manager, statements };
}

describe('FlyerProImportsService.list: o histórico (N13)', () => {
  it('encarte que não existe ou foi excluído é 404 FLYER_PRO_NOT_FOUND, sem ler importação', async () => {
    const { service, manager } = makeReader({ document: null });

    await expect(service.list(DOCUMENT, {})).rejects.toMatchObject({
      status: 404,
      response: { code: 'FLYER_PRO_NOT_FOUND' },
    });
    expect(manager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: DOCUMENT },
      select: { id: true },
    });
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('padrões: página 1 e 20 por página, só as do encarte, da mais recente para a mais antiga, com desempate por id', async () => {
    const { service, statements } = makeReader();

    const result = await service.list(DOCUMENT, {});

    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    const [count, page] = statements();
    expect(count.params).toEqual([DOCUMENT]);
    expect(page.sql).toContain('i."documentId" = $1');
    expect(page.sql).toContain('ORDER BY i."createdAt" DESC, i."id" DESC');
    expect(page.sql).toContain('LEFT JOIN "users" u ON u."id" = i."createdByUserId"');
    expect(page.params).toEqual([DOCUMENT, 20, 0]);
  });

  it('com fileHash, o filtro é exato e vale para o total e para a página', async () => {
    const { service, statements } = makeReader();

    await service.list(DOCUMENT, { fileHash: HASH });

    const [count, page] = statements();
    expect(count.sql).toContain('i."fileHash" = $2');
    expect(count.params).toEqual([DOCUMENT, HASH]);
    expect(page.sql).toContain('i."fileHash" = $2');
    expect(page.sql).toContain('LIMIT $3 OFFSET $4');
    expect(page.params).toEqual([DOCUMENT, HASH, 20, 0]);
  });

  it('segunda página de 23 importações: salta 20 e traz o total e as páginas reais', async () => {
    const { service, statements } = makeReader({
      total: 23,
      rows: [importRow(), importRow(), importRow()],
    });

    const result = await service.list(DOCUMENT, { page: 2 });

    expect(result.data).toHaveLength(3);
    expect(result.pagination).toEqual({ page: 2, limit: 20, total: 23, totalPages: 2 });
    expect(statements()[1].params).toEqual([DOCUMENT, 20, 20]);
  });

  it('sem nenhuma importação: lista vazia, total 0, e a página nem é lida', async () => {
    const { service, statements } = makeReader({ total: 0, rows: [] });

    const result = await service.list(DOCUMENT, { fileHash: 'nunca-importado' });

    expect(result).toEqual({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
    expect(statements()).toHaveLength(1);
  });

  it('página além do fim: lista vazia com o total real', async () => {
    const { service } = makeReader({ total: 3, rows: [] });

    const result = await service.list(DOCUMENT, { page: 5 });

    expect(result.data).toEqual([]);
    expect(result.pagination).toEqual({ page: 5, limit: 20, total: 3, totalPages: 1 });
  });

  it('cada importação traz os campos gravados, rejectedCount e createdByName (nulo se o autor não existe mais)', async () => {
    const orphan = importRow({ createdByName: null, rowCount: 300, acceptedCount: 50 });
    const { service } = makeReader({ total: 2, rows: [importRow(), orphan] });

    const { data } = await service.list(DOCUMENT, {});

    expect(data[0]).toEqual({
      id: '9a0c4e12-77b3-4c5d-8e21-0f3a6b9d2c44',
      documentId: DOCUMENT,
      fileName: 'lista-piccin.csv',
      fileKind: 'csv',
      fileHash: HASH,
      detectedFormat: 'csv',
      mode: 'append',
      rowCount: 5,
      acceptedCount: 4,
      rejectedCount: 1,
      rejected: [{ row: 7, reason: 'PRICE_MISSING', raw: 'FEIJAO CARIOCA' }],
      createdByUserId: 'u1',
      createdByName: 'Ana',
      createdAt: '2026-11-14T13:04:02.000Z',
    });
    expect(data[1]).toMatchObject({ createdByName: null, rejectedCount: 250 });
  });

  it('é leitura: numa transação REPEATABLE READ e sem nenhum comando de escrita', async () => {
    const { service, dataSource, statements } = makeReader();

    await service.list(DOCUMENT, { fileHash: HASH });

    expect(dataSource.transaction).toHaveBeenCalledWith('REPEATABLE READ', expect.any(Function));
    expect(statements().every(({ sql }) => sql.startsWith('SELECT'))).toBe(true);
  });
});
