import { HttpException } from '@nestjs/common';
import { ItemIdPipe } from './flyer-pro-item-id.pipe';

const ARGUMENT = { type: 'param', data: 'itemId' } as const;

describe('ItemIdPipe', () => {
  it('UUID passa como veio', async () => {
    const id = '11111111-1111-4111-8111-111111111111';

    await expect(ItemIdPipe.transform(id, ARGUMENT)).resolves.toBe(id);
  });

  it.each(['abc', '', '123', '11111111-1111-4111-8111-11111111111'])(
    '%j não é UUID: 400 BAD_REQUEST',
    async (value) => {
      const error = (await ItemIdPipe.transform(value, ARGUMENT).catch(
        (e: unknown) => e,
      )) as HttpException;

      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toMatchObject({ code: 'BAD_REQUEST' });
    },
  );
});
