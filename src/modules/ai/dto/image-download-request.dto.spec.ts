import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ImageDownloadRequestDto } from './image-download-request.dto';

/** As propriedades recusadas, com as opções do pipe global (`whitelist` e `forbidNonWhitelisted`). */
async function refusedFields(over: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(ImageDownloadRequestDto, {
    imageUrl: 'https://pixabay.com/get/x.jpg',
    productName: 'Arroz Camil 5kg',
    ...over,
  });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((error) => error.property);
}

/**
 * O DTO da E3 (change 47, PV-24): a recusa de endereço que não é do Pixabay é do download, com HTTP 200 e
 * `IMAGE_DOWNLOAD_ERROR`, sem conexão; o DTO só deixa de fora o que hoje já fica de fora.
 */
describe('ImageDownloadRequestDto: o campo imageUrl', () => {
  it.each([
    ['https com domínio', 'https://pixabay.com/get/x.jpg'],
    ['sem esquema, como passa hoje', 'pixabay.com/x'],
    ['localhost com porta, que chega à recusa do download', 'http://localhost:3001/v1/health'],
    ['IP interno', 'http://169.254.169.254/latest/meta-data/'],
    ['só uma palavra, que `require_tld: false` deixa passar e o download recusa', 'abc'],
  ])('aceita endereço %s', async (_name, imageUrl) => {
    expect(await refusedFields({ imageUrl })).toEqual([]);
  });

  it.each([
    ['vazio', ''],
    ['com espaço', 'https://pixabay .com/x.jpg'],
    ['numérico', 123],
    ['nulo', null],
  ])('recusa endereço %s', async (_name, imageUrl) => {
    expect(await refusedFields({ imageUrl })).toEqual(['imageUrl']);
  });

  it('o resto do pedido segue como hoje: productName vazio e campo desconhecido continuam recusados', async () => {
    expect(await refusedFields({ productName: '' })).toEqual(['productName']);
    expect(await refusedFields({ outro: 1 })).toEqual(['outro']);
  });
});
