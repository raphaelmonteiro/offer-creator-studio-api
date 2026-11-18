import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateFlyerProDocumentDto } from './create-flyer-pro-document.dto';
import { QueryFlyerProDocumentsDto } from './query-flyer-pro-documents.dto';

const VALID = {
  creationKey: '5b1e0c3a-8f0e-4d7a-9a51-2f4c1d7e9b10',
  name: 'Ofertas Piccin semana 47',
  clientId: 'c2e28b36-5c8e-4fa0-9f37-7c3357ac8487',
  sceneId: '9eb30a72-aa45-41c1-9832-2733d6a39277',
  schemaVersion: 1,
  engineVersion: 1,
};

const create = (over: Record<string, unknown>) =>
  plainToInstance(CreateFlyerProDocumentDto, { ...VALID, ...over });
const errorsOf = async (body: Record<string, unknown>) =>
  (await validate(create(body))).map((error) => error.property);

describe('CreateFlyerProDocumentDto', () => {
  it('aceita o corpo do contrato', async () => {
    expect(await errorsOf({})).toEqual([]);
  });

  it('apara o nome: "  Feira de sábado  " vira "Feira de sábado", e as versões ficam como vieram', async () => {
    const dto = create({ name: '  Feira de sábado  ', engineVersion: 3 });
    expect(await validate(dto)).toEqual([]);
    expect(dto).toMatchObject({ name: 'Feira de sábado', schemaVersion: 1, engineVersion: 3 });
  });

  it('aceita nome de 120 caracteres e recusa o de 121, o vazio e o só de espaços', async () => {
    expect(await errorsOf({ name: 'x'.repeat(120) })).toEqual([]);
    expect(await errorsOf({ name: 'x'.repeat(121) })).toEqual(['name']);
    expect(await errorsOf({ name: '' })).toEqual(['name']);
    expect(await errorsOf({ name: '   ' })).toEqual(['name']);
    expect(await errorsOf({ name: 12 })).toEqual(['name']);
  });

  it.each([
    ['creationKey', 'abc'],
    ['clientId', 'abc'],
    ['sceneId', 123],
    ['schemaVersion', 0],
    ['schemaVersion', 1.5],
    ['schemaVersion', 2147483648],
    ['engineVersion', 0],
    ['engineVersion', '1'],
    ['engineVersion', 2147483648],
  ])('rejeita %s=%p', async (field, value) => {
    expect(await errorsOf({ [field]: value })).toEqual([field]);
  });

  it('aceita as versões nos extremos, de 1 a 2147483647', async () => {
    expect(await errorsOf({ schemaVersion: 1, engineVersion: 2147483647 })).toEqual([]);
  });

  it('campo ausente é recusado pelo nome do campo', async () => {
    const { sceneId: _sceneId, ...withoutScene } = VALID;
    const dto = plainToInstance(CreateFlyerProDocumentDto, withoutScene);
    expect((await validate(dto)).map((error) => error.property)).toEqual(['sceneId']);
  });
});

describe('QueryFlyerProDocumentsDto', () => {
  const queryErrors = async (query: Record<string, unknown>) =>
    (await validate(plainToInstance(QueryFlyerProDocumentsDto, query))).map(
      (error) => error.property,
    );

  it('sem nenhum campo é válida, e aceita a página e os filtros na forma certa (a query chega como texto)', async () => {
    expect(await queryErrors({})).toEqual([]);
    expect(
      await queryErrors({
        page: '2',
        limit: '50',
        search: 'piccin',
        clientId: 'c2e28b36-5c8e-4fa0-9f37-7c3357ac8487',
      }),
    ).toEqual([]);
  });

  it.each([
    ['limit', '51'],
    ['limit', '0'],
    ['page', '0'],
    ['clientId', 'abc'],
    ['search', 'x'.repeat(81)],
  ])('rejeita %s=%p', async (field, value) => {
    expect(await queryErrors({ [field]: value })).toEqual([field]);
  });

  it('aceita search de 80 caracteres e vazio', async () => {
    expect(await queryErrors({ search: 'x'.repeat(80) })).toEqual([]);
    expect(await queryErrors({ search: '' })).toEqual([]);
  });
});
