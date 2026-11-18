import { documentRow, itemRow, STATUS } from '../services/flyer-pro-documents.service.testutil';
import { toSaveView } from './flyer-pro-save.view';

const NO_FIELDS = { template: false, pageCount: false };

describe('toSaveView', () => {
  const document = documentRow({
    id: 'd1',
    revision: 38,
    pagesFrozen: true,
    updatedAt: new Date('2026-11-14T14:33:10.004Z'),
  });

  it('traz sempre id, revision, updatedAt, replayed, applied, pagesFrozen, items, deletedItemIds e linkWarnings', () => {
    expect(toSaveView({ document, replayed: false, applied: true, fields: NO_FIELDS })).toEqual({
      id: 'd1',
      revision: 38,
      updatedAt: '2026-11-14T14:33:10.004Z',
      replayed: false,
      applied: true,
      pagesFrozen: true,
      items: [],
      deletedItemIds: [],
      linkWarnings: [],
    });
  });

  it('passa os itens pela view do item (eanValid, datas em ISO) e os ids apagados como vieram', () => {
    const view = toSaveView({
      document,
      replayed: false,
      applied: true,
      items: [itemRow({ id: 'i1', ean: '7891000100103' })],
      deletedItemIds: ['i9'],
      fields: NO_FIELDS,
    });

    expect(view.items).toEqual([
      expect.objectContaining({ id: 'i1', eanValid: true, updatedAt: '2026-11-14T13:05:40.412Z' }),
    ]);
    expect(view.items[0]).not.toHaveProperty('documentId');
    expect(view.deletedItemIds).toEqual(['i9']);
  });

  it('com a troca de arte traz format, pageCount, templateSnapshot e templateStatus', () => {
    const view = toSaveView({
      document,
      replayed: false,
      applied: true,
      fields: { template: true, pageCount: true },
      templateStatus: STATUS,
    });

    expect(view).toMatchObject({
      format: '27x40',
      pageCount: 1,
      templateSnapshot: document.templateSnapshot,
      templateStatus: STATUS,
    });
  });

  it('só com setup.pageCount traz o pageCount e nada do template', () => {
    const view = toSaveView({
      document,
      replayed: false,
      applied: true,
      fields: { template: false, pageCount: true },
    });

    expect(view.pageCount).toBe(1);
    for (const field of ['format', 'templateSnapshot', 'templateStatus']) {
      expect(view).not.toHaveProperty(field);
    }
  });

  it('nada da entidade vaza: creationKey, deletedAt e as fatias não saem', () => {
    const view = toSaveView({ document, replayed: true, applied: true, fields: NO_FIELDS });

    for (const field of ['creationKey', 'deletedAt', 'frame', 'slices', 'lastMutationId']) {
      expect(view).not.toHaveProperty(field);
    }
  });
});
