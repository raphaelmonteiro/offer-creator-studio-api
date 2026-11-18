import { randomUUID } from 'crypto';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  countItems,
  DocumentBody,
  envelope,
  rowOf,
  savePayload,
  SaveBody,
  useDocumentsE2e,
} from '../testing/flyer-pro-documents.e2e.testutil';
import { insertDocumentWithItems } from '../testing/flyer-pro-documents.fixture';

/**
 * e2e do ramo `items` do N4 (change 09-add-flyer-pro-save-api) sobre o harness da 05: o fluxo incluir, alterar e excluir pelo
 * SQL real (lote com `jsonb_populate_recordset`, `DELETE ... RETURNING`), o que a transação desfaz, o limite de 500
 * sobre uma contagem de verdade, o id de outro encarte e as decisões sobre sugestões já gravadas. A regra de cada campo
 * está nos unitários do validador e do que o servidor deriva (L-19).
 */
describeIfE2eDb('PATCH /v1/flyer-pro/documents/:id: itens (e2e)', () => {
  const { h, clientA, create, open, patch } = useDocumentsE2e({ scenes: false });
  const newDocument = async () =>
    envelope<DocumentBody>(await create(h.seed.scenes.frontBack.id)).data;
  const data = (response: { body: unknown }) => envelope<SaveBody>(response).data;
  const newItem = (over: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    position: 0,
    name: 'ABACATE',
    price: { kind: 'simple', cents: 699 },
    unit: 'kg',
    ...over,
  });
  const dbItem = async (id: string) =>
    (await h.dataSource.query(`SELECT * FROM flyer_pro_items WHERE id = $1`, [id]))[0];

  it('incluir, alterar só o preço e excluir (com um id estranho): o encarte aberto e a resposta batem', async () => {
    const { id } = await newDocument();
    const abacate = newItem();
    const cerveja = newItem({ name: 'CERVEJA PILSEN GARRAFA 600ML', position: 1, unit: 'cada' });

    const created = data(
      await patch(id, savePayload(0, { items: { upsert: [abacate, cerveja] } })),
    );
    const changed = data(
      await patch(
        id,
        savePayload(1, {
          items: { upsert: [{ id: abacate.id, price: { kind: 'simple', cents: 599 } }] },
        }),
      ),
    );
    const removed = data(
      await patch(id, savePayload(2, { items: { delete: [cerveja.id, randomUUID()] } })),
    );

    expect(created.items).toEqual([
      expect.objectContaining({
        id: abacate.id,
        category: null,
        categorySource: null,
        isAlcoholic: false,
        imageStatus: 'none',
        eanValid: null,
      }),
      expect.objectContaining({ id: cerveja.id, unit: 'cada' }),
    ]);
    expect(changed.items[0]).toMatchObject({
      name: 'ABACATE',
      price: { kind: 'simple', cents: 599 },
    });
    expect(removed).toMatchObject({ revision: 3, deletedItemIds: [cerveja.id], items: [] });
    const reopened = await open(id);
    expect(reopened.items.map((item) => [item.id, item.price])).toEqual([
      [abacate.id, { kind: 'simple', cents: 599 }],
    ]);
  });

  it('os cinco tipos de preço voltam do banco iguais ao enviado', async () => {
    const { id } = await newDocument();
    const prices = [
      { kind: 'simple', cents: 699 },
      { kind: 'from_to', cents: 3990, fromCents: 4990 },
      { kind: 'second_price', cents: 1199, secondCents: 999, secondLabel: 'Clube' },
      { kind: 'per_kg_ref', cents: 2490, refKgCents: 4980 },
      { kind: 'multi_buy', cents: 899, buy: 3, pay: 2 },
    ];
    const upsert = prices.map((price, position) => newItem({ price, position }));

    const response = await patch(id, savePayload(0, { items: { upsert } }));

    expect(response.status).toBe(200);
    expect((await open(id)).items.map((item) => item.price)).toEqual(prices);
  });

  it('o reenvio traz os itens citados como estão e não grava; replaceAll apaga o que não veio e mantém a foto', async () => {
    const { id } = await newDocument();
    const [a, b, c] = [
      newItem({ position: 0 }),
      newItem({ position: 1 }),
      newItem({ position: 2 }),
    ];
    const photo = {
      galleryImageId: randomUUID(),
      imageUrl: 'http://localhost:3101/uploads/gallery/a.png',
      imageWidth: 900,
      imageHeight: 700,
      imageOrigin: 'picker',
    };
    await patch(id, savePayload(0, { items: { upsert: [{ ...a, ...photo }, b, c] } }));
    const body = savePayload(1, { items: { upsert: [{ id: a.id, name: 'ABACATE 2' }] } });
    await patch(id, body);
    const before = await dbItem(a.id);

    const replay = data(await patch(id, body));
    const afterReplay = await dbItem(a.id);
    const replaced = data(
      await patch(id, savePayload(2, { items: { replaceAll: true, upsert: [a, b] } })),
    );

    expect(replay).toMatchObject({ replayed: true, revision: 2, deletedItemIds: [] });
    expect(replay.items).toEqual([expect.objectContaining({ id: a.id, name: 'ABACATE 2' })]);
    expect(afterReplay.updatedAt).toEqual(before.updatedAt);
    expect(replaced.deletedItemIds).toEqual([c.id]);
    expect(await countItems(h.dataSource, id)).toBe(2);
    expect(await dbItem(a.id)).toMatchObject({ imageUrl: photo.imageUrl, imageStatus: 'applied' });
  });

  it('item inválido com fatia e item válido no mesmo corpo: 422 com todos os issues e a transação desfaz tudo', async () => {
    const { id } = await newDocument();
    const valid = newItem();

    const response = await patch(
      id,
      savePayload(0, {
        slices: { card: { theme: 'a' } },
        items: {
          upsert: [
            valid,
            newItem({ unit: 'un' }),
            newItem({ price: { kind: 'simple', cents: 0 } }),
          ],
        },
      }),
    );

    expect(response.status).toBe(422);
    const { error } = envelope<unknown>(response) as unknown as {
      error: { code: string; issues: Array<{ code: string }> };
    };
    expect(error.code).toBe('FLYER_PRO_ITEM_INVALID');
    expect(error.issues.map((issue) => issue.code).sort()).toEqual([
      'PRICE_INVALID',
      'UNIT_UNKNOWN',
    ]);
    expect(await dbItem(valid.id)).toBeUndefined();
    expect(await rowOf(h.dataSource, id)).toMatchObject({ revision: 0, card: {} });
  });

  it('id de item de outro encarte: 409 com o id, e os itens dos dois ficam como estavam', async () => {
    const mine = await newDocument();
    const other = await insertDocumentWithItems(h.dataSource, { clientId: clientA() }, 2);
    const before = await dbItem(other.itemIds[0]);

    const response = await patch(
      mine.id,
      savePayload(0, { items: { upsert: [newItem(), { id: other.itemIds[0], name: 'X' }] } }),
    );

    expect(response.status).toBe(409);
    expect(envelope<unknown>(response).error).toMatchObject({
      code: 'FLYER_PRO_ITEM_ID_CONFLICT',
      details: { itemIds: [other.itemIds[0]] },
    });
    expect(await dbItem(other.itemIds[0])).toEqual(before);
    expect(await countItems(h.dataSource, mine.id)).toBe(0);
    expect(await countItems(h.dataSource, other.id)).toBe(2);
  });

  it('limite de 500: dois itens a mais com 499 é 422 e continua com 499; uma troca e depois um novo termina em 500', async () => {
    const { id } = await insertDocumentWithItems(h.dataSource, { clientId: clientA() }, 499);

    const over = await patch(id, savePayload(0, { items: { upsert: [newItem(), newItem()] } }));

    expect(over.status).toBe(422);
    expect(envelope<unknown>(over).error).toMatchObject({
      code: 'FLYER_PRO_ITEM_LIMIT',
      details: { max: 500, total: 501 },
    });
    expect(await countItems(h.dataSource, id)).toBe(499);
    const [{ id: oldest }] = await h.dataSource.query(
      `SELECT id FROM flyer_pro_items WHERE "documentId" = $1 LIMIT 1`,
      [id],
    );
    const swap = await patch(
      id,
      savePayload(0, { items: { upsert: [newItem()], delete: [oldest] } }),
    );
    const last = await patch(id, savePayload(1, { items: { upsert: [newItem()] } }));
    expect([swap.status, last.status]).toEqual([200, 200]);
    expect(await countItems(h.dataSource, id)).toBe(500);
  });

  describe('decisões sobre sugestões já gravadas (D-1 (a))', () => {
    const pending = (extra: Record<string, unknown>) => ({
      checkedAt: '2026-11-14T13:05:02.000Z',
      jobId: null,
      suggestion: { status: 'pending', ...extra },
    });
    const seedPending = async () => {
      const { id, itemIds } = await insertDocumentWithItems(h.dataSource, { clientId: clientA() }, [
        {
          name: 'CERVEJA PILSEN GARRAFA 600ML',
          category: 'Mercearia',
          categorySource: 'import',
          categoryReview: pending({ category: 'Bebidas', confidence: 0.9, why: null }),
        },
        { imageStatus: 'review', imageReview: pending({ candidates: [] }) },
      ]);
      return { id, beer: itemIds[0], photo: itemIds[1] };
    };

    it('aceitar sem a categoria e recusar as fotos com a foto escolhida são 422, e as sugestões seguem pendentes', async () => {
      const { id, beer, photo } = await seedPending();
      const group = {
        galleryImageId: randomUUID(),
        imageUrl: 'http://localhost:3101/uploads/gallery/a.png',
        imageWidth: 900,
        imageHeight: 700,
        imageOrigin: 'picker',
      };

      const noCategory = await patch(
        id,
        savePayload(0, { items: { upsert: [{ id: beer, categoryDecision: 'accept' }] } }),
      );
      const both = await patch(
        id,
        savePayload(0, { items: { upsert: [{ id: photo, imageDecision: 'reject', ...group }] } }),
      );

      expect([noCategory.status, both.status]).toEqual([422, 422]);
      expect((await dbItem(beer)).categoryReview.suggestion.status).toBe('pending');
      expect((await dbItem(photo)).imageReview.suggestion.status).toBe('pending');
    });

    it('aceitar com outra categoria vale como troca à mão e recusar as fotos dá not_found; aceitar a sugerida vira "ai"', async () => {
      const first = await seedPending();
      const second = await seedPending();

      const other = await patch(
        first.id,
        savePayload(0, {
          items: {
            upsert: [
              { id: first.beer, category: 'Bazar', categoryDecision: 'accept' },
              { id: first.photo, imageDecision: 'reject' },
            ],
          },
        }),
      );
      const accepted = await patch(
        second.id,
        savePayload(0, {
          items: { upsert: [{ id: second.beer, category: 'Bebidas', categoryDecision: 'accept' }] },
        }),
      );

      expect([other.status, accepted.status]).toEqual([200, 200]);
      expect(await dbItem(first.beer)).toMatchObject({
        category: 'Bazar',
        categorySource: 'user',
        categoryReview: { suggestion: { status: 'rejected', reason: 'superseded' } },
      });
      expect(await dbItem(first.photo)).toMatchObject({
        imageStatus: 'not_found',
        imageReview: { suggestion: { status: 'rejected' } },
      });
      expect(await dbItem(second.beer)).toMatchObject({
        category: 'Bebidas',
        categorySource: 'ai',
        categoryReview: { suggestion: { status: 'accepted' } },
      });
    });
  });

  it('F-23: o tempo de um PATCH com 500 itens novos, em três execuções no banco de e2e', async () => {
    const timings: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const { id } = await newDocument();
      const upsert = Array.from({ length: 500 }, (_, position) =>
        newItem({
          position,
          name: `PRODUTO ${position}`,
          category: 'Mercearia',
          ean: '7891000100103',
        }),
      );
      const started = Date.now();
      const response = await patch(id, savePayload(0, { items: { upsert } }));
      timings.push(Date.now() - started);
      expect(response.status).toBe(200);
      expect(data(response).items).toHaveLength(500);
      expect(await countItems(h.dataSource, id)).toBe(500);
    }
    process.stdout.write(`F-23 PATCH com 500 itens novos (ms): ${timings.join(', ')}\n`);
  });
});
