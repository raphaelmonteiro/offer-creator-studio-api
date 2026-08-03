import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QueryGalleryDto } from './query-gallery.dto';

/**
 * `clientId` é comparado com a coluna uuid `client_id` no filtro da galeria.
 * Sem validação, um valor malformado chega ao Postgres e vira 500
 * ("invalid input syntax for type uuid") em vez de um 400 legível.
 */
describe('QueryGalleryDto — clientId', () => {
  async function errorsFor(clientId?: string) {
    const dto = plainToInstance(QueryGalleryDto, { clientId });
    const errors = await validate(dto);
    return errors.filter((e) => e.property === 'clientId');
  }

  it('aceita um UUID', async () => {
    expect(await errorsFor('3f2a1c9e-1234-4d5e-8a9b-0c1d2e3f4a5b')).toHaveLength(0);
  });

  it('aceita o literal "none"', async () => {
    expect(await errorsFor('none')).toHaveLength(0);
  });

  it('aceita omissão (sem filtro)', async () => {
    expect(await errorsFor(undefined)).toHaveLength(0);
  });

  it('rejeita string arbitrária', async () => {
    expect(await errorsFor('abc')).not.toHaveLength(0);
  });

  it('rejeita tentativa de injeção', async () => {
    expect(await errorsFor("' OR 1=1--")).not.toHaveLength(0);
  });

  it('rejeita UUID truncado', async () => {
    expect(await errorsFor('3f2a1c9e-1234-4d5e-8a9b')).not.toHaveLength(0);
  });
});
