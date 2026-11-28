import type { HttpException } from '@nestjs/common';
import {
  SafeDownloadError,
  type SafeDownloadReason,
} from '../../../shared/http/safe-download-error';
import { PHOTO_SEARCH_MAX_PAGES, FlyerProPhotoSearchStore } from './flyer-pro-photo-search-store';
import {
  bodyOfDownload,
  downloaded,
  DOCUMENT_ID,
  fakeGalleryImport,
  fakePhotoPort,
  ITEM_ID,
  makePhotoDownloadService,
  photo,
  storeResult,
} from './flyer-pro-photo-search.service.testutil';

const refusalOf = (pending: Promise<unknown>) =>
  pending.then(
    () => {
      throw new Error('deveria recusar');
    },
    (e: unknown) => e as HttpException,
  );

describe('FlyerProPhotoDownloadService: falha e recusa do download', () => {
  it.each([
    ['SCHEME', 422, 'FLYER_PRO_PHOTO_DOWNLOAD_REFUSED'],
    ['PRIVATE_ADDRESS', 422, 'FLYER_PRO_PHOTO_DOWNLOAD_REFUSED'],
    ['TOO_MANY_REDIRECTS', 422, 'FLYER_PRO_PHOTO_DOWNLOAD_REFUSED'],
    ['NOT_AN_IMAGE', 422, 'FLYER_PRO_PHOTO_DOWNLOAD_REFUSED'],
    ['TOO_LARGE', 422, 'FLYER_PRO_PHOTO_DOWNLOAD_REFUSED'],
    ['ORIGIN_STATUS', 502, 'FLYER_PRO_PHOTO_DOWNLOAD_FAILED'],
    ['NETWORK', 502, 'FLYER_PRO_PHOTO_DOWNLOAD_FAILED'],
    ['TIMEOUT', 502, 'FLYER_PRO_PHOTO_DOWNLOAD_FAILED'],
  ] as [SafeDownloadReason, number, string][])(
    'motivo %s do download seguro: %s %s com o mesmo reason, nada registrado',
    async (reason, status, code) => {
      const { port } = fakePhotoPort([], {
        fetchPhoto: jest.fn(async () => {
          throw new SafeDownloadError(reason, 'falhou');
        }),
      });
      const { service, store, registerDownloaded } = makePhotoDownloadService({ port });
      const r3 = storeResult(store, photo(3));

      const error = await refusalOf(
        service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(r3.resultId)),
      );

      expect(error.getStatus()).toBe(status);
      expect(error.getResponse()).toMatchObject({ code, details: { reason } });
      expect(registerDownloaded).not.toHaveBeenCalled();
    },
  );

  it('outra foto da mesma busca depois da falha: 200, e o resultado que falhou segue guardado', async () => {
    const fetchPhoto = jest
      .fn()
      .mockRejectedValueOnce(new SafeDownloadError('ORIGIN_STATUS', 'status 403'))
      .mockResolvedValue(downloaded());
    const { port } = fakePhotoPort([], { fetchPhoto });
    const { service, store } = makePhotoDownloadService({ port });
    const store3 = storeResult(store, photo(3));
    const store6 = storeResult(store, photo(6), { page: 2 });

    const failed = await refusalOf(
      service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(store3.resultId)),
    );
    const next = await service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(store6.resultId));

    expect(failed.getStatus()).toBe(502);
    expect(next.imageId).toBe('galeria-1');
    expect(store.findResult(DOCUMENT_ID, ITEM_ID, store3.resultId)).toEqual(store3);
  });

  it('registro na Galeria que falha: o erro segue como veio (500 do filtro global) e nada é devolvido', async () => {
    const { port } = fakePhotoPort([], { fetchPhoto: jest.fn(async () => downloaded()) });
    const failure = new Error('falha ao gravar gallery_images');
    const { gallery, registerDownloaded } = fakeGalleryImport(failure);
    const { service, store } = makePhotoDownloadService({ port, gallery });
    const r3 = storeResult(store, photo(3));

    const error = await service
      .download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(r3.resultId))
      .catch((e: unknown) => e);

    expect(error).toBe(failure);
    expect(registerDownloaded).toHaveBeenCalledTimes(1);
    expect(store.findResult(DOCUMENT_ID, ITEM_ID, r3.resultId)).toEqual(r3);
  });

  it('erro que não é do download seguro (bug do provedor) não vira recusa: segue como veio', async () => {
    const boom = new TypeError('inesperado');
    const { port } = fakePhotoPort([], {
      fetchPhoto: jest.fn(async () => {
        throw boom;
      }),
    });
    const { service, store } = makePhotoDownloadService({ port });
    const r3 = storeResult(store, photo(3));

    await expect(service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(r3.resultId))).rejects.toBe(
      boom,
    );
  });

  it('teto da memória da resposta guardada: o download de uma página expulsa é 404, sem requisição externa', async () => {
    const { port } = fakePhotoPort([], { fetchPhoto: jest.fn(async () => downloaded()) });
    const store = new FlyerProPhotoSearchStore();
    const { service } = makePhotoDownloadService({ port, store });
    const expelled = storeResult(store, photo(1), { term: 'primeiro termo' });
    for (let i = 0; i < PHOTO_SEARCH_MAX_PAGES; i++) {
      storeResult(store, photo(i + 2), { term: `termo ${i}` });
    }

    const error = await refusalOf(
      service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(expelled.resultId)),
    );

    expect(store.pageCount).toBe(PHOTO_SEARCH_MAX_PAGES);
    expect(error.getResponse()).toMatchObject({ code: 'FLYER_PRO_PHOTO_RESULT_NOT_FOUND' });
    expect(port.fetchPhoto).not.toHaveBeenCalled();
  });
});
