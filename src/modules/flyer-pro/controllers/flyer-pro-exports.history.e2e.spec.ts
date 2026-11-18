import { randomUUID } from 'crypto';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import { envelope } from '../testing/flyer-pro-documents.e2e.testutil';
import { insertDocument } from '../testing/flyer-pro-documents.fixture';
import { useExportsE2e } from '../testing/flyer-pro-exports.e2e.testutil';
import { insertExport } from '../testing/flyer-pro-exports.fixture';
import type { FlyerProExportView } from '../views/flyer-pro-export.view';

/**
 * e2e do N9 (change 38-add-flyer-pro-export-history-api) sobre o harness da 05, só o que depende do SQL real e do app
 * montado: a ordem e a segunda página de 25 exportações, só as do encarte, o desempate pelo `id`, o autor que não existe
 * mais, o `filePath` que não sai, a exclusão lógica que mantém as exportações e o guard e o pipe globais. A forma da
 * consulta e a regra da página estão nos unitários (L-19).
 */
describeIfE2eDb('GET /v1/flyer-pro/documents/:id/exports: histórico (e2e)', () => {
  const { h, clientA, asBruno, history, noToken } = useExportsE2e();
  const newDocument = () => insertDocument(h.dataSource, { clientId: clientA() });
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 14, 13, minute));
  const read = async (id: string, query = '', headers?: Record<string, string>) =>
    envelope<FlyerProExportView[]>(await history(id, query, headers));

  it('com 25 exportações, a segunda página traz as 5 mais antigas em ordem decrescente e o total real', async () => {
    const documentId = await newDocument();
    const ids: string[] = [];
    for (let minute = 0; minute < 25; minute += 1) {
      ids.push(await insertExport(h.dataSource, documentId, { createdAt: at(minute) }));
    }

    const first = await read(documentId);
    const second = await read(documentId, '?page=2&limit=20');

    expect(first.data).toHaveLength(20);
    expect(first.data[0].id).toBe(ids[24]);
    expect(second.data.map((entry) => entry.id)).toEqual([ids[4], ids[3], ids[2], ids[1], ids[0]]);
    expect(second.pagination).toEqual({ page: 2, limit: 20, total: 25, totalPages: 2 });
    expect(first.pagination).toMatchObject({ page: 1, limit: 20 });
  });

  it('só as exportações do encarte, e duas no mesmo instante vêm sempre na mesma ordem, a de maior id primeiro', async () => {
    const documentId = await newDocument();
    const other = await newDocument();
    const low = '11111111-1111-4111-8111-111111111111';
    const high = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await insertExport(h.dataSource, documentId, { id: low, createdAt: at(5) });
    await insertExport(h.dataSource, documentId, { id: high, createdAt: at(5) });
    await insertExport(h.dataSource, other, { createdAt: at(9) });

    const once = await read(documentId);
    const twice = await read(documentId);

    expect(once.data.map((entry) => entry.id)).toEqual([high, low]);
    expect(twice.data.map((entry) => entry.id)).toEqual([high, low]);
    expect(once.pagination.total).toBe(2);
  });

  it('o autor que não existe mais vem com createdByName nulo, outro usuário lê o histórico e o filePath interno não sai', async () => {
    const documentId = await newDocument();
    await insertExport(h.dataSource, documentId, {
      createdByUserId: h.seed.user.id,
      createdAt: at(1),
    });
    await insertExport(h.dataSource, documentId, {
      createdByUserId: randomUUID(),
      filePath: 'exports/interno/arquivo.pdf',
      createdAt: at(2),
    });

    const asOther = await read(documentId, '', asBruno());

    expect(asOther.data.map((entry) => entry.createdByName)).toEqual([null, h.seed.user.name]);
    for (const entry of asOther.data) {
      expect(entry).toMatchObject({ fileSize: 31457280, fileState: 'not_stored', hasFile: false });
      expect(entry).not.toHaveProperty('filePath');
      expect(entry).not.toHaveProperty('replayed');
    }
  });

  it('encarte sem exportação é 200 com data vazio; excluído pelo N6 é 404 e as exportações continuam no banco; id que não é UUID é o mesmo 404', async () => {
    const documentId = await newDocument();
    const empty = await read(documentId);
    await insertExport(h.dataSource, documentId);
    await h.delete(`/flyer-pro/documents/${documentId}`);

    expect(empty.data).toEqual([]);
    expect(empty.pagination).toMatchObject({ total: 0, totalPages: 0 });
    for (const target of [documentId, 'abc', randomUUID()]) {
      const response = await history(target);
      expect(response.status).toBe(404);
      expect(envelope<unknown>(response).error).toMatchObject({ code: 'FLYER_PRO_NOT_FOUND' });
    }
    const [{ n }] = await h.dataSource.query(
      `SELECT count(*)::int AS n FROM flyer_pro_exports WHERE "documentId" = $1`,
      [documentId],
    );
    expect(n).toBe(1);
  });

  it('sem token é 401 antes do id; limit=51 e search são 400 pelo pipe global', async () => {
    const documentId = await newDocument();

    const unauthorized = await noToken.history('abc');
    const tooMany = await history(documentId, '?limit=51');
    const search = await history(documentId, '?search=piccin');

    expect(unauthorized.status).toBe(401);
    for (const response of [tooMany, search]) {
      expect(response.status).toBe(400);
      expect(envelope<unknown>(response).error).toMatchObject({ code: 'BAD_REQUEST' });
    }
  });
});
