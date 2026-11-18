import { documentUpdate } from './flyer-pro-document-update';

describe('documentUpdate', () => {
  it('monta só as colunas dadas, com o id em $1 e a guarda de encarte não excluído', () => {
    const { sql, params } = documentUpdate('d1', { name: 'Ofertas', pageCount: 2 });

    expect(sql).toBe(
      'UPDATE "flyer_pro_documents" SET "name" = $2, "pageCount" = $3 WHERE "id" = $1 AND "deletedAt" IS NULL',
    );
    expect(params).toEqual(['d1', 'Ofertas', 2]);
  });

  it('colunas jsonb vão como texto JSON com a conversão; objeto nulo vai nulo', () => {
    const slice = { share: 0.6050000000000001 };
    const { sql, params } = documentUpdate('d1', { card: slice, layoutSnapshot: null });

    expect(sql).toContain('"card" = $2::jsonb, "layoutSnapshot" = $3::jsonb');
    expect(params).toEqual(['d1', JSON.stringify(slice), null]);
  });

  it('updatedAt vai como timestamptz e RETURNING lista o que se pede', () => {
    const { sql } = documentUpdate('d1', { updatedAt: '2026-11-14T14:33:10.004512Z' }, [
      'updatedAt',
    ]);

    expect(sql).toContain('"updatedAt" = $2::timestamptz');
    expect(sql.endsWith('RETURNING "updatedAt"')).toBe(true);
  });

  it('não escreve nenhuma coluna que não foi dada (o updatedAt não entra por conta própria)', () => {
    expect(documentUpdate('d1', { engineVersion: 2 }).sql).not.toContain('updatedAt');
  });
});
