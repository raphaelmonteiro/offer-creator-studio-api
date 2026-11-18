import { itemRow } from '../services/flyer-pro-documents.service.testutil';
import { FlyerProItemEntry } from './flyer-pro-item.types';
import { draftOf } from './flyer-pro-item-merge';
import { validateItem, validateItems } from './flyer-pro-item-rules';

const NO_IMPORTS: ReadonlySet<string> = new Set();
const ID = '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c11';
const PHOTO = {
  galleryImageId: '141da073-e2ab-4c8e-bb79-28e24074f743',
  imageUrl: 'http://localhost:3101/uploads/gallery/05a0bd80-d07b-46d5-906c-de9c9d95eabd.png',
  imageWidth: 900,
  imageHeight: 700,
  imageOrigin: 'picker',
};
const NEW_ITEM: FlyerProItemEntry = {
  id: ID,
  position: 0,
  name: 'ABACATE',
  price: { kind: 'simple', cents: 699 },
  unit: 'kg',
};

/** Os problemas de um item novo (o que o `entry` traz sobre os campos obrigatórios) ou de um existente. */
const issuesOfNew = (over: Partial<FlyerProItemEntry> = {}) =>
  validateItem(draftOf({ ...NEW_ITEM, ...over }, null, false), NO_IMPORTS);
const issuesOfExisting = (entry: Partial<FlyerProItemEntry>, stored = itemRow({ id: ID })) =>
  validateItem(draftOf({ id: ID, ...entry }, stored, false), NO_IMPORTS);
const codes = (issues: Array<{ code: string }>) => issues.map((issue) => issue.code);
const issue = (field: string, code: string) => ({ itemId: ID, field, code });

describe('validateItem: campos obrigatórios', () => {
  it('item novo completo não tem problema', () => {
    expect(issuesOfNew()).toEqual([]);
  });

  it.each(['position', 'name', 'price', 'unit'] as const)('item novo sem %s', (field) => {
    expect(issuesOfNew({ [field]: undefined })).toEqual([issue(field, 'REQUIRED_FIELD_MISSING')]);
  });

  it('item novo com um obrigatório nulo também falta', () => {
    expect(issuesOfNew({ price: null })).toEqual([issue('price', 'REQUIRED_FIELD_MISSING')]);
  });

  it('item existente com campo ausente não muda e não falta nada', () => {
    expect(issuesOfExisting({ name: 'ABACATE AVOCADO' })).toEqual([]);
    expect(issuesOfExisting({})).toEqual([]);
  });

  it('item existente com um obrigatório limpo para nulo falta', () => {
    expect(issuesOfExisting({ unit: null })).toEqual([issue('unit', 'REQUIRED_FIELD_MISSING')]);
  });

  it('com replaceAll toda entrada vem completa, mesmo de item existente', () => {
    const draft = draftOf({ id: ID, name: 'ABACATE' }, itemRow({ id: ID }), true);

    expect(validateItem(draft, NO_IMPORTS)).toEqual([
      issue('position', 'REQUIRED_FIELD_MISSING'),
      issue('price', 'REQUIRED_FIELD_MISSING'),
      issue('unit', 'REQUIRED_FIELD_MISSING'),
    ]);
  });

  it('com replaceAll a entrada completa passa, e o opcional ausente não falta', () => {
    expect(validateItem(draftOf(NEW_ITEM, itemRow({ id: ID }), true), NO_IMPORTS)).toEqual([]);
  });
});

describe('validateItem: nome, unidade, categoria e EAN', () => {
  it('nome de 1 a 120 caracteres, aparado; 121, vazio e só espaços são NAME_INVALID (422, não 400)', () => {
    expect(issuesOfNew({ name: 'x'.repeat(120) })).toEqual([]);
    expect(issuesOfNew({ name: ` ${'x'.repeat(120)} ` })).toEqual([]);
    for (const name of ['x'.repeat(121), '', '   ']) {
      expect(issuesOfNew({ name })).toEqual([issue('name', 'NAME_INVALID')]);
    }
  });

  it('nome da planilha de até 255; 256 é SOURCE_NAME_INVALID', () => {
    expect(issuesOfNew({ sourceName: 'x'.repeat(255) })).toEqual([]);
    expect(issuesOfNew({ sourceName: 'x'.repeat(256) })).toEqual([
      issue('sourceName', 'SOURCE_NAME_INVALID'),
    ]);
  });

  it('unidade só entre cada, kg, 100g, pct e bdj', () => {
    for (const unit of ['cada', 'kg', '100g', 'pct', 'bdj'])
      expect(issuesOfNew({ unit })).toEqual([]);
    for (const unit of ['un', 'cx']) {
      expect(issuesOfNew({ unit })).toEqual([issue('unit', 'UNIT_UNKNOWN')]);
    }
  });

  it('categoria: as 11 e nulo passam; "Sem categoria", "Açougue" e o rótulo com acento são CATEGORY_UNKNOWN', () => {
    const eleven = [
      'Hortifruti',
      'Carnes',
      'Frios e Laticinios',
      'Padaria',
      'Bebidas',
      'Mercearia',
      'Congelados',
      'Limpeza',
      'Higiene e Perfumaria',
      'Pet',
      'Bazar',
    ];
    for (const category of [...eleven, null]) expect(issuesOfNew({ category })).toEqual([]);
    for (const category of ['Sem categoria', 'Açougue', 'Frios e Laticínios']) {
      expect(issuesOfNew({ category })).toEqual([issue('category', 'CATEGORY_UNKNOWN')]);
    }
  });

  it('EAN com 8, 12, 13 ou 14 dígitos passa, mesmo com o dígito verificador errado', () => {
    for (const ean of [
      '78960046',
      '789100010010',
      '7891000100103',
      '7891000100104',
      '17891000100100',
    ]) {
      expect(issuesOfNew({ ean })).toEqual([]);
    }
    expect(issuesOfNew({ ean: null })).toEqual([]);
  });

  it('EAN com letras, tamanho errado ou 15 dígitos é EAN_FORMAT', () => {
    for (const ean of ['789ABC', '123456789', '', '123456789012345']) {
      expect(issuesOfNew({ ean })).toEqual([issue('ean', 'EAN_FORMAT')]);
    }
  });
});

