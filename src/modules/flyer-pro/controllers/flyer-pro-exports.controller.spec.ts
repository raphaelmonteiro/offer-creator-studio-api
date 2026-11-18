import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import type { CreateFlyerProExportDto } from '../dto/create-flyer-pro-export.dto';
import type { FlyerProExportsService } from '../services/flyer-pro-exports.service';
import { DocumentIdPipe } from './flyer-pro-documents.controller';
import { FlyerProExportsController } from './flyer-pro-exports.controller';

const dto = { id: 'e1' } as CreateFlyerProExportDto;

function setup() {
  const exports = { register: jest.fn(), list: jest.fn() };
  const res = { status: jest.fn() };
  const controller = new FlyerProExportsController(exports as unknown as FlyerProExportsService);
  return { controller, exports, res: res as unknown as Response & typeof res };
}

/** Os pipes de cada parâmetro do handler, na ordem dos parâmetros. */
const pipesOf = (handler: 'register' | 'list'): unknown[][] =>
  Object.values<{ pipes: unknown[]; index: number }>(
    Reflect.getMetadata(ROUTE_ARGS_METADATA, FlyerProExportsController, handler),
  )
    .sort((a, b) => a.index - b.index)
    .map((arg) => arg.pipes);

describe('FlyerProExportsController', () => {
  it('é /flyer-pro/documents/:id/exports (o prefixo /v1 vem do app) e exige o guard JWT', () => {
    expect(Reflect.getMetadata(PATH_METADATA, FlyerProExportsController)).toBe(
      'flyer-pro/documents/:id/exports',
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, FlyerProExportsController)).toEqual([JwtAuthGuard]);
  });

  it('registrar é POST na raiz com o pipe do id, passa o encarte, o corpo e o usuário do token, responde 201 e devolve a linha', async () => {
    const { controller, exports, res } = setup();
    const view = { id: 'e1', replayed: false };
    exports.register.mockResolvedValue({ view, created: true });
    const handler = FlyerProExportsController.prototype.register;

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(pipesOf('register')[0]).toContain(DocumentIdPipe);
    await expect(controller.register('d1', dto, { id: 'u1' }, res)).resolves.toBe(view);

    expect(exports.register).toHaveBeenCalledWith('d1', dto, 'u1');
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('a repetição do mesmo id responde 200', async () => {
    const { controller, exports, res } = setup();
    exports.register.mockResolvedValue({ view: { id: 'e1', replayed: true }, created: false });

    await controller.register('d1', dto, { id: 'u1' }, res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('o histórico é GET na raiz com o pipe do id e passa o id e a consulta ao serviço', async () => {
    const { controller, exports } = setup();
    const page = { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } };
    exports.list.mockResolvedValue(page);
    const handler = FlyerProExportsController.prototype.list;

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(pipesOf('list')[0]).toContain(DocumentIdPipe);
    await expect(controller.list('d1', { page: 2 })).resolves.toBe(page);

    expect(exports.list).toHaveBeenCalledWith('d1', { page: 2 });
  });
});
