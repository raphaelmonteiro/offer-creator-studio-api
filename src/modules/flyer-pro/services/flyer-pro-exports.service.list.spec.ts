import { DOCUMENT, exportRow } from '../testing/flyer-pro-exports.fixture';
import {
  commandsOf,
  ExportsManagerOptions,
  makeExportsManager,
  makeExportsService,
} from './flyer-pro-exports.service.testutil';

/** O serviço sobre o `manager` da leitura: o encarte (ou nenhum), o total e a página. */
function setup(options: ExportsManagerOptions = { total: 1, rows: [exportRow()] }) {
  const manager = makeExportsManager(options);
  const { service, dataSource } = makeExportsService(manager);
  return { service, dataSource, manager, statements: () => commandsOf(manager) };
}

describe('FlyerProExportsService.list: o histórico (N9)', () => {
  it('encarte que não existe ou foi excluído é 404 FLYER_PRO_NOT_FOUND, sem ler exportação', async () => {
    const { service, manager } = setup({ revision: null });

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

  it('padrões: página 1 e 20 por página, só as do encarte, da mais recente para a mais antiga, com desempate por id decrescente', async () => {
    const { service, statements } = setup();

    const result = await service.list(DOCUMENT, {});

    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    const [count, page] = statements();
    expect(count.params).toEqual([DOCUMENT]);
    expect(count.sql).toContain('"documentId" = $1');
    expect(page.sql).toContain('e."documentId" = $1');
    expect(page.sql).toContain('ORDER BY e."createdAt" DESC, e."id" DESC');
    expect(page.sql).toContain('LEFT JOIN "users" u ON u."id" = e."createdByUserId"');
    expect(page.params).toEqual([DOCUMENT, 20, 0]);
  });

  it('segunda página de 25 exportações: salta 20 e traz o total e as páginas reais', async () => {
    const { service, statements } = setup({ total: 25, rows: [exportRow()] });

    const result = await service.list(DOCUMENT, { page: 2, limit: 20 });

    expect(result.pagination).toEqual({ page: 2, limit: 20, total: 25, totalPages: 2 });
    expect(statements()[1].params).toEqual([DOCUMENT, 20, 20]);
  });

  it('o limite pedido vale: página 3 de 10 por página salta 20', async () => {
    const { service, statements } = setup({ total: 25, rows: [exportRow()] });

    await service.list(DOCUMENT, { page: 3, limit: 10 });

    expect(statements()[1].params).toEqual([DOCUMENT, 10, 20]);
  });

  it('encarte sem exportação: data vazio e total 0, sem ler a página', async () => {
    const { service, statements } = setup({ total: 0 });

    const result = await service.list(DOCUMENT, {});

    expect(result.data).toEqual([]);
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
    expect(statements()).toHaveLength(1);
  });

  it('página além do fim: data vazio com o total real', async () => {
    const { service } = setup({ total: 3, rows: [] });

    const result = await service.list(DOCUMENT, { page: 5 });

    expect(result.data).toEqual([]);
    expect(result.pagination).toEqual({ page: 5, limit: 20, total: 3, totalPages: 1 });
  });

  it('cada entrada tem a forma do registro sem replayed nem filePath, e o autor removido vem com createdByName nulo', async () => {
    const { service } = setup({
      total: 2,
      rows: [
        exportRow({ id: 'e2', createdByUserId: 'removido', createdByName: null }),
        exportRow({ id: 'e1', filePath: 'exports/interno.pdf' }),
      ],
    });

    const { data } = await service.list(DOCUMENT, {});

    expect(data.map((entry) => entry.createdByName)).toEqual([null, 'Ana']);
    expect(data[1]).toMatchObject({ fileSize: 31457280, fileState: 'not_stored', hasFile: false });
    for (const entry of data) {
      expect(entry).not.toHaveProperty('replayed');
      expect(entry).not.toHaveProperty('filePath');
    }
  });

  it('só lê: transação REPEATABLE READ e nenhum comando que não seja SELECT', async () => {
    const { service, dataSource, statements } = setup();

    await service.list(DOCUMENT, {});

    expect(dataSource.transaction).toHaveBeenCalledWith('REPEATABLE READ', expect.any(Function));
    for (const { sql } of statements()) expect(sql).toMatch(/^SELECT/);
  });
});
