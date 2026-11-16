import type { EntityManager } from 'typeorm';
import { escapeLike, FlyerProSceneReader } from './flyer-pro-scene.reader';

const SCENE_ID = '9eb30a72-aa45-41c1-9832-2733d6a39277';

const rawScene = {
  id: SCENE_ID,
  name: 'Cena',
  formatId: 'folheto-27x40',
  layout: 'single',
  artHeightCm: '41.00',
  revision: 3,
  updatedAt: new Date('2026-11-13T02:32:08.690Z'),
  approvedTemplateId: null,
  deletedAt: null,
};

function fakeManager(...results: unknown[][]) {
  const query = jest.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  return { manager: { query } as unknown as EntityManager, query };
}

describe('escapeLike', () => {
  it.each([
    ['50%', '50\\%'],
    ['_', '\\_'],
    ['a\\b', 'a\\\\b'],
    ['5-', '5-'],
    ['%_\\', '\\%\\_\\\\'],
  ])('%p vira %p', (term, escaped) => {
    expect(escapeLike(term)).toBe(escaped);
  });
});

describe('FlyerProSceneReader', () => {
  const reader = new FlyerProSceneReader();
  const base = { formatIds: ['folheto-27x40', 'folheto-54x40'], page: 1, limit: 20 };

  describe('listPage', () => {
    it('uma consulta por página: devolve as cenas com o total da janela e a altura da arte como número', async () => {
      const { manager, query } = fakeManager([{ ...rawScene, total: '7' }]);
      const result = await reader.listPage(manager, base);
      expect(query).toHaveBeenCalledTimes(1);
      expect(result.total).toBe(7);
      expect(result.scenes[0]).toEqual(expect.objectContaining({ id: SCENE_ID, artHeightCm: 41 }));
      expect(result.scenes[0]).not.toHaveProperty('total');
    });

    it('ordena pelo nome sem acento e sem caixa, depois pelo id, e pagina por LIMIT e OFFSET', async () => {
      const { manager, query } = fakeManager([{ ...rawScene, total: '1' }]);
      await reader.listPage(manager, { ...base, page: 3, limit: 2 });
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('ORDER BY unaccent(lower(s.name)), s.id');
      expect(sql).toContain('count(*) OVER ()');
      expect(params.slice(-2)).toEqual([2, 4]);
    });

    it('as regras de inclusão vão no SQL: não excluída, formatos do Encarte Pro e face pronta pelo marcador', async () => {
      const { manager, query } = fakeManager([{ ...rawScene, total: '1' }]);
      await reader.listPage(manager, base);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('s."deletedAt" IS NULL');
      expect(sql).toContain(`s."formatId" = ANY($1::text[])`);
      expect(sql).toContain(`t.configuration #>> '{source,kind}' = 'template-scene'`);
      expect(sql).toContain(
        `COALESCE(f."templateId", CASE WHEN f."index" = 0 THEN s."approvedTemplateId" END)`,
      );
      expect(params[0]).toEqual(['folheto-27x40', 'folheto-54x40']);
    });

    it('sceneId e search entram como parâmetros, com o termo escapado e sem aparar', async () => {
      const { manager, query } = fakeManager([{ ...rawScene, total: '1' }]);
      await reader.listPage(manager, { ...base, sceneId: SCENE_ID, search: ' 50%_ ' });
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('s.id = $2::uuid');
      expect(sql).toContain(`unaccent(s.name) ILIKE '%' || unaccent($3::text) || '%'`);
      expect(params.slice(0, 3)).toEqual([base.formatIds, SCENE_ID, ' 50\\%\\_ ']);
    });

    it('busca vazia vale como sem filtro', async () => {
      const { manager, query } = fakeManager([{ ...rawScene, total: '1' }]);
      await reader.listPage(manager, { ...base, search: '' });
      expect(query.mock.calls[0][0]).not.toContain('ILIKE');
    });

    it('página vazia: conta à parte, com o mesmo filtro, e devolve o total real', async () => {
      const { manager, query } = fakeManager([], [{ total: '5' }]);
      const result = await reader.listPage(manager, { ...base, search: 'x', page: 9 });
      expect(result).toEqual({ scenes: [], total: 5 });
      expect(query).toHaveBeenCalledTimes(2);
      const [countSql, countParams] = query.mock.calls[1];
      expect(countSql).toContain('count(*)');
      expect(countSql).toContain('ILIKE');
      expect(countParams).toEqual([base.formatIds, 'x']);
    });
  });

  describe('findScene', () => {
    it('acha a cena pelo id, inclusive a excluída', async () => {
      const deletedAt = new Date('2026-11-14T00:00:00.000Z');
      const { manager, query } = fakeManager([{ ...rawScene, deletedAt }]);
      const scene = await reader.findScene(manager, SCENE_ID);
      expect(scene?.deletedAt).toEqual(deletedAt);
      expect(query.mock.calls[0][0]).not.toContain('"deletedAt" IS NULL');
    });

    it('id que não existe devolve null', async () => {
      const { manager } = fakeManager([]);
      expect(await reader.findScene(manager, SCENE_ID)).toBeNull();
    });

    it('id que não é UUID devolve null sem consultar o banco', async () => {
      const { manager, query } = fakeManager();
      expect(await reader.findScene(manager, 'abc')).toBeNull();
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('templateRows', () => {
    it('sem ids não consulta', async () => {
      const { manager, query } = fakeManager();
      expect(await reader.templateRows(manager, [])).toEqual([]);
      expect(query).not.toHaveBeenCalled();
    });

    it('lê só o que a regra usa, e não a configuração inteira', async () => {
      const { manager, query } = fakeManager([]);
      await reader.templateRows(manager, ['a']);
      const sql: string = query.mock.calls[0][0];
      expect(sql).toContain(`configuration #>> '{bodyBackground,imageUrl}'`);
      expect(sql).toContain(`configuration -> 'source'`);
      expect(sql).toContain(`configuration -> 'header'`);
      expect(sql).toContain(`configuration -> 'footer'`);
      expect(sql).not.toMatch(/SELECT\s+(id,\s*)?configuration\s*[,F]/);
    });
  });
});
