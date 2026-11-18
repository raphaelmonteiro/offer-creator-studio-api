import { randomUUID } from 'crypto';
import { describeIfE2eDb } from '../../../shared/testing/e2e-test-db';
import {
  countItems,
  envelope,
  importedItemsPayload,
  rowOf,
  savePayload,
  useDocumentsE2e,
} from '../testing/flyer-pro-documents.e2e.testutil';
import { importEntry, importsOf } from '../testing/flyer-pro-imports.fixture';
import type { FlyerProImportView } from '../views/flyer-pro-import.view';
import type { FlyerProItemView } from '../views/flyer-pro-document.view';
import type { FlyerProSaveView } from '../views/flyer-pro-save.view';

/**
 * e2e do campo `import` do N4 (change 19-add-flyer-pro-imports-api) sobre o harness da 05, só o fluxo base e o que depende
 * do SQL real: a gravação do registro na transação dos itens, o reenvio, o "Substituir" com as páginas congeladas pelo
 * cursor e a medição de uma importação de 500 itens. As recusas (409, corrida, limite) estão em
 * `flyer-pro-imports.refusals.e2e.spec.ts` e o histórico em `flyer-pro-imports.history.e2e.spec.ts`; a forma e as
 * contagens, nos unitários (L-19).
 */
describeIfE2eDb('PATCH /v1/flyer-pro/documents/:id: importação (e2e)', () => {
  const { h, url, newDocument, open, patch, put } = useDocumentsE2e({ scenes: false });
  const data = (response: { body: unknown }) => envelope<FlyerProSaveView>(response).data;
  const importIds = (items: FlyerProItemView[]) => items.map((item) => item.importId);

  it('importar a lista do Piccin e reabrir: a gravação, a abertura, os itens e o histórico trazem os mesmos dados', async () => {
    const { id } = await newDocument();
    const entry = importEntry({ id: randomUUID() });

    const response = await patch(
      id,
      savePayload(0, { import: entry, items: { upsert: importedItemsPayload(entry.id, 4) } }),
    );

    expect(response.status).toBe(200);
    const saved = data(response);
    expect(saved).toMatchObject({ revision: 1, applied: true, pagesFrozen: false });
    expect(importIds(saved.items)).toEqual(Array(4).fill(entry.id));
    expect(await importsOf(h.dataSource, id)).toEqual([
      expect.objectContaining({
        ...entry,
        documentId: id,
        createdByUserId: h.seed.user.id,
        createdAt: expect.any(Date),
      }),
    ]);
    const read = envelope<{ items: FlyerProItemView[] }>(await h.get(`${url}/${id}/items`)).data;
    const history = envelope<FlyerProImportView[]>(await h.get(`${url}/${id}/imports`));
    const names = ['PRODUTO 0', 'PRODUTO 1', 'PRODUTO 2', 'PRODUTO 3'];
    for (const items of [(await open(id)).items, read.items]) {
      expect(items.map((item) => item.name)).toEqual(names);
      expect(importIds(items)).toEqual(Array(4).fill(entry.id));
    }
    expect(history.data).toEqual([
      expect.objectContaining({
        ...entry,
        documentId: id,
        rejectedCount: 1,
        createdByUserId: h.seed.user.id,
        createdByName: h.seed.user.name,
      }),
    ]);
  });

  it('o mesmo corpo de novo é replayed; a mesma importação em outra gravação não duplica, não muda o registro nem descongela', async () => {
    const { id } = await newDocument();
    const entry = importEntry({ id: randomUUID() });
    const first = savePayload(0, {
      import: entry,
      items: { upsert: importedItemsPayload(entry.id, 4) },
    });
    await patch(id, first);

    const again = data(await patch(id, first));
    await put(`${id}/cursor`, { step: 'assembly' });
    const other = data(
      await patch(
        id,
        savePayload(1, { import: { ...entry, mode: 'replace', fileName: 'outra.csv' } }),
      ),
    );

    expect(again).toMatchObject({ replayed: true, applied: true, revision: 1 });
    expect(other).toMatchObject({ replayed: false, revision: 2, pagesFrozen: true });
    expect(await importsOf(h.dataSource, id)).toEqual([
      expect.objectContaining({ id: entry.id, fileName: 'lista-piccin.csv', mode: 'append' }),
    ]);
    expect(await countItems(h.dataSource, id)).toBe(4);
    expect((await rowOf(h.dataSource, id))['pagesFrozen']).toBe(true);
  });

  it('"Substituir" com as páginas congeladas as descongela e o registro dos itens apagados fica; "Acrescentar" não muda a coluna', async () => {
    const { id } = await newDocument();
    const first = importEntry({ id: randomUUID() });
    const created = data(
      await patch(
        id,
        savePayload(0, { import: first, items: { upsert: importedItemsPayload(first.id, 4) } }),
      ),
    );
    await put(`${id}/cursor`, { step: 'assembly' });
    const second = importEntry({
      id: randomUUID(),
      fileName: 'lista-piccin-v2.xlsx',
      fileKind: 'xlsx',
      fileHash: '7a1b2c3d4e5f6071',
      mode: 'replace',
      acceptedCount: 5,
      rejected: [],
    });
    const oldIds = created.items.map((item) => item.id);

    const replaced = data(
      await patch(
        id,
        savePayload(1, {
          import: second,
          items: { delete: oldIds, upsert: importedItemsPayload(second.id, 5, 10) },
        }),
      ),
    );

    expect(replaced).toMatchObject({ revision: 2, pagesFrozen: false });
    expect(replaced.deletedItemIds.sort()).toEqual([...oldIds].sort());
    expect(importIds(replaced.items)).toEqual(Array(5).fill(second.id));
    expect((await rowOf(h.dataSource, id))['pagesFrozen']).toBe(false);
    const history = envelope<FlyerProImportView[]>(await h.get(`${url}/${id}/imports`)).data;
    expect(history.map((entry) => entry.fileName)).toEqual([
      'lista-piccin-v2.xlsx',
      'lista-piccin.csv',
    ]);

    const frozen = await newDocument();
    await put(`${frozen.id}/cursor`, { step: 'assembly' });
    const appended = data(
      await patch(
        frozen.id,
        savePayload(0, {
          import: importEntry({ id: randomUUID() }),
          items: { upsert: [] },
        }),
      ),
    );
    expect(appended.pagesFrozen).toBe(true);
    expect((await rowOf(h.dataSource, frozen.id))['pagesFrozen']).toBe(true);
  });

  it('A-12: o tempo de um PATCH com import e 500 itens novos, em três execuções no banco de e2e', async () => {
    const timings: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const { id } = await newDocument();
      const entry = importEntry({
        id: randomUUID(),
        rowCount: 500,
        acceptedCount: 500,
        rejected: [],
      });
      const upsert = importedItemsPayload(entry.id, 500).map((item) => ({
        ...item,
        category: 'Mercearia',
        ean: '7891000100103',
      }));
      const started = Date.now();
      const response = await patch(id, savePayload(0, { import: entry, items: { upsert } }));
      timings.push(Date.now() - started);
      expect(response.status).toBe(200);
      expect(data(response).items).toHaveLength(500);
      expect(await countItems(h.dataSource, id)).toBe(500);
      expect(await importsOf(h.dataSource, id)).toHaveLength(1);
    }
    process.stdout.write(`A-12 PATCH com import e 500 itens novos (ms): ${timings.join(', ')}\n`);
  });
});