describe('validateItem: preço', () => {
  it('traz o código da regra de preço no campo price', () => {
    expect(issuesOfNew({ price: { kind: 'from_to', cents: 4990, fromCents: 3990 } })).toEqual([
      issue('price', 'PRICE_FROM_NOT_GREATER'),
    ]);
    expect(issuesOfNew({ price: { kind: 'multi_buy', cents: 899, buy: 2, pay: 3 } })).toEqual([
      issue('price', 'PRICE_MULTI_BUY_INVALID'),
    ]);
    for (const price of [
      { kind: 'simple', cents: 0 },
      { kind: 'simple', cents: 10_000_000 },
      { kind: 'second_price', cents: 999 },
      { kind: 'second_price', cents: 999, secondCents: 899, secondLabel: 'Fidelidade' },
    ]) {
      expect(issuesOfNew({ price })).toEqual([issue('price', 'PRICE_INVALID')]);
    }
  });
});

describe('validateItem: foto e importação', () => {
  it('o grupo completo passa; a URL aceita http, https e /uploads/', () => {
    expect(issuesOfNew(PHOTO)).toEqual([]);
    expect(issuesOfNew({ ...PHOTO, imageUrl: 'https://cdn.example.com/a.png' })).toEqual([]);
    expect(issuesOfNew({ ...PHOTO, imageUrl: '/uploads/gallery/a.png' })).toEqual([]);
  });

  it('URL com data:, ftp:// ou 1 001 caracteres é IMAGE_URL_INVALID', () => {
    for (const imageUrl of [
      'data:image/png;base64,AAAA',
      'ftp://x/a.png',
      `http://${'a'.repeat(995)}`,
    ]) {
      expect(codes(issuesOfNew({ ...PHOTO, imageUrl }))).toEqual(['IMAGE_URL_INVALID']);
    }
    expect(issuesOfNew({ ...PHOTO, imageUrl: `http://${'a'.repeat(993)}` })).toEqual([]);
  });

  it('origem fora de match, suggestion, picker, upload e pixabay é IMAGE_ORIGIN_UNKNOWN', () => {
    for (const imageOrigin of ['match', 'suggestion', 'picker', 'upload', 'pixabay']) {
      expect(issuesOfNew({ ...PHOTO, imageOrigin })).toEqual([]);
    }
    expect(issuesOfNew({ ...PHOTO, imageOrigin: 'camera' })).toEqual([
      issue('imageOrigin', 'IMAGE_ORIGIN_UNKNOWN'),
    ]);
  });

  it('só a largura, ou a URL sem a imagem da Galeria, é IMAGE_GROUP_PARTIAL', () => {
    expect(codes(issuesOfExisting({ imageWidth: 900 }))).toEqual(['IMAGE_GROUP_PARTIAL']);
    expect(issuesOfNew({ ...PHOTO, galleryImageId: null })).toEqual([
      issue('galleryImageId', 'IMAGE_GROUP_PARTIAL'),
    ]);
    expect(issuesOfNew({ ...PHOTO, imageHeight: undefined })).toEqual([
      issue('imageHeight', 'IMAGE_GROUP_PARTIAL'),
    ]);
  });

  it('tirar a foto: os cinco nulos passam; nulos misturados com preenchidos não', () => {
    const none = {
      galleryImageId: null,
      imageUrl: null,
      imageWidth: null,
      imageHeight: null,
      imageOrigin: null,
    };
    expect(issuesOfExisting(none)).toEqual([]);
    expect(codes(issuesOfExisting({ ...none, imageOrigin: 'picker' }))).toEqual([
      'IMAGE_GROUP_PARTIAL',
    ]);
  });

  it('imported com até 2 KB passa; 3 KB é IMPORTED_TOO_LARGE', () => {
    const imported = (bytes: number) => ({
      v: 1,
      name: 'x'.repeat(bytes - '{"v":1,"name":""}'.length),
    });
    expect(issuesOfNew({ imported: imported(2048) })).toEqual([]);
    expect(issuesOfNew({ imported: imported(3072) })).toEqual([
      issue('imported', 'IMPORTED_TOO_LARGE'),
    ]);
  });
});

