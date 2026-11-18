import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SaveFlyerProDocumentDto } from './save-flyer-pro-document.dto';

const ID = '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c11';
const BASE = { mutationId: ID, expectedRevision: 0, schemaVersion: 1, engineVersion: 1 };

/** As propriedades recusadas pelo mesmo `whitelist` e `forbidNonWhitelisted` do pipe global (aninhadas: só a raiz). */
async function errorsOf(items: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(SaveFlyerProDocumentDto, { ...BASE, items });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((error) => error.property);
}
const upsertOf = (item: Record<string, unknown>) => errorsOf({ upsert: [{ id: ID, ...item }] });

describe('FlyerProItemPatchDto (só a forma, 400)', () => {
  it('aceita só o id e o item completo com os campos nulos onde a coluna aceita', async () => {
    expect(await upsertOf({})).toEqual([]);
    expect(
      await upsertOf({
        position: 0,
        name: 'ABACATE',
        sourceName: null,
        price: { kind: 'simple', cents: 699 },
        unit: 'kg',
        category: null,
        isAlcoholic: false,
        ean: null,
        galleryImageId: null,
        imageUrl: null,
        imageWidth: null,
        imageHeight: null,
        imageOrigin: null,
        imported: null,
        categoryDecision: 'accept',
        categoryDecisionReason: 'x',
        imageDecision: 'reject',
        spellDecision: 'accept',
      }),
    ).toEqual([]);
  });

  it.each([
    ['position', 'zero'],
    ['position', -1],
    ['position', 2147483648],
    ['isAlcoholic', 'sim'],
    ['price', 'R$ 6,99'],
    ['price', [1]],
    ['imageWidth', 0],
    ['imageHeight', 2147483648],
    ['galleryImageId', 'abc'],
    ['categoryDecision', 'maybe'],
    ['imageDecision', 'accept'],
    ['spellDecision', 'blocked'],
    ['categoryDecisionReason', 'x'.repeat(121)],
    ['imported', 'texto'],
  ])('recusa %s=%p', async (field, value) => {
    expect(await upsertOf({ [field]: value })).toEqual(['items']);
  });

  it('o id é obrigatório e precisa ser uuid', async () => {
    expect(await errorsOf({ upsert: [{ name: 'ABACATE' }] })).toEqual(['items']);
    expect(await errorsOf({ upsert: [{ id: 'abc' }] })).toEqual(['items']);
  });

  it.each([
    'categorySource',
    'imageStatus',
    'categoryReview',
    'imageReview',
    'spellReview',
    'importId',
  ])('o campo do servidor %s no corpo é recusado', async (field) => {
    expect(await upsertOf({ [field]: 'user' })).toEqual(['items']);
  });

  it('upsert e delete aceitam 500 entradas e recusam 501; item que não é objeto é recusado', async () => {
    const upsertOf500 = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      }));
    expect(await errorsOf({ upsert: upsertOf500(500) })).toEqual([]);
    expect(await errorsOf({ upsert: upsertOf500(501) })).toEqual(['items']);
    expect(await errorsOf({ delete: upsertOf500(501).map((item) => item.id) })).toEqual(['items']);
    expect(await errorsOf({ upsert: ['x'] })).toEqual(['items']);
  });

  it('delete exige uuid em cada id, e replaceAll é booleano', async () => {
    expect(await errorsOf({ delete: [ID] })).toEqual([]);
    expect(await errorsOf({ delete: ['abc'] })).toEqual(['items']);
    expect(await errorsOf({ replaceAll: true, upsert: [] })).toEqual([]);
    expect(await errorsOf({ replaceAll: 'sim' })).toEqual(['items']);
  });

  it('chave desconhecida no items é recusada', async () => {
    expect(await errorsOf({ foo: 1 })).toEqual(['items']);
  });
});
