import { nestedErrorsOf } from './dto-paths.testutil';
import { ListFlyerProExportsQueryDto } from './list-exports-query.dto';

/** As propriedades recusadas da consulta (sem aninhamento, os caminhos são os nomes). */
const errorsOf = (query: Record<string, unknown>) =>
  nestedErrorsOf(ListFlyerProExportsQueryDto, query);

describe('ListFlyerProExportsQueryDto (N9)', () => {
  it('aceita a consulta vazia e page e limit nos extremos', async () => {
    expect(await errorsOf({})).toEqual([]);
    expect(await errorsOf({ page: '2', limit: '50' })).toEqual([]);
    expect(await errorsOf({ page: '1', limit: '1' })).toEqual([]);
  });

  it.each([
    ['limit', '51'],
    ['limit', '0'],
    ['limit', 'muitos'],
    ['page', '0'],
    ['page', 'abc'],
    ['page', '1.5'],
  ])('recusa %s=%p', async (field, value) => {
    expect(await errorsOf({ [field]: value })).toEqual([field]);
  });

  it('parâmetro desconhecido é recusado, inclusive search (o histórico não tem busca por nome)', async () => {
    expect(await errorsOf({ foo: '1' })).toEqual(['foo']);
    expect(await errorsOf({ search: 'abacate' })).toEqual(['search']);
  });
});
