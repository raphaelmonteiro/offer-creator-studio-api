import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListFlyerProItemsQueryDto } from './list-items-query.dto';

async function errorsOf(query: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(ListFlyerProItemsQueryDto, query);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((error) => error.property);
}

describe('ListFlyerProItemsQueryDto', () => {
  it('aceita a consulta sem updatedAt e o cursor com microssegundos, com ou sem fuso', async () => {
    expect(await errorsOf({})).toEqual([]);
    for (const updatedAfter of [
      '2026-11-14T13:05:40.412377Z',
      '2026-11-14T13:05:40Z',
      '2026-11-14T13:05:40.412377',
      '2026-11-14T13:05:40-03:00',
      '2026-11-14',
    ]) {
      expect(await errorsOf({ updatedAfter })).toEqual([]);
    }
  });

  it.each(['ontem', '', '2026-13-40T00:00:00Z', '2026-02-30', '20261114T130540Z', '1731589540'])(
    'recusa updatedAfter=%p',
    async (updatedAfter) => {
      expect(await errorsOf({ updatedAfter })).toEqual(['updatedAfter']);
    },
  );

  it('parâmetro desconhecido é recusado', async () => {
    expect(await errorsOf({ foo: 1 })).toEqual(['foo']);
  });
});
