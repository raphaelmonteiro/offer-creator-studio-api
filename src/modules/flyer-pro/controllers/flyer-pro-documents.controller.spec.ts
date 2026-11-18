import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import type { CreateFlyerProDocumentDto } from '../dto/create-flyer-pro-document.dto';
import type { FlyerProDocumentsService } from '../services/flyer-pro-documents.service';
import { DocumentIdPipe, FlyerProDocumentsController } from './flyer-pro-documents.controller';

const dto = { creationKey: 'k' } as CreateFlyerProDocumentDto;

function setup() {
  const documents = {
    create: jest.fn(),
    list: jest.fn(),
    open: jest.fn(),
    remove: jest.fn(),
  };
  const res = { status: jest.fn() };
  const controller = new FlyerProDocumentsController(
    documents as unknown as FlyerProDocumentsService,
  );
  return { controller, documents, res: res as unknown as Response & typeof res };
}

describe('FlyerProDocumentsController', () => {
  it('é /flyer-pro/documents (o prefixo /v1 vem do app) e exige o guard JWT', () => {
    expect(Reflect.getMetadata(PATH_METADATA, FlyerProDocumentsController)).toBe(
      'flyer-pro/documents',
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, FlyerProDocumentsController)).toEqual([
      JwtAuthGuard,
    ]);
  });

  it('criar passa o corpo e o id do usuário do token, responde 201 e devolve o encarte', async () => {
    const { controller, documents, res } = setup();
    const document = { id: 'd1', replayed: false };
    documents.create.mockResolvedValue({ document, created: true });

    await expect(controller.create(dto, { id: 'u1' }, res)).resolves.toBe(document);

    expect(documents.create).toHaveBeenCalledWith(dto, 'u1');
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('a repetição da chave responde 200', async () => {
    const { controller, documents, res } = setup();
    documents.create.mockResolvedValue({ document: { id: 'd1', replayed: true }, created: false });

    await controller.create(dto, { id: 'u1' }, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('listar, abrir e excluir repassam ao serviço o que ele devolve', async () => {
    const { controller, documents } = setup();
    const query = { search: 'a' };
    documents.list.mockResolvedValue('lista');
    documents.open.mockResolvedValue('encarte');
    documents.remove.mockResolvedValue({ deleted: true });

    await expect(controller.list(query)).resolves.toBe('lista');
    await expect(controller.open('d1')).resolves.toBe('encarte');
    await expect(controller.remove('d1')).resolves.toEqual({ deleted: true });

    expect(documents.list).toHaveBeenCalledWith(query);
    expect(documents.open).toHaveBeenCalledWith('d1');
    expect(documents.remove).toHaveBeenCalledWith('d1');
  });

  it('o pipe do id deixa passar um UUID e transforma o que não é UUID em 404 FLYER_PRO_NOT_FOUND', async () => {
    const meta = { type: 'param' as const, metatype: String, data: 'id' };
    const uuid = '2c1d7e9b-4f6a-4b1e-9a3d-7e5f0c8b6a21';

    await expect(DocumentIdPipe.transform(uuid, meta)).resolves.toBe(uuid);
    await expect(DocumentIdPipe.transform('abc', meta)).rejects.toMatchObject({
      status: 404,
      response: { code: 'FLYER_PRO_NOT_FOUND', message: 'Encarte não encontrado ou excluído.' },
    });
  });
});
