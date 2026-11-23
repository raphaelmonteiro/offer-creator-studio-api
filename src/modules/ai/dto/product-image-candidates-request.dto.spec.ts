import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ProductImageCandidatesRequestDto } from './product-image-candidates-request.dto';

/** As propriedades recusadas, com as opções do pipe global (`whitelist` e `forbidNonWhitelisted`). */
async function refusedFields(over: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(ProductImageCandidatesRequestDto, {
    productName: 'ABACATE',
    ...over,
  });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((error) => error.property);
}

describe('ProductImageCandidatesRequestDto: o campo ean (change 27)', () => {
  it.each([
    ['ausente', {}],
    ['null', { ean: null }],
    ['texto vazio', { ean: '' }],
    ['EAN de 13 dígitos', { ean: '7896000000019' }],
    ['EAN com dígito errado (a forma não confere o dígito)', { ean: '7896000000018' }],
    ['texto de 32 caracteres', { ean: '1'.repeat(32) }],
  ])('aceita ean %s', async (_name, over) => {
    expect(await refusedFields(over)).toEqual([]);
  });

  it.each([
    ['de 40 caracteres', { ean: '1'.repeat(40) }],
    ['de 33 caracteres', { ean: '1'.repeat(33) }],
    ['numérico', { ean: 7896000000019 }],
    ['booleano', { ean: true }],
    ['lista', { ean: ['7896000000019'] }],
  ])('recusa ean %s', async (_name, over) => {
    expect(await refusedFields(over)).toEqual(['ean']);
  });

  it('o resto do pedido segue como hoje: limit 49 e productName vazio continuam recusados', async () => {
    expect(await refusedFields({ limit: 49 })).toEqual(['limit']);
    expect(await refusedFields({ productName: '' })).toEqual(['productName']);
  });
});
