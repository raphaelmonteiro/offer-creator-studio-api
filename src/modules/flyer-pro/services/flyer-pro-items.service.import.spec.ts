import { itemRow } from './flyer-pro-documents.service.testutil';
import { IMPORT_ID } from '../testing/flyer-pro-imports.fixture';
import {
  ABACATE,
  CERVEJA,
  DOCUMENT,
  makeItemsManager,
  NEW_ABACATE,
  recordsOf,
  run,
  statementsOf,
  statementsStartingWith,
} from './flyer-pro-items.service.testutil';
import { STAMP } from './flyer-pro-save.service.testutil';

const IMPORT_J = 'c4a19e07-2d85-4b3f-8a6e-1f9b0d7c3a52';

/** Os comandos que leem as importações, na ordem. */
const importReads = (manager: ReturnType<typeof makeItemsManager>) =>
  statementsOf(manager).filter((statement) => statement.sql.includes('"flyer_pro_imports"'));

describe('FlyerProItemsService.apply: importId do item', () => {
  it('item novo ligado a uma importação do encarte: lê as importações uma vez e grava o importId no INSERT', async () => {
    const manager = makeItemsManager({ imports: [IMPORT_ID] });

    await run(manager, {
      upsert: [
        { ...NEW_ABACATE, importId: IMPORT_ID },
        { ...NEW_ABACATE, id: CERVEJA, position: 1, importId: IMPORT_ID },
      ],
    });

    expect(importReads(manager)).toEqual([
      { sql: expect.stringContaining(`"documentId" = $1`), params: [DOCUMENT, [IMPORT_ID]] },
    ]);
    const [insert] = statementsStartingWith(manager, 'INSERT');
    expect(insert.sql).toContain('"importId"');
    expect(recordsOf(insert).map((record) => record.importId)).toEqual([IMPORT_ID, IMPORT_ID]);
  });

  it('item novo sem importId (ausente ou nulo) é item à mão: importId nulo e nenhuma leitura das importações', async () => {
    const manager = makeItemsManager();

    await run(manager, {
      upsert: [NEW_ABACATE, { ...NEW_ABACATE, id: CERVEJA, position: 1, importId: null }],
    });

    expect(importReads(manager)).toEqual([]);
    const [insert] = statementsStartingWith(manager, 'INSERT');
    expect(recordsOf(insert).map((record) => record.importId)).toEqual([null, null]);
  });

  it('importId fora do conjunto (de outro encarte ou inexistente): 422 IMPORT_UNKNOWN e nada gravado', async () => {
    const manager = makeItemsManager({ imports: [] });

    await expect(
      run(manager, { upsert: [{ ...NEW_ABACATE, importId: IMPORT_J }] }),
    ).rejects.toMatchObject({
      response: {
        code: 'FLYER_PRO_ITEM_INVALID',
        issues: [{ itemId: ABACATE, field: 'importId', code: 'IMPORT_UNKNOWN' }],
      },
    });
    expect(statementsStartingWith(manager, 'INSERT')).toEqual([]);
  });

  it('item existente: o UPDATE não leva importId, nem com o mesmo valor, e a leitura das importações não é feita', async () => {
    const stored = itemRow({ id: ABACATE, importId: IMPORT_ID });
    const manager = makeItemsManager({ found: [[stored], [stored]] });

    await run(manager, { upsert: [{ id: ABACATE, importId: IMPORT_ID, name: 'ABACATE AVOCADO' }] });

    const [update] = statementsStartingWith(manager, 'UPDATE');
    expect(update.sql).not.toContain('importId');
    expect(recordsOf(update)[0]).not.toHaveProperty('importId');
    expect(importReads(manager)).toEqual([]);
  });

  it('item existente com outra importação ou com nulo: 422 IMMUTABLE_FIELD, sem conferir se a importação existe', async () => {
    const stored = itemRow({ id: ABACATE, importId: IMPORT_ID });
    const manager = makeItemsManager({ found: [[stored], [stored]] });

    await expect(
      run(manager, { upsert: [{ id: ABACATE, importId: IMPORT_J }] }),
    ).rejects.toMatchObject({
      response: { issues: [{ itemId: ABACATE, field: 'importId', code: 'IMMUTABLE_FIELD' }] },
    });
    await expect(
      run(makeItemsManager({ found: [[stored]] }), { upsert: [{ id: ABACATE, importId: null }] }),
    ).rejects.toMatchObject({
      response: { issues: [{ field: 'importId', code: 'IMMUTABLE_FIELD' }] },
    });
    expect(importReads(manager)).toEqual([]);
  });

  it('replaceAll com o item completo e sem importId mantém o gravado (o UPDATE não o escreve)', async () => {
    const stored = itemRow({ id: ABACATE, importId: IMPORT_ID });
    const manager = makeItemsManager({ found: [[stored], [stored]], deleted: [[]] });

    await run(manager, { replaceAll: true, upsert: [NEW_ABACATE] });

    const [update] = statementsStartingWith(manager, 'UPDATE');
    expect(update.sql).not.toContain('importId');
    expect(statementsStartingWith(manager, 'INSERT')).toEqual([]);
  });

  it('o carimbo do INSERT continua o da gravação', async () => {
    const manager = makeItemsManager({ imports: [IMPORT_ID] });

    await run(manager, { upsert: [{ ...NEW_ABACATE, importId: IMPORT_ID }] });

    expect(statementsStartingWith(manager, 'INSERT')[0].params[1]).toBe(STAMP);
  });
});
