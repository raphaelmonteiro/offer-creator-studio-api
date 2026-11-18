import { randomUUID } from 'crypto';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import { envelope, ListEntry, useDocumentsE2e } from '../testing/flyer-pro-documents.e2e.testutil';
import { insertDocument, insertDocumentWithItems } from '../testing/flyer-pro-documents.fixture';

/**
 * e2e do N2 (change 08-add-flyer-pro-document-api) sobre o harness da 05: ordem, paginação, busca e filtro por cliente no SQL
 * real, com encartes gravados direto no banco e cada consulta filtrada por um cliente da suíte.
 */
describeIfE2eDb('GET /v1/flyer-pro/documents: listar (e2e)', () => {
  const { h, url, asBruno, bruno, noToken, list, names, newClient } = useDocumentsE2e({
    scenes: false,
  });

  describe('listar (N2)', () => {
    it('segunda página de 25: 5 entradas em updatedAt decrescente, paginação e só as chaves leves', async () => {
      const clientId = await newClient();
      const base = Date.parse('2026-02-01T10:00:00Z');
      for (let i = 0; i < 25; i += 1) {
        await insertDocument(h.dataSource, { clientId, updatedAt: new Date(base + i * 1000) });
      }

      const page = await list(`clientId=${clientId}&page=2&limit=20`);
      const beyond = await list(`clientId=${clientId}&page=5`);
      const standard = await list(`clientId=${clientId}`);

      expect(page.data).toHaveLength(5);
      expect(page.pagination).toEqual({ page: 2, limit: 20, total: 25, totalPages: 2 });
      const times = page.data.map((entry) => entry.updatedAt);
      expect(times).toEqual([...times].sort().reverse());
      for (const absent of [
        'slices',
        'items',
        'ui',
        'templateSnapshot',
        'creationKey',
        'deletedAt',
        'lastExportedAt',
        'thumbnailUrl',
      ]) {
        expect(page.data[0]).not.toHaveProperty(absent);
      }
      expect(beyond.data).toEqual([]);
      expect(beyond.pagination).toMatchObject({ page: 5, total: 25 });
      expect(standard.pagination).toMatchObject({ page: 1, limit: 20 });
    });

    it('traz cliente, itens e quem gravou por último; autor que sumiu vem nulo; encartes de todos, menos os excluídos', async () => {
      const clientId = await newClient('Piccin Supermercado');
      await insertDocumentWithItems(
        h.dataSource,
        { clientId, name: 'Com itens', updatedByUserId: h.seed.user.id },
        3,
      );
      await insertDocument(h.dataSource, {
        clientId,
        name: 'Sem autor',
        updatedByUserId: randomUUID(),
      });
      await insertDocument(h.dataSource, { clientId, name: 'Excluído', deletedAt: new Date() });
      await insertDocument(h.dataSource, {
        clientId,
        name: 'Do Bruno',
        updatedByUserId: bruno().id,
      });

      const listed = await h.http().get(`/v1${url}?clientId=${clientId}`).set(asBruno());
      const byName = Object.fromEntries(
        envelope<ListEntry[]>(listed).data.map((entry) => [entry.name, entry]),
      );

      expect(Object.keys(byName).sort()).toEqual(['Com itens', 'Do Bruno', 'Sem autor']);
      expect(envelope<ListEntry[]>(listed).pagination?.total).toBe(3);
      expect(byName['Com itens']).toMatchObject({ itemCount: 3, updatedByName: h.seed.user.name });
      expect(byName['Com itens'].clientName).toContain('Piccin Supermercado');
      expect(byName['Sem autor'].updatedByName).toBeNull();
      expect(byName['Do Bruno'].updatedByName).toBe('Bruno');
    });

    it('mesmo instante de atualização: a mesma ordem nas duas chamadas, o de maior id primeiro', async () => {
      const clientId = await newClient();
      const same = new Date('2026-03-01T10:00:00Z');
      const ids = [
        await insertDocument(h.dataSource, { clientId, updatedAt: same }),
        await insertDocument(h.dataSource, { clientId, updatedAt: same }),
      ];

      const first = (await list(`clientId=${clientId}`)).data.map((entry) => entry.id);
      const second = (await list(`clientId=${clientId}`)).data.map((entry) => entry.id);

      expect(first).toEqual([...ids].sort().reverse());
      expect(second).toEqual(first);
    });

    it('busca: sem maiúsculas nem acentos, curingas como texto, só o nome do encarte, com o cliente e vazia', async () => {
      const clientId = await newClient('Piccin Supermercado');
      const centro = await newClient();
      for (const name of [
        'Ofertas PICCIN',
        'Feira de sábado',
        'Leve 50% mais',
        'Leve 500g',
        'Promo A_B',
        'Promo AxB',
      ]) {
        await insertDocument(h.dataSource, { clientId, name });
      }
      await insertDocument(h.dataSource, { clientId: centro, name: 'Ofertas Piccin Centro' });
      const q = (term: string) => `clientId=${clientId}&search=${encodeURIComponent(term)}`;

      expect(await names(q('piccin'))).toEqual(['Ofertas PICCIN']);
      expect(await names(q('sabado'))).toEqual(['Feira de sábado']);
      expect(await names(q('SÁBADO'))).toEqual(['Feira de sábado']);
      expect(await names(q('50%'))).toEqual(['Leve 50% mais']);
      expect(await names(q('A_B'))).toEqual(['Promo A_B']);
      expect(await names(q('Supermercado'))).toEqual([]);
      expect((await names(q(''))).length).toBe(6);
      expect(await names(`clientId=${centro}&search=piccin`)).toEqual(['Ofertas Piccin Centro']);
      expect(await names(`clientId=${randomUUID()}`)).toEqual([]);
    });

    it('consulta fora da forma é 400: limit=51 e parâmetro desconhecido (o pipe global recusa); sem token é 401', async () => {
      for (const query of ['limit=51', 'foo=1']) {
        const response = await h.get(`${url}?${query}`);
        expect(response.status).toBe(400);
        expect(envelope<null>(response).error?.code).toBe('BAD_REQUEST');
      }
      expect((await noToken(url)).status).toBe(401);
    });
  });
});
