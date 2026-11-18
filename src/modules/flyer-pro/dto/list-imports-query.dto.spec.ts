import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListFlyerProImportsQueryDto } from './list-imports-query.dto';

/** As propriedades recusadas, com o mesmo `transform`, `whitelist` e `forbidNonWhitelisted` do pipe global. */
async function errorsOf(query: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(ListFlyerProImportsQueryDto, query);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((error) => error.property);
}

describe('ListFlyerProImportsQueryDto (N13)', () => {
  it('aceita a consulta vazia, page, limit nos extremos e fileHash de 1 a 64 caracteres', async () => {
    expect(await errorsOf({})).toEqual([]);
    expect(await errorsOf({ page: '2', limit: '50' })).toEqual([]);
    expect(await errorsOf({ limit: '1', fileHash: 'x' })).toEqual([]);
    expect(await errorsOf({ fileHash: 'x'.repeat(64) })).toEqual([]);
  });

  it.each([
    ['limit', '51'],
    ['limit', '0'],
    ['limit', 'muitos'],
    ['page', '0'],
    ['page', '1.5'],
    ['fileHash', ''],
    ['fileHash', 'x'.repeat(65)],
  ])('recusa %s=%p', async (field, value) => {
    expect(await errorsOf({ [field]: value })).toEqual([field]);
  });

  it('parâmetro desconhecido é recusado, inclusive search (o histórico não tem busca por nome)', async () => {
    expect(await errorsOf({ foo: '1' })).toEqual(['foo']);
    expect(await errorsOf({ search: 'abacate' })).toEqual(['search']);
  });
});
