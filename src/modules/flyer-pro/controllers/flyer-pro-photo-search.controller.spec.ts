import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import type { PhotoDownloadDto } from '../dto/flyer-pro-photo-download.dto';
import type { PhotoSearchDto } from '../dto/flyer-pro-photo-search.dto';
import type { FlyerProPhotoDownloadService } from '../services/flyer-pro-photo-download.service';
import type { FlyerProPhotoSearchService } from '../services/flyer-pro-photo-search.service';
import { DocumentIdPipe } from './flyer-pro-documents.controller';
import { ItemIdPipe } from './flyer-pro-item-id.pipe';
import { FlyerProPhotoSearchController } from './flyer-pro-photo-search.controller';

function setup() {
  const photoSearch = { search: jest.fn() };
  const photoDownload = { download: jest.fn() };
  const controller = new FlyerProPhotoSearchController(
    photoSearch as unknown as FlyerProPhotoSearchService,
    photoDownload as unknown as FlyerProPhotoDownloadService,
  );
  return { controller, photoSearch, photoDownload };
}

describe('FlyerProPhotoSearchController', () => {
  it('fica no prefixo flyer-pro/documents e exige o guard JWT', () => {
    expect(Reflect.getMetadata(PATH_METADATA, FlyerProPhotoSearchController)).toBe(
      'flyer-pro/documents',
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, FlyerProPhotoSearchController)).toEqual([
      JwtAuthGuard,
    ]);
  });

  it('POST :id/items/:itemId/photo-search responde 200, com o encarte pelo DocumentIdPipe e o item pelo ItemIdPipe', () => {
    const handler = FlyerProPhotoSearchController.prototype.search;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/items/:itemId/photo-search');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      FlyerProPhotoSearchController,
      'search',
    ) as Record<string, { data: string; pipes: unknown[] }>;
    const pipesOf = (name: string) => Object.values(args).find((arg) => arg.data === name)?.pipes;
    expect(pipesOf('id')).toEqual([DocumentIdPipe]);
    expect(pipesOf('itemId')).toEqual([ItemIdPipe]);
  });

  it('entrega encarte, item e corpo ao serviço e devolve a resposta como veio', async () => {
    const { controller, photoSearch } = setup();
    const view = { term: 'x', page: 1, hasMore: false, fromCache: false, results: [] };
    photoSearch.search.mockResolvedValue(view);
    const dto = { term: 'x' } as PhotoSearchDto;

    await expect(controller.search('doc-1', 'item-1', dto)).resolves.toBe(view);

    expect(photoSearch.search).toHaveBeenCalledWith('doc-1', 'item-1', dto);
  });

  it('POST :id/items/:itemId/photo-search/download responde 200, com o encarte pelo DocumentIdPipe e o item pelo ItemIdPipe', () => {
    const handler = FlyerProPhotoSearchController.prototype.download;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      ':id/items/:itemId/photo-search/download',
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      FlyerProPhotoSearchController,
      'download',
    ) as Record<string, { data: string; pipes: unknown[] }>;
    const pipesOf = (name: string) => Object.values(args).find((arg) => arg.data === name)?.pipes;
    expect(pipesOf('id')).toEqual([DocumentIdPipe]);
    expect(pipesOf('itemId')).toEqual([ItemIdPipe]);
  });

  it('entrega encarte, item e corpo ao serviço do download e devolve a resposta como veio', async () => {
    const { controller, photoDownload, photoSearch } = setup();
    const view = { imageUrl: 'u', imageId: 'i', width: 1000, height: 1000, small: false };
    photoDownload.download.mockResolvedValue(view);
    const dto = { resultId: 'r3' } as PhotoDownloadDto;

    await expect(controller.download('doc-1', 'item-1', dto)).resolves.toBe(view);

    expect(photoDownload.download).toHaveBeenCalledWith('doc-1', 'item-1', dto);
    expect(photoSearch.search).not.toHaveBeenCalled();
  });
});
