import type { DataSource } from 'typeorm';
import { listDocuments, listWhere } from './flyer-pro-documents-list';

const row = (id: string, total: number) => ({
  id,
  name: `Encarte ${id}`,
  clientId: 'c1',
  clientName: 'Piccin Supermercado',
  format: '27x40',
  pageCount: 1,
  step: 'products',
  itemCount: 3,
  revision: 0,
  updatedByUserId: 'u1',
  updatedByName: 'Ana',
  createdAt: new Date('2026-11-14T13:02:11.000Z'),
  updatedAt: new Date('2026-11-14T14:00:00.000Z'),
  total,
});

const dataSourceOf = (...results: unknown[][]) => {
  const query = jest.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  return { dataSource: { query } as unknown as DataSource, query };
};

describe('listWhere', () => {
  it('sem filtros só exclui os encartes excluídos', () => {
    expect(listWhere({})).toEqual({ where: `d."deletedAt" IS NULL`, params: [] });
  });

  it('cliente e termo juntos valem ao mesmo tempo, com os parâmetros na ordem', () => {
    const { where, params } = listWhere({ clientId: 'c1', search: 'piccin' });
    expect(where).toBe(
      `d."deletedAt" IS NULL AND d."clientId" = $1::uuid AND unaccent(d.name) ILIKE '%' || unaccent($2::text) || '%'`,
    );
    expect(params).toEqual(['c1', 'piccin']);
  });

  it.each([
    ['50%', '50\\%'],
    ['A_B', 'A\\_B'],
    ['a\\b', 'a\\\\b'],
    ['  sábado ', '  sábado '],
  ])('escapa %% _ e \\ do termo e o mantém como veio: %p vira %p', (search, escaped) => {
    expect(listWhere({ search }).params).toEqual([escaped]);
  });

  it('busca vazia vale como sem filtro; só o nome do encarte é procurado', () => {
    const { where, params } = listWhere({ search: '' });
    expect(params).toEqual([]);
    expect(where).not.toContain('unaccent');
    expect(listWhere({ search: 'x' }).where).not.toContain('c.name');
  });
});

describe('listDocuments', () => {
  it('uma consulta por página, em updatedAt e id decrescentes, com o total do count(*) OVER ()', async () => {
    const { dataSource, query } = dataSourceOf([row('a', 25), row('b', 25)]);

    const page = await listDocuments(dataSource, { page: 2, limit: 20, clientId: 'c1' });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('JOIN clients c');
    expect(sql).toContain('LEFT JOIN users u');
    expect(sql).toContain('FROM flyer_pro_items');
    expect(sql).toContain('count(*) OVER ()');
    expect(sql).toContain('ORDER BY d."updatedAt" DESC, d.id DESC');
    expect(params).toEqual(['c1', 20, 20]);
    expect(page.pagination).toEqual({ page: 2, limit: 20, total: 25, totalPages: 2 });
    expect(page.data.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('sem filtros usa página 1 e limite 20; as entradas saem pela view da lista', async () => {
    const { dataSource, query } = dataSourceOf([row('a', 1)]);

    const page = await listDocuments(dataSource, {});

    expect(query.mock.calls[0][1]).toEqual([20, 0]);
    expect(page.data[0]).toMatchObject({
      clientName: 'Piccin Supermercado',
      itemCount: 3,
      updatedByName: 'Ana',
      updatedAt: '2026-11-14T14:00:00.000Z',
    });
    expect(page.data[0]).not.toHaveProperty('total');
  });

  it('página além do fim: dados vazios e o total real, de uma contagem à parte com os mesmos filtros', async () => {
    const { dataSource, query } = dataSourceOf([], [{ total: 3 }]);

    const page = await listDocuments(dataSource, { page: 5, clientId: 'c1' });

    expect(query).toHaveBeenCalledTimes(2);
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('count(*)');
    expect(sql).toContain('d."clientId" = $1::uuid');
    expect(params).toEqual(['c1']);
    expect(page).toEqual({
      data: [],
      pagination: { page: 5, limit: 20, total: 3, totalPages: 1 },
    });
  });
});