describe('validateItem: campos gravados só na criação', () => {
  const stored = itemRow({
    id: ID,
    sourceName: 'ABACATE',
    imported: { v: 1, row: 2, name: 'ABACATE' },
  });

  it('sourceName diferente do gravado é IMMUTABLE_FIELD; o mesmo valor é aceito', () => {
    expect(issuesOfExisting({ sourceName: 'ABACATE 2' }, stored)).toEqual([
      issue('sourceName', 'IMMUTABLE_FIELD'),
    ]);
    expect(issuesOfExisting({ sourceName: 'ABACATE' }, stored)).toEqual([]);
  });

  it('imported é comparado sem a ordem das chaves; diferente é IMMUTABLE_FIELD', () => {
    expect(issuesOfExisting({ imported: { name: 'ABACATE', row: 2, v: 1 } }, stored)).toEqual([]);
    expect(issuesOfExisting({ imported: { v: 1, row: 3, name: 'ABACATE' } }, stored)).toEqual([
      issue('imported', 'IMMUTABLE_FIELD'),
    ]);
    expect(issuesOfExisting({ imported: null }, stored)).toEqual([
      issue('imported', 'IMMUTABLE_FIELD'),
    ]);
  });

  it('em item novo os dois são gravados sem recusa', () => {
    expect(issuesOfNew({ sourceName: 'ABACATE', imported: { v: 1 } })).toEqual([]);
  });
});

describe('validateItem: decisões incompletas ou contraditórias (D-1 (a))', () => {
  it('aceitar a ortografia sem name é DECISION_INVALID; com name passa', () => {
    expect(issuesOfExisting({ spellDecision: 'accept' })).toEqual([
      issue('spellDecision', 'DECISION_INVALID'),
    ]);
    expect(issuesOfExisting({ spellDecision: 'accept', name: 'ABACATE' })).toEqual([]);
    expect(issuesOfExisting({ spellDecision: 'reject' })).toEqual([]);
  });

  it('motivo sem blocked é DECISION_INVALID; com blocked passa', () => {
    expect(
      issuesOfExisting({ categoryDecision: 'reject', categoryDecisionReason: 'outra página' }),
    ).toEqual([issue('categoryDecisionReason', 'DECISION_INVALID')]);
    expect(
      issuesOfExisting({ categoryDecision: 'blocked', categoryDecisionReason: 'outra página' }),
    ).toEqual([]);
  });

  it('aceitar a categoria sem mandar a categoria é DECISION_INVALID no campo categoryDecision', () => {
    expect(issuesOfExisting({ categoryDecision: 'accept' })).toEqual([
      issue('categoryDecision', 'DECISION_INVALID'),
    ]);
    expect(issuesOfExisting({ categoryDecision: 'accept', category: 'Bebidas' })).toEqual([]);
  });

  it('recusar as fotos junto com o grupo da foto é DECISION_INVALID; sozinho passa', () => {
    expect(issuesOfExisting({ imageDecision: 'reject', ...PHOTO })).toEqual([
      issue('imageDecision', 'DECISION_INVALID'),
    ]);
    expect(issuesOfExisting({ imageDecision: 'reject' })).toEqual([]);
  });
});

describe('validateItems: todos os problemas de todos os itens', () => {
  it('dois itens inválidos no mesmo corpo trazem os dois', () => {
    const drafts = [
      draftOf({ ...NEW_ITEM, id: 'a', unit: 'un' }, null, false),
      draftOf({ ...NEW_ITEM, id: 'b', category: 'Açougue' }, null, false),
    ];

    expect(validateItems(drafts, NO_IMPORTS)).toEqual([
      { itemId: 'a', field: 'unit', code: 'UNIT_UNKNOWN' },
      { itemId: 'b', field: 'category', code: 'CATEGORY_UNKNOWN' },
    ]);
  });

  it('vários problemas de um item juntos, em ordem: obrigatório, valor, foto, importação, decisão', () => {
    const draft = draftOf(
      {
        id: ID,
        position: 0,
        name: 'x'.repeat(121),
        unit: 'un',
        ean: '789ABC',
        imageWidth: 900,
        imported: { v: 1, name: 'x'.repeat(3000) },
        spellDecision: 'accept',
      },
      null,
      false,
    );

    expect(codes(validateItem(draft, NO_IMPORTS))).toEqual([
      'REQUIRED_FIELD_MISSING',
      'NAME_INVALID',
      'UNIT_UNKNOWN',
      'EAN_FORMAT',
      'IMAGE_GROUP_PARTIAL',
      'IMPORTED_TOO_LARGE',
    ]);
  });

  it('lista vazia não tem problema', () => {
    expect(validateItems([], NO_IMPORTS)).toEqual([]);
  });
});
