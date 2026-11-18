import { randomUUID } from 'crypto';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  createdAtText,
  DocumentBody,
  envelope,
  savePayload,
  useDocumentsE2e,
} from '../testing/flyer-pro-documents.e2e.testutil';
import { insertDocumentWithItems } from '../testing/flyer-pro-documents.fixture';
import type { FlyerProItemsPage } from '../services/flyer-pro-items.service';

/**
 * e2e do N12 (change 09-add-flyer-pro-save-api) sobre o harness da 05: a leitura dos itens pelo SQL real, o cursor em
 * microssegundos, a comparação incremental exata e o carimbo dos itens gravado depois da trava. A forma do `updatedAfter`
 * está no spec do DTO (L-19).
 */
describeIfE2eDb('GET /v1/flyer-pro/documents/:id/items: ler os itens (e2e)', () => {
  const { h, url, clientA, asBruno, create, open, patch } = useDocumentsE2e({ scenes: false });
  const read = async (id: string, query = '') =>
    envelope<FlyerProItemsPage>(await h.get(`${url}/${id}/items${query}`)).data;
  const newDocument = async () =>
    envelope<DocumentBody>(await create(h.seed.scenes.frontBack.id)).data;
  const abacate = () => ({
    id: randomUUID(),
    position: 0,
    name: 'ABACATE',
    price: { kind: 'simple', cents: 699 },
    unit: 'kg',
  });

  it('sem updatedAfter vêm todos por position e id, na forma da abertura, com o cursor do maior updatedAt', async () => {
    const { id, itemIds } = await insertDocumentWithItems(h.dataSource, { clientId: clientA() }, [
      { position: 2, updatedAtText: '2026-11-14 13:05:40.412377+00' },
      { position: 0, updatedAtText: '2026-11-14 13:05:40.000001+00' },
      { position: 1, updatedAtText: '2026-11-14 10:00:00+00' },
    ]);

    const page = await read(id);

    expect(page.items.map((item) => item.id)).toEqual([itemIds[1], itemIds[2], itemIds[0]]);
    expect(page.cursor).toBe('2026-11-14T13:05:40.412377Z');
    expect(page.items).toEqual((await open(id)).items);
    expect(page.items[0]).not.toHaveProperty('documentId');
  });

  it('o incremental é exato ao microssegundo: nada depois do cursor devolve [] e o mesmo cursor; um microssegundo depois, o item', async () => {
    const { id, itemIds } = await insertDocumentWithItems(h.dataSource, { clientId: clientA() }, [
      { position: 0, updatedAtText: '2026-11-14 13:05:40.412377+00' },
      { position: 1, updatedAtText: '2026-11-14 13:05:40.412378+00' },
    ]);
    const cursor = '2026-11-14T13:05:40.412377Z';

    const nothing = await read(id, `?updatedAfter=${cursor.replace('377', '378')}`);
    const next = await read(id, `?updatedAfter=${cursor}`);
    const unzoned = await read(id, '?updatedAfter=2026-11-14T13:05:40.412376');

    expect(nothing).toEqual({ items: [], cursor: '2026-11-14T13:05:40.412378Z' });
    expect(next.items.map((item) => item.id)).toEqual([itemIds[1]]);
    expect(next.cursor).toBe('2026-11-14T13:05:40.412378Z');
    expect(unzoned.items.map((item) => item.id)).toEqual(itemIds);
  });

  it('encarte sem itens: o cursor é o createdAt do encarte, e com updatedAfter repete o valor recebido', async () => {
    const { id } = await newDocument();
    const created = await createdAtText(h.dataSource, id);

    expect(await read(id)).toEqual({ items: [], cursor: created });
    expect(await read(id, '?updatedAfter=2026-11-14T13:05:40.412377Z')).toEqual({
      items: [],
      cursor: '2026-11-14T13:05:40.412377Z',
    });
  });

  it('o PATCH carimba os itens depois da trava: a leitura depois do cursor da abertura traz o preço novo, e as gravações em fila crescem', async () => {
    const { id } = await newDocument();
    const item = abacate();
    await patch(id, savePayload(0, { items: { upsert: [item] } }));
    const opened = await open(id);

    await patch(
      id,
      savePayload(1, {
        items: { upsert: [{ id: item.id, price: { kind: 'simple', cents: 599 } }] },
      }),
    );
    const afterChange = await read(id, `?updatedAfter=${opened.itemsCursor}`);
    await patch(id, savePayload(2, { items: { upsert: [{ id: item.id, name: 'ABACATE 2' }] } }));
    const afterSecond = await read(id, `?updatedAfter=${afterChange.cursor}`);

    expect(afterChange.items).toEqual([
      expect.objectContaining({ id: item.id, price: { kind: 'simple', cents: 599 } }),
    ]);
    expect(afterChange.cursor > opened.itemsCursor).toBe(true);
    expect(afterSecond.items).toEqual([expect.objectContaining({ name: 'ABACATE 2' })]);
    expect(afterSecond.cursor > afterChange.cursor).toBe(true);
  });

  it('item excluído por um PATCH não aparece; fechar e reabrir: a abertura e a leitura trazem o preço gravado', async () => {
    const { id } = await newDocument();
    const [keep, drop] = [abacate(), { ...abacate(), position: 1 }];
    await patch(id, savePayload(0, { items: { upsert: [keep, drop] } }));
    const cursor = (await read(id)).cursor;

    await patch(
      id,
      savePayload(1, {
        items: {
          delete: [drop.id],
          upsert: [{ id: keep.id, price: { kind: 'simple', cents: 599 } }],
        },
      }),
    );

    const incremental = await read(id, `?updatedAfter=${cursor}`);
    expect(incremental.items.map((entry) => entry.id)).toEqual([keep.id]);
    const reopened = (await open(id)).items.map((entry) => entry.price);
    expect(reopened).toEqual([{ kind: 'simple', cents: 599 }]);
    expect((await read(id)).items.map((entry) => entry.price)).toEqual(reopened);
  });

  describe('o app montado: guard, pipe global, filtro e a rota', () => {
    it('outro usuário lê (200); sem token é 401; id que não é UUID e encarte excluído são o mesmo 404', async () => {
      const { id } = await newDocument();
      const bruno = await h.http().get(`/v1${url}/${id}/items`).set(asBruno());
      const unauthorized = await h.http().get(`/v1${url}/abc/items`);
      await h.delete(`${url}/${id}`);

      expect(bruno.status).toBe(200);
      expect(unauthorized.status).toBe(401);
      for (const target of ['abc', id]) {
        const response = await h.get(`${url}/${target}/items`);
        expect(response.status).toBe(404);
        expect(envelope<unknown>(response).error).toMatchObject({ code: 'FLYER_PRO_NOT_FOUND' });
      }
    });

    it('updatedAfter que não é ISO 8601 é 400 BAD_REQUEST', async () => {
      const { id } = await newDocument();

      const response = await h.get(`${url}/${id}/items?updatedAfter=ontem`);

      expect(response.status).toBe(400);
      expect(envelope<unknown>(response).error).toMatchObject({ code: 'BAD_REQUEST' });
    });
  });
});
