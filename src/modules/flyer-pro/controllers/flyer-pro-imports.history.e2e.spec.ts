import { randomUUID } from 'crypto';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import { envelope, useDocumentsE2e } from '../testing/flyer-pro-documents.e2e.testutil';
import { importsOf, insertImport } from '../testing/flyer-pro-imports.fixture';
import type { FlyerProImportView } from '../views/flyer-pro-import.view';

/**
 * e2e do N13 (change 19-add-flyer-pro-imports-api) sobre o harness da 05, só o que depende do SQL real e do app montado: o
 * filtro exato por `fileHash` (inclusive o mesmo arquivo em outro encarte), a ordem e a segunda página de 23
 * importações, o autor que não existe mais, a exclusão lógica que mantém as importações e o guard e o pipe globais. A
 * forma da consulta e a regra da página estão nos unitários (L-19).
 */
describeIfE2eDb('GET /v1/flyer-pro/documents/:id/imports: histórico (e2e)', () => {
  const { h, url, asBruno, noToken, newDocument } = useDocumentsE2e({ scenes: false });
  const history = async (id: string, query = '', headers?: Record<string, string>) => {
    const request = headers
      ? h.http().get(`/v1${url}/${id}/imports${query}`).set(headers)
      : h.get(`${url}/${id}/imports${query}`);
    return envelope<FlyerProImportView[]>(await request);
  };
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 14, 13, minute));

  it('o filtro por fileHash traz só as deste encarte, a mais recente primeiro; o mesmo arquivo em outro encarte não conta', async () => {
    const { id } = await newDocument();
    const other = await newDocument();
    const old = await insertImport(h.dataSource, id, { fileHash: 'h1', createdAt: at(2) });
    const recent = await insertImport(h.dataSource, id, {
      fileName: 'lista-piccin-v2.xlsx',
      fileHash: 'h2',
      createdAt: at(30),
    });
    await insertImport(h.dataSource, other.id, { fileHash: 'h1', createdAt: at(40) });
    await insertImport(h.dataSource, other.id, { fileHash: 'h3', createdAt: at(41) });

    const all = await history(id);
    const filtered = await history(id, '?fileHash=h1');
    const never = await history(id, '?fileHash=h3');

    expect(all.data.map((entry) => entry.id)).toEqual([recent, old]);
    expect(filtered.data.map((entry) => entry.id)).toEqual([old]);
    expect(filtered.data[0].createdAt).toBe(at(2).toISOString());
    expect(never.data).toEqual([]);
    expect(never.pagination).toMatchObject({ total: 0, totalPages: 0 });
  });

  it('com 23 importações, a segunda página traz as 3 mais antigas e o total real', async () => {
    const { id } = await newDocument();
    const ids: string[] = [];
    for (let minute = 0; minute < 23; minute += 1) {
      ids.push(await insertImport(h.dataSource, id, { createdAt: at(minute) }));
    }

    const first = await history(id);
    const second = await history(id, '?page=2');

    expect(first.data).toHaveLength(20);
    expect(first.data[0].id).toBe(ids[22]);
    expect(second.data.map((entry) => entry.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(second.pagination).toEqual({ page: 2, limit: 20, total: 23, totalPages: 2 });
  });

  it('o autor que não existe mais vem com createdByName nulo, e outro usuário lê o histórico', async () => {
    const { id } = await newDocument();
    await insertImport(h.dataSource, id, { createdByUserId: h.seed.user.id, createdAt: at(1) });
    await insertImport(h.dataSource, id, { createdByUserId: randomUUID(), createdAt: at(2) });

    const asOther = await history(id, '', asBruno());

    expect(asOther.data.map((entry) => entry.createdByName)).toEqual([null, h.seed.user.name]);
  });

  it('encarte excluído pelo N6 é 404 e as importações continuam no banco; id que não é UUID é o mesmo 404', async () => {
    const { id } = await newDocument();
    await insertImport(h.dataSource, id);
    await h.delete(`${url}/${id}`);

    for (const target of [id, 'abc']) {
      const response = await h.get(`${url}/${target}/imports`);
      expect(response.status).toBe(404);
      expect(envelope<unknown>(response).error).toMatchObject({ code: 'FLYER_PRO_NOT_FOUND' });
    }
    expect(await importsOf(h.dataSource, id)).toHaveLength(1);
  });

  it('sem token é 401 antes do id; search é parâmetro desconhecido e dá 400', async () => {
    const { id } = await newDocument();

    const unauthorized = await noToken(`${url}/abc/imports`);
    const search = await h.get(`${url}/${id}/imports?search=abacate`);

    expect(unauthorized.status).toBe(401);
    expect(search.status).toBe(400);
    expect(envelope<unknown>(search).error).toMatchObject({ code: 'BAD_REQUEST' });
  });
});
