import type { DataSource, EntityManager } from 'typeorm';
import type { FlyerProItem } from '../entities/flyer-pro-item.entity';
import { itemRow, STATUS } from './flyer-pro-documents.service.testutil';
import { IMPORT_ID, importEntry } from '../testing/flyer-pro-imports.fixture';
import { makeImportsService } from './flyer-pro-imports.service.testutil';
import { FlyerProItemsService } from './flyer-pro-items.service';
import { FlyerProJobsService } from './flyer-pro-jobs.service';
import { SAVED_AT, saveBody, STAMP, storedDocument } from './flyer-pro-save.service.testutil';
import { FlyerProSaveService } from './flyer-pro-save.service';
import type { FlyerProSetupService } from './flyer-pro-setup.service';
import type { FlyerProTemplateSnapshotService } from './flyer-pro-template-snapshot.service';

const OTHER_DOCUMENT = 'd2';
const newItem = (n: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  position: n,
  name: `ITEM ${n}`,
  price: { kind: 'simple', cents: 699 },
  unit: 'kg',
  ...over,
});
const FOUR_ITEMS = [1, 2, 3, 4].map((n) => newItem(n, { importId: IMPORT_ID }));

/**
 * O salvar com o passo da importação e o ramo de itens de verdade, sobre um `manager` que guarda `flyer_pro_imports`
 * (id para encarte): prova que a importação do corpo, gravada antes, já vale para os itens novos na mesma transação.
 */
function makeStatefulSave(imports: Record<string, string> = {}, foreignItems: FlyerProItem[] = []) {
  const known = new Map(Object.entries(imports));
  const inserted: Array<{ sql: string; params: unknown[] }> = [];
  const manager = {
    findOne: jest.fn().mockResolvedValue(storedDocument({ revision: 12, lastMutationId: 'M0' })),
    find: jest.fn().mockResolvedValue(foreignItems),
    query: jest.fn((sql: string, params: unknown[] = []): Promise<unknown> => {
      if (sql.includes('clock_timestamp')) return Promise.resolve([{ stamp: STAMP }]);
      if (sql.startsWith('UPDATE "flyer_pro_documents"')) {
        return Promise.resolve([[{ updatedAt: SAVED_AT }], 1]);
      }
      if (sql.startsWith('INSERT INTO "flyer_pro_imports"')) {
        const [id, documentId] = params as string[];
        if (known.has(id)) return Promise.resolve([]);
        known.set(id, documentId);
        return Promise.resolve([{ id }]);
      }
      if (sql.startsWith('SELECT "documentId"')) {
        return Promise.resolve([{ documentId: known.get(params[0] as string) }]);
      }
      if (sql.startsWith('SELECT "id" FROM "flyer_pro_imports"')) {
        const [documentId, ids] = params as [string, string[]];
        return Promise.resolve(
          ids.filter((id) => known.get(id) === documentId).map((id) => ({ id })),
        );
      }
      if (sql.startsWith('DELETE')) return Promise.resolve([[], 0]);
      if (sql.startsWith('SELECT count')) return Promise.resolve([{ total: 4 }]);
      if (sql.startsWith('INSERT INTO "flyer_pro_items"')) inserted.push({ sql, params });
      return Promise.resolve([]);
    }),
  };
  const dataSource = { transaction: jest.fn((work: (m: unknown) => unknown) => work(manager)) };
  const service = new FlyerProSaveService(
    dataSource as unknown as DataSource,
    { apply: jest.fn().mockResolvedValue({}) } as unknown as FlyerProSetupService,
    { statusOf: jest.fn().mockResolvedValue(STATUS) } as unknown as FlyerProTemplateSnapshotService,
    new FlyerProItemsService(dataSource as unknown as DataSource),
    makeImportsService().service,
    { requestAfterSave: jest.fn(), replayAfterSave: jest.fn() } as unknown as FlyerProJobsService,
  );
  return {
    service,
    imports: known,
    inserted,
    manager: manager as unknown as EntityManager & typeof manager,
  };
}

const keepThisScreen = (over: Record<string, unknown> = {}) =>
  saveBody({
    expectedRevision: 12,
    items: { replaceAll: true, upsert: FOUR_ITEMS },
    ...over,
  });

describe('FlyerProSaveService.save: a importação e os itens na mesma transação', () => {
  it('"Manter a desta tela" com a importação pendente: grava a importação uma vez e os 4 itens novos ligam a ela', async () => {
    const { service, imports, inserted } = makeStatefulSave();

    const view = await service.save('ana', 'd1', keepThisScreen({ import: importEntry() }));

    expect(view).toMatchObject({ revision: 13, applied: true });
    expect([...imports]).toEqual([[IMPORT_ID, 'd1']]);
    const records = JSON.parse(inserted[0].params[0] as string);
    expect(records.map((r: { importId: string }) => r.importId)).toEqual(Array(4).fill(IMPORT_ID));
  });

  it('item novo com importação pendente fora do corpo: 422 IMPORT_UNKNOWN em cada um, e nada é gravado', async () => {
    const { service, imports, inserted, manager } = makeStatefulSave();

    await expect(service.save('ana', 'd1', keepThisScreen())).rejects.toMatchObject({
      response: {
        code: 'FLYER_PRO_ITEM_INVALID',
        issues: FOUR_ITEMS.map((item) => ({
          itemId: item.id,
          field: 'importId',
          code: 'IMPORT_UNKNOWN',
        })),
      },
    });

    expect(imports.size).toBe(0);
    expect(inserted).toEqual([]);
    expect(manager.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  });

  it('a importação já gravada neste encarte vale para itens de um PATCH sem import (importação anterior)', async () => {
    const { service, inserted } = makeStatefulSave({ [IMPORT_ID]: 'd1' });

    await service.save('ana', 'd1', keepThisScreen());

    expect(inserted).toHaveLength(1);
  });

  it('importação incoerente e item inválido no mesmo corpo: responde a da importação', async () => {
    const { service } = makeStatefulSave();
    const body = saveBody({
      expectedRevision: 12,
      import: importEntry({ acceptedCount: 0 }),
      items: { upsert: [newItem(1, { unit: 'un' })] },
    });

    await expect(service.save('ana', 'd1', body)).rejects.toMatchObject({
      response: { code: 'FLYER_PRO_IMPORT_INVALID' },
    });
  });

  it('importação de outro encarte e item de outro encarte no mesmo corpo: responde o conflito da importação', async () => {
    const foreign = itemRow({ id: FOUR_ITEMS[0].id, documentId: OTHER_DOCUMENT });
    const { service } = makeStatefulSave({ [IMPORT_ID]: OTHER_DOCUMENT }, [foreign]);

    await expect(
      service.save('ana', 'd1', keepThisScreen({ import: importEntry() })),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'FLYER_PRO_IMPORT_ID_CONFLICT', details: { importId: IMPORT_ID } },
    });
  });
});
