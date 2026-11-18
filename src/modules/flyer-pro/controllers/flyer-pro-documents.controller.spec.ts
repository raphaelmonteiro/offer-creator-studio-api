import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import type { CreateFlyerProDocumentDto } from '../dto/create-flyer-pro-document.dto';
import type { UpdateFlyerProCursorDto } from '../dto/update-flyer-pro-cursor.dto';
import type { SaveFlyerProDocumentDto } from '../dto/save-flyer-pro-document.dto';
import type { FlyerProImportsService } from '../services/flyer-pro-imports.service';
import type { FlyerProItemsService } from '../services/flyer-pro-items.service';
import type { FlyerProCursorService } from '../services/flyer-pro-cursor.service';
import type { FlyerProDocumentsService } from '../services/flyer-pro-documents.service';
import type { FlyerProSaveService } from '../services/flyer-pro-save.service';
import { DocumentIdPipe, FlyerProDocumentsController } from './flyer-pro-documents.controller';

const dto = { creationKey: 'k' } as CreateFlyerProDocumentDto;

function setup() {
  const documents = {
    create: jest.fn(),
    list: jest.fn(),
    open: jest.fn(),
    remove: jest.fn(),
  };
  const saves = { save: jest.fn() };
  const cursors = { set: jest.fn() };
  const items = { list: jest.fn() };
  const imports = { list: jest.fn() };
  const res = { status: jest.fn() };
  const controller = new FlyerProDocumentsController(
    documents as unknown as FlyerProDocumentsService,
    saves as unknown as FlyerProSaveService,
    cursors as unknown as FlyerProCursorService,
    items as unknown as FlyerProItemsService,
    imports as unknown as FlyerProImportsService,
  );
  return {
    controller,
    documents,
    saves,
    cursors,
    items,
    imports,
    res: res as unknown as Response & typeof res,
  };
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

  it('salvar passa o id do usuário do token, o id do encarte e o corpo, e devolve a resposta do serviço', async () => {
    const { controller, saves } = setup();
    const body = { mutationId: 'm' } as SaveFlyerProDocumentDto;
    saves.save.mockResolvedValue({ revision: 38 });

    await expect(controller.save('d1', body, { id: 'u1' })).resolves.toEqual({ revision: 38 });

    expect(saves.save).toHaveBeenCalledWith('u1', 'd1', body);
  });

  it('o cursor passa o id do encarte e o corpo ao serviço e devolve a etapa e o pagesFrozen', async () => {
    const { controller, cursors } = setup();
    const body = { step: 'assembly' } as UpdateFlyerProCursorDto;
    cursors.set.mockResolvedValue({ step: 'assembly', pagesFrozen: true });

    await expect(controller.setCursor('d1', body)).resolves.toEqual({
      step: 'assembly',
      pagesFrozen: true,
    });

    expect(cursors.set).toHaveBeenCalledWith('d1', body);
  });

  it('listar os itens passa o id e o updatedAfter ao serviço', async () => {
    const { controller, items } = setup();
    items.list.mockResolvedValue({ items: [], cursor: 'c' });

    await expect(
      controller.listItems('d1', { updatedAfter: '2026-11-14T13:05:40.412377Z' }),
    ).resolves.toEqual({ items: [], cursor: 'c' });
    await controller.listItems('d1', {});

    expect(items.list).toHaveBeenNthCalledWith(1, 'd1', '2026-11-14T13:05:40.412377Z');
    expect(items.list).toHaveBeenNthCalledWith(2, 'd1', undefined);
  });

  it('o histórico das importações é GET :id/imports com o pipe do id, e passa o id e a consulta ao serviço', async () => {
    const { controller, imports } = setup();
    const page = { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } };
    imports.list.mockResolvedValue(page);
    const handler = FlyerProDocumentsController.prototype.listImports;
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      FlyerProDocumentsController,
      'listImports',
    );

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/imports');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(
      Object.values<{ pipes: unknown[] }>(args).some((a) => a.pipes.includes(DocumentIdPipe)),
    ).toBe(true);
    await expect(controller.listImports('d1', { fileHash: 'h', page: 2 })).resolves.toBe(page);
    expect(imports.list).toHaveBeenCalledWith('d1', { fileHash: 'h', page: 2 });
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
