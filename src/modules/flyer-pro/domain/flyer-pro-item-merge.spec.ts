import { itemRow } from '../services/flyer-pro-documents.service.testutil';
import { mergeItem } from './flyer-pro-item-merge';

const ID = '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c11';

describe('mergeItem', () => {
  it('item novo parte dos padrões: opcionais nulos e o selo +18 desligado (PU-31)', () => {
    const merged = mergeItem({ id: ID, name: 'CERVEJA PILSEN GARRAFA 600ML' }, null);

    expect(merged).toMatchObject({
      name: 'CERVEJA PILSEN GARRAFA 600ML',
      category: null,
      ean: null,
      isAlcoholic: false,
      galleryImageId: null,
      imported: null,
    });
  });

  it('ausente não muda, null limpa e o valor enviado vale, sobre o item gravado', () => {
    const stored = itemRow({
      id: ID,
      name: 'ABACATE',
      ean: '7891000100103',
      category: 'Hortifruti',
    });

    const merged = mergeItem({ id: ID, ean: null, name: 'ABACATE AVOCADO' }, stored);

    expect(merged).toMatchObject({ name: 'ABACATE AVOCADO', ean: null, category: 'Hortifruti' });
    expect(merged.price).toBe(stored.price);
  });

  it('o nome é aparado', () => {
    expect(mergeItem({ id: ID, name: '  ABACATE  ' }, null).name).toBe('ABACATE');
  });

  it('isAlcoholic nulo no corpo vale como desligado: a coluna não aceita nulo', () => {
    expect(
      mergeItem({ id: ID, isAlcoholic: null }, itemRow({ id: ID, isAlcoholic: true })).isAlcoholic,
    ).toBe(false);
    expect(mergeItem({ id: ID, isAlcoholic: true }, null).isAlcoholic).toBe(true);
  });
});
