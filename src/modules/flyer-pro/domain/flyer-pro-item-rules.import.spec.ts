import { itemRow } from '../services/flyer-pro-documents.service.testutil';
import { IMPORT_ID } from '../testing/flyer-pro-imports.fixture';
import { FlyerProItemEntry } from './flyer-pro-item.types';
import { draftOf } from './flyer-pro-item-merge';
import { importIdsOfNewItems, validateItem, validateItems } from './flyer-pro-item-rules';

const ID = '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c11';
const IMPORT_J = 'c4a19e07-2d85-4b3f-8a6e-1f9b0d7c3a52';
const FOREIGN = 'e2f7a8b1-6c3d-4e90-b5a4-0d1c2e3f4a5b';

const NEW_ITEM: FlyerProItemEntry = {
  id: ID,
  position: 0,
  name: 'ABACATE',
  price: { kind: 'simple', cents: 699 },
  unit: 'kg',
};
const known = (...ids: string[]): ReadonlySet<string> => new Set(ids);
const importIssue = (code: string) => ({ itemId: ID, field: 'importId', code });

const issuesOfNew = (over: Partial<FlyerProItemEntry>, imports: ReadonlySet<string>) =>
  validateItem(draftOf({ ...NEW_ITEM, ...over }, null, false), imports);
const issuesOfExisting = (
  entry: Partial<FlyerProItemEntry>,
  stored = itemRow({ id: ID, importId: IMPORT_ID }),
  replaceAll = false,
) => validateItem(draftOf({ id: ID, ...entry }, stored, replaceAll), known(IMPORT_ID, IMPORT_J));

describe('validateItem: item novo ligado a uma importação', () => {
  it('importId desconhecido dá IMPORT_UNKNOWN', () => {
    expect(issuesOfNew({ importId: IMPORT_ID }, known())).toEqual([importIssue('IMPORT_UNKNOWN')]);
  });

  it('importId de importação de outro encarte (fora do conjunto) dá IMPORT_UNKNOWN', () => {
    expect(issuesOfNew({ importId: FOREIGN }, known(IMPORT_ID))).toEqual([
      importIssue('IMPORT_UNKNOWN'),
    ]);
  });

  it('importId conhecido (a do corpo ou uma do encarte) não dá problema', () => {
    expect(issuesOfNew({ importId: IMPORT_ID }, known(IMPORT_ID))).toEqual([]);
  });

  it.each([undefined, null])(
    'importId %p é item incluído à mão e não depende do conjunto',
    (importId) => {
      expect(issuesOfNew({ importId }, known())).toEqual([]);
    },
  );
});

describe('validateItem: importId só na criação (item existente)', () => {
  it('outra importação do encarte dá IMMUTABLE_FIELD, sem conferir se ela existe', () => {
    expect(issuesOfExisting({ importId: IMPORT_J })).toEqual([importIssue('IMMUTABLE_FIELD')]);
    expect(
      validateItem(
        draftOf({ id: ID, importId: FOREIGN }, itemRow({ id: ID, importId: IMPORT_ID }), false),
        known(),
      ),
    ).toEqual([importIssue('IMMUTABLE_FIELD')]);
  });

  it('null sobre um valor dá IMMUTABLE_FIELD', () => {
    expect(issuesOfExisting({ importId: null })).toEqual([importIssue('IMMUTABLE_FIELD')]);
  });

  it('o mesmo valor e a ausência (inclusive com replaceAll) não dão problema', () => {
    expect(issuesOfExisting({ importId: IMPORT_ID })).toEqual([]);
    expect(issuesOfExisting({})).toEqual([]);
    expect(issuesOfExisting({ ...NEW_ITEM }, undefined, true)).toEqual([]);
  });

  it('item gravado sem importação aceita o nulo e recusa um valor', () => {
    const stored = itemRow({ id: ID, importId: null });
    expect(issuesOfExisting({ importId: null }, stored)).toEqual([]);
    expect(issuesOfExisting({ importId: IMPORT_ID }, stored)).toEqual([
      importIssue('IMMUTABLE_FIELD'),
    ]);
  });
});

describe('validateItems e importIdsOfNewItems', () => {
  it('os problemas de importId vêm junto com os de preço da 09, na ordem dos itens', () => {
    const drafts = [
      draftOf({ ...NEW_ITEM, importId: FOREIGN, price: { kind: 'simple', cents: 0 } }, null, false),
      draftOf(
        { id: 'outro', importId: IMPORT_J },
        itemRow({ id: 'outro', importId: IMPORT_ID }),
        false,
      ),
    ];

    expect(validateItems(drafts, known(IMPORT_ID))).toEqual([
      { itemId: ID, field: 'price', code: 'PRICE_INVALID' },
      importIssue('IMPORT_UNKNOWN'),
      { itemId: 'outro', field: 'importId', code: 'IMMUTABLE_FIELD' },
    ]);
  });

  it('só os ids de item novo com importação entram, sem repetir', () => {
    const drafts = [
      draftOf({ ...NEW_ITEM, id: 'a', importId: IMPORT_ID }, null, false),
      draftOf({ ...NEW_ITEM, id: 'b', importId: IMPORT_ID }, null, false),
      draftOf({ ...NEW_ITEM, id: 'c', importId: null }, null, false),
      draftOf({ ...NEW_ITEM, id: 'd' }, null, false),
      draftOf({ id: 'e', importId: IMPORT_J }, itemRow({ id: 'e', importId: IMPORT_J }), false),
    ];

    expect(importIdsOfNewItems(drafts)).toEqual([IMPORT_ID]);
    expect(importIdsOfNewItems([])).toEqual([]);
  });
});
