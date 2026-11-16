import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListFlyerProTemplatesQueryDto } from './list-flyer-pro-templates-query.dto';

const errorsOf = async (query: Record<string, unknown>) =>
  (await validate(plainToInstance(ListFlyerProTemplatesQueryDto, query))).map(
    (error) => error.property,
  );

describe('ListFlyerProTemplatesQueryDto', () => {
  it('sem nenhum campo é válida (todos são opcionais)', async () => {
    expect(await errorsOf({})).toEqual([]);
  });

  it('aceita os filtros e a página na forma certa (a query chega como texto)', async () => {
    expect(
      await errorsOf({
        format: '54x40',
        search: 'folheto 5',
        sceneId: '9eb30a72-aa45-41c1-9832-2733d6a39277',
        page: '2',
        limit: '50',
      }),
    ).toEqual([]);
  });

  it.each([
    ['format', '20x27'],
    ['format', ''],
    ['sceneId', 'abc'],
    ['search', 'x'.repeat(81)],
    ['page', '0'],
    ['page', 'abc'],
    ['page', '1.5'],
    ['limit', '0'],
    ['limit', '51'],
    ['limit', 'abc'],
  ])('rejeita %s=%p', async (field, value) => {
    expect(await errorsOf({ [field]: value })).toEqual([field]);
  });

  it('aceita search de 80 caracteres e de 1 caractere', async () => {
    expect(await errorsOf({ search: 'x'.repeat(80) })).toEqual([]);
    expect(await errorsOf({ search: 'x' })).toEqual([]);
  });
});
