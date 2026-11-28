import { nestedErrorsOf } from './dto-paths.testutil';
import { PhotoDownloadDto } from './flyer-pro-photo-download.dto';

const errorsOf = (body: object) =>
  nestedErrorsOf(PhotoDownloadDto, body as Record<string, unknown>);

describe('PhotoDownloadDto: a forma do pedido do download da foto (B2)', () => {
  it.each([
    ['um resultId', { resultId: 'r3' }],
    ['o resultId real, longo', { resultId: 'r1764300000003' }],
    ['resultId de 64 caracteres', { resultId: 'r'.repeat(64) }],
  ])('aceita %s', async (_name, body) => {
    expect(await errorsOf(body)).toEqual([]);
  });

  it.each([
    ['resultId vazio', { resultId: '' }],
    ['resultId de 65 caracteres', { resultId: 'r'.repeat(65) }],
    ['resultId numérico', { resultId: 3 }],
    ['resultId nulo', { resultId: null }],
    ['resultId lista', { resultId: ['r3'] }],
  ])('recusa %s', async (_name, body) => {
    expect(await errorsOf(body)).toEqual(['resultId']);
  });

  it('resultId nulo é recusado na primeira chamada e na repetição do mesmo corpo (L-24)', async () => {
    const body = { resultId: null };

    expect(await errorsOf(body)).toEqual(['resultId']);
    expect(await errorsOf(body)).toEqual(['resultId']);
  });

  it.each([
    ['só o endereço', { imageUrl: 'https://exemplo.com/x.jpg' }, ['imageUrl', 'resultId']],
    [
      'o resultId e um endereço',
      { resultId: 'r3', imageUrl: 'https://exemplo.com/x.jpg' },
      ['imageUrl'],
    ],
    ['o resultId e outro campo', { resultId: 'r3', url: 'https://exemplo.com/x.jpg' }, ['url']],
  ])(
    'URL livre no corpo (%s) é recusada: o download só existe pelo resultId',
    async (_name, body, paths) => {
      expect(await errorsOf(body)).toEqual(paths);
    },
  );
});
