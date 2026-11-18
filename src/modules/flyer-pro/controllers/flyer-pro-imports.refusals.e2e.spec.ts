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
import { insertDocumentWithItems } from '../testing/flyer-pro-documents.fixture';
import { importEntry, importsOf, insertImport } from '../testing/flyer-pro-imports.fixture';

/**
 * e2e das recusas do campo `import` do N4 (change 19-add-flyer-pro-imports-api) que dependem do SQL real ou do app
 * montado: o id de importação de outro encarte (leitura sem filtro de exclusão), a corrida do mesmo id em dois encartes
 * (a chave primária decide, nunca 500), o limite de 500 itens com o desfazer da linha da importação, o conjunto das
 * importações lido do banco e o `forbidNonWhitelisted` aninhado. Ordem das conferências e regras de valor: unitários (L-19).
 */
describeIfE2eDb('PATCH /v1/flyer-pro/documents/:id: importação recusada (e2e)', () => {
  const { h, url, clientA, newDocument, patch } = useDocumentsE2e({ scenes: false });
  const errorOf = (response: { body: unknown }) => envelope<unknown>(response).error;
  const importBody = (importId: string) =>
    savePayload(0, {
      import: importEntry({ id: importId }),
      items: { upsert: importedItemsPayload(importId, 4) },
    });
  const importCount = async (importId: string): Promise<number> =>
    (
      await h.dataSource.query(`SELECT count(*)::int AS n FROM flyer_pro_imports WHERE id = $1`, [
        importId,
      ])
    )[0].n;

  it('o id de uma importação de outro encarte, vivo ou excluído, é 409 e nada do corpo é gravado', async () => {
    const other = await newDocument();
    const importId = await insertImport(h.dataSource, other.id);
    const { id } = await newDocument();

    const alive = await patch(id, importBody(importId));
    await h.delete(`${url}/${other.id}`);
    const deleted = await patch(id, importBody(importId));

    for (const response of [alive, deleted]) {
      expect(response.status).toBe(409);
      expect(errorOf(response)).toMatchObject({
        code: 'FLYER_PRO_IMPORT_ID_CONFLICT',
        details: { importId },
      });
    }
    expect((await rowOf(h.dataSource, id))['revision']).toBe(0);
    expect(await countItems(h.dataSource, id)).toBe(0);
    expect(await importsOf(h.dataSource, id)).toEqual([]);
    expect(await importsOf(h.dataSource, other.id)).toHaveLength(1);
  });

  it('dois encartes com o mesmo import.id ao mesmo tempo: um 200, um 409, uma linha só e nada gravado no que perdeu', async () => {
    const [first, second] = [await newDocument(), await newDocument()];
    const importId = randomUUID();

    const responses = await Promise.all([
      patch(first.id, importBody(importId)),
      patch(second.id, importBody(importId)),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(errorOf(responses.find((response) => response.status === 409))).toMatchObject({
      code: 'FLYER_PRO_IMPORT_ID_CONFLICT',
    });
    expect(await importCount(importId)).toBe(1);
    const lost = responses[0].status === 409 ? first : second;
    expect((await rowOf(h.dataSource, lost.id))['revision']).toBe(0);
    expect(await countItems(h.dataSource, lost.id)).toBe(0);
  });

  it('importação que passaria de 500 itens: 422 FLYER_PRO_ITEM_LIMIT e a linha da importação também volta', async () => {
    const { id } = await insertDocumentWithItems(h.dataSource, { clientId: clientA() }, 498);
    const importId = randomUUID();

    const response = await patch(
      id,
      savePayload(0, {
        import: importEntry({ id: importId }),
        items: { upsert: importedItemsPayload(importId, 3, 498) },
      }),
    );

    expect(response.status).toBe(422);
    expect(errorOf(response)).toMatchObject({
      code: 'FLYER_PRO_ITEM_LIMIT',
      details: { max: 500, total: 501 },
    });
    expect(await importCount(importId)).toBe(0);
    expect(await countItems(h.dataSource, id)).toBe(498);
    expect((await rowOf(h.dataSource, id))['revision']).toBe(0);
  });

  it('item novo com o importId de uma importação de outro encarte: 422 IMPORT_UNKNOWN, lido do banco', async () => {
    const other = await newDocument();
    const importId = await insertImport(h.dataSource, other.id);
    const { id } = await newDocument();
    const [item] = importedItemsPayload(importId, 1);

    const response = await patch(id, savePayload(0, { items: { upsert: [item] } }));

    expect(response.status).toBe(422);
    expect(errorOf(response)).toMatchObject({
      code: 'FLYER_PRO_ITEM_INVALID',
      issues: [{ itemId: item.id, field: 'importId', code: 'IMPORT_UNKNOWN' }],
    });
    expect(await countItems(h.dataSource, id)).toBe(0);
  });

  it('campo desconhecido dentro de import (sheetName) é 400 pelo pipe global, e nada é gravado', async () => {
    const { id } = await newDocument();

    const response = await patch(
      id,
      savePayload(0, { import: { ...importEntry({ id: randomUUID() }), sheetName: 'Plan1' } }),
    );

    expect(response.status).toBe(400);
    expect(errorOf(response)).toMatchObject({ code: 'BAD_REQUEST' });
    expect(await importsOf(h.dataSource, id)).toEqual([]);
    expect((await rowOf(h.dataSource, id))['revision']).toBe(0);
  });
});
