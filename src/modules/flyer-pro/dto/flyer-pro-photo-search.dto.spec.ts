import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { nestedErrorsOf } from './dto-paths.testutil';
import { PhotoSearchDto } from './flyer-pro-photo-search.dto';

const errorsOf = (body: object) => nestedErrorsOf(PhotoSearchDto, body as Record<string, unknown>);

describe('PhotoSearchDto: a forma do pedido da busca de fotos (B1)', () => {
  it.each([
    ['só o termo', { term: 'ACÉM COM OSSO KG' }],
    ['termo e página 1', { term: 'ACÉM COM OSSO KG', page: 1 }],
    ['página 10', { term: 'BATATA DOCE ROXA KG', page: 10 }],
    ['termo de 120 caracteres', { term: 'a'.repeat(120) }],
    ['termo de 120 caracteres com espaços nas pontas', { term: ` ${'a'.repeat(120)} ` }],
  ])('aceita %s', async (_name, body) => {
    expect(await errorsOf(body)).toEqual([]);
  });

  it.each([
    ['termo vazio', { term: '' }],
    ['termo só com espaços', { term: '   ' }],
    ['termo de 121 caracteres', { term: 'a'.repeat(121) }],
    ['termo numérico', { term: 123 }],
    ['termo nulo', { term: null }],
  ])('recusa %s', async (_name, body) => {
    expect(await errorsOf(body)).toEqual(['term']);
  });

  it.each([
    ['page 0', 0],
    ['page 11', 11],
    ['page negativa', -1],
    ['page fracionária', 1.5],
    ['page em texto', '2'],
    ['page nula', null],
    ['page booleana', true],
  ])('recusa %s', async (_name, page) => {
    expect(await errorsOf({ term: 'ACÉM', page })).toEqual(['page']);
  });

  it('page nula é recusada na primeira chamada e na repetição do mesmo corpo (L-24)', async () => {
    const body = { term: 'ACÉM', page: null };

    expect(await errorsOf(body)).toEqual(['page']);
    expect(await errorsOf(body)).toEqual(['page']);
  });

  it.each([
    ['país', { gl: 'us' }],
    ['idioma', { hl: 'en' }],
    ['quantidade', { num: 30 }],
    ['tipo', { tbm: 'isch' }],
    ['endereço da foto', { imageUrl: 'https://exemplo.com/x.jpg' }],
  ])(
    'campo desconhecido (%s) é recusado: o servidor fixa país, idioma e quantidade',
    async (_name, extra) => {
      expect(await errorsOf({ term: 'BATATA DOCE ROXA KG', ...extra })).toEqual([
        Object.keys(extra)[0],
      ]);
    },
  );

  it('o termo é aparado na conversão do corpo', async () => {
    const dto = plainToInstance(PhotoSearchDto, { term: '  coxão mole  ' });

    expect(dto.term).toBe('coxão mole');
    expect(await validate(dto)).toEqual([]);
  });

  it('o corpo {} é recusado pelo DTO, mas o pipe global o pula: por isso o serviço confere o termo à mão', async () => {
    expect(await errorsOf({})).toEqual(['term']);
  });
});
