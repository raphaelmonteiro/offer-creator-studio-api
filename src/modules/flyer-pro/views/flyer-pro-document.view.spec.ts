import { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import { FlyerProItem } from '../entities/flyer-pro-item.entity';
import {
  FlyerProDocumentListRow,
  toDocumentView,
  toItemView,
  toListItemView,
} from './flyer-pro-document.view';
import {
  documentRow,
  itemRow,
  snapshotOf,
  STATUS,
} from '../services/flyer-pro-documents.service.testutil';

const SNAPSHOT = snapshotOf();
const CREATION_KEY = '5b1e0c3a-8f0e-4d7a-9a51-2f4c1d7e9b10';

const view = (over: Partial<FlyerProDocument> = {}, items: FlyerProItem[] = []) =>
  toDocumentView({
    document: documentRow({
      name: 'Ofertas',
      creationKey: CREATION_KEY,
      templateSnapshot: SNAPSHOT,
      ...over,
    }),
    items,
    itemsCursor: '2026-11-14T13:02:11.000000Z',
    templateStatus: STATUS,
  });

describe('toDocumentView', () => {
  it('traz exatamente as chaves da abertura e nenhuma de uso interno', () => {
    expect(Object.keys(view()).sort()).toEqual(
      [
        'id',
        'name',
        'clientId',
        'sceneId',
        'format',
        'pageCount',
        'pagesFrozen',
        'step',
        'ui',
        'schemaVersion',
        'engineVersion',
        'revision',
        'lastMutationId',
        'layoutDigest',
        'renderDigest',
        'layoutSnapshot',
        'templateSnapshot',
        'templateStatus',
        'slices',
        'items',
        'itemsCursor',
        'enrichment',
        'createdByUserId',
        'updatedByUserId',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    const keys = Object.keys(view());
    for (const absent of ['creationKey', 'deletedAt', 'replayed', 'client']) {
      expect(keys).not.toContain(absent);
    }
  });

  it('slices tem exatamente as cinco chaves, montadas das colunas', () => {
    const structure = { sections: [{ id: 'cat:Hortifruti', itemIds: ['i1'] }] };
    const { slices } = view({ structure });
    expect(Object.keys(slices).sort()).toEqual(
      ['assembly', 'card', 'exportPrefs', 'frame', 'structure'].sort(),
    );
    expect(slices.structure).toEqual(structure);
    expect(slices.frame).toEqual({});
  });

  it('devolve os valores gravados sem mudança, jsonb inclusive', () => {
    const gravado = view({
      step: 'assembly',
      pagesFrozen: true,
      revision: 37,
      lastMutationId: 'm1',
      ui: { assemblyZoom: 2, inspectorTab: 'card' },
      layoutSnapshot: { engineVersion: 1, level: 2 },
      layoutDigest: 'a41b',
      renderDigest: 'f3a9',
    });
    expect(gravado).toMatchObject({
      step: 'assembly',
      pagesFrozen: true,
      revision: 37,
      lastMutationId: 'm1',
      ui: { assemblyZoom: 2, inspectorTab: 'card' },
      layoutSnapshot: { engineVersion: 1, level: 2 },
      layoutDigest: 'a41b',
      renderDigest: 'f3a9',
    });
    expect(gravado.templateSnapshot).toBe(SNAPSHOT);
  });

  it('enrichment é nulo, o cursor vem como recebido e as datas saem em ISO UTC', () => {
    const result = view();
    expect(result.enrichment).toBeNull();
    expect(result.itemsCursor).toBe('2026-11-14T13:02:11.000000Z');
    expect(result.createdAt).toBe('2026-11-14T13:02:11.000Z');
    expect(result.updatedAt).toBe('2026-11-14T13:02:11.000Z');
    expect(result.templateStatus).toBe(STATUS);
  });

  it('trata nulo e ausência: colunas faltando viram nulo ou vazio', () => {
    const sparse = view({
      lastMutationId: undefined,
      layoutDigest: undefined,
      renderDigest: undefined,
      layoutSnapshot: undefined,
      createdByUserId: undefined,
      updatedByUserId: undefined,
      ui: undefined,
      frame: undefined,
      card: undefined,
    });
    expect(sparse).toMatchObject({
      lastMutationId: null,
      layoutDigest: null,
      renderDigest: null,
      layoutSnapshot: null,
      createdByUserId: null,
      updatedByUserId: null,
      ui: {},
    });
    expect(sparse.slices.frame).toEqual({});
    expect(sparse.slices.card).toEqual({});
  });
});

describe('toItemView', () => {
  it('traz as colunas do item, menos documentId, mais eanValid e importId nulo', () => {
    const result = toItemView(itemRow());
    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'position',
        'name',
        'sourceName',
        'price',
        'unit',
        'category',
        'categorySource',
        'categoryReview',
        'isAlcoholic',
        'ean',
        'eanValid',
        'galleryImageId',
        'imageUrl',
        'imageWidth',
        'imageHeight',
        'imageOrigin',
        'imageStatus',
        'imageReview',
        'spellReview',
        'imported',
        'importId',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(result).not.toHaveProperty('documentId');
    expect(result.importId).toBeNull();
  });

  it.each([
    ['7891000100103', true],
    ['7891000100104', false],
    ['78960046', true],
    [null, null],
    [undefined, null],
  ])('eanValid de %s é %s', (ean, expected) => {
    expect(toItemView(itemRow({ ean: ean as string | null })).eanValid).toBe(expected);
  });

  it('devolve price, imported e as revisões como gravados', () => {
    const price = { kind: 'from_to', cents: 599, fromCents: 799 };
    const imported = { v: 1, row: 2, name: 'ABACATE' };
    const imageReview = { checkedAt: 'x', suggestion: null };
    const spellReview = { checkedName: 'ABACATE', suggestion: null };
    const result = toItemView(itemRow({ price, imported, imageReview, spellReview }));
    expect(result).toMatchObject({ price, imported, imageReview, spellReview });
  });

  it('trata campos ausentes como nulos e datas em ISO', () => {
    const result = toItemView(itemRow({ sourceName: undefined, imageUrl: undefined }));
    expect(result.sourceName).toBeNull();
    expect(result.imageUrl).toBeNull();
    expect(result.updatedAt).toBe('2026-11-14T13:05:40.412Z');
  });
});

describe('toListItemView', () => {
  const row: FlyerProDocumentListRow = {
    id: 'd1',
    name: 'Ofertas',
    clientId: 'c1',
    clientName: 'Piccin Supermercado',
    format: '27x40',
    pageCount: 2,
    step: 'assembly',
    itemCount: 78,
    revision: 37,
    updatedByUserId: 'u1',
    updatedByName: 'Ana',
    createdAt: new Date('2026-11-14T13:02:11.000Z'),
    updatedAt: new Date('2026-11-14T14:32:05.000Z'),
  };

  it('traz os campos da lista e nenhum de fatia, item, ui, cópia, chave ou exclusão', () => {
    const result = toListItemView(row);
    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'name',
        'clientId',
        'clientName',
        'format',
        'pageCount',
        'step',
        'itemCount',
        'revision',
        'updatedByUserId',
        'updatedByName',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(result.createdAt).toBe('2026-11-14T13:02:11.000Z');
    expect(result.updatedAt).toBe('2026-11-14T14:32:05.000Z');
    expect(result.itemCount).toBe(78);
  });

  it('autor que não existe mais vem com updatedByName nulo', () => {
    const result = toListItemView({ ...row, updatedByName: undefined, updatedByUserId: undefined });
    expect(result.updatedByName).toBeNull();
    expect(result.updatedByUserId).toBeNull();
  });
});
