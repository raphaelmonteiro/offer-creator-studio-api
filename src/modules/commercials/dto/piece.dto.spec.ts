import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePieceDto, ListPiecesQueryDto, SaveAsTemplateDto, UpdatePieceDto } from './piece.dto';

const CLIENT = '11111111-1111-4111-8111-111111111111';

async function errorsOf<T extends object>(cls: new () => T, plain: Record<string, unknown>) {
  const errors = await validate(plainToInstance(cls, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

/** Convenção D13: FORMA do DTO → 400 pelo pipe global; o descritor é validado pelo domínio. */
describe('DTOs da peça de ofertas (grupo 4)', () => {
  it('CreatePieceDto: cliente uuid e formato do lançamento; modelo e nome opcionais; chave estranha → erro', async () => {
    expect(await errorsOf(CreatePieceDto, { clientId: CLIENT, aspectRatio: '9:16' })).toEqual([]);
    expect(
      await errorsOf(CreatePieceDto, {
        clientId: CLIENT,
        aspectRatio: '4:5',
        templateId: CLIENT,
        name: 'S',
      }),
    ).toEqual([]);
    expect(await errorsOf(CreatePieceDto, { clientId: 'x', aspectRatio: '16:9' })).toEqual(
      expect.arrayContaining(['clientId', 'aspectRatio']),
    );
    expect(
      await errorsOf(CreatePieceDto, { clientId: CLIENT, aspectRatio: '9:16', document: {} }),
    ).toEqual(['document']);
  });

  it('UpdatePieceDto: documento objeto + expectedRevision inteiro ≥ 0', async () => {
    expect(
      await errorsOf(UpdatePieceDto, { document: { schemaVersion: 1 }, expectedRevision: 0 }),
    ).toEqual([]);
    expect(await errorsOf(UpdatePieceDto, { document: 'x', expectedRevision: -1 })).toEqual(
      expect.arrayContaining(['document', 'expectedRevision']),
    );
    expect(await errorsOf(UpdatePieceDto, { document: {}, expectedRevision: 1.5 })).toEqual([
      'expectedRevision',
    ]);
  });

  it('SaveAsTemplateDto e ListPiecesQueryDto', async () => {
    expect(await errorsOf(SaveAsTemplateDto, { name: 'Semanal' })).toEqual([]);
    expect(await errorsOf(SaveAsTemplateDto, { name: '' })).toEqual(['name']);
    expect(await errorsOf(ListPiecesQueryDto, {})).toEqual([]);
    expect(await errorsOf(ListPiecesQueryDto, { kind: 'template', clientId: CLIENT })).toEqual([]);
    expect(await errorsOf(ListPiecesQueryDto, { kind: 'draft' })).toEqual(['kind']);
  });
});
