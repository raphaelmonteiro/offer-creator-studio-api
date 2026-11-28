import type { HttpException } from '@nestjs/common';
import { captureLogs } from '../providers/flyer-pro-photo-search.testutil';
import { PhotoLinkResolveFailure } from '../providers/flyer-pro-photo-search.port';
import { SafeDownloadError } from '../../../shared/http/safe-download-error';
import { FlyerProPhotoSearchStore } from './flyer-pro-photo-search-store';
import {
  bodyOf,
  bodyOfDownload,
  downloaded,
  DOCUMENT_ID,
  fakePhotoPort,
  ITEM_ID,
  makePhotoDownloadService,
  makePhotoSearchService,
  photo,
  storeResult,
} from './flyer-pro-photo-search.service.testutil';

const GOTO = 'https://www.google.com/goto?url=CAESYwHr';
const REAL = 'https://pomarbrasilia.com.br/banana-nanica.jpg';

const refusalOf = (pending: Promise<unknown>) =>
  pending.then(
    () => {
      throw new Error('deveria recusar');
    },
    (e: unknown) => e as HttpException,
  );

describe('FlyerProPhotoDownloadService: link de redirecionamento do Google', () => {
  function setup(over: Parameters<typeof fakePhotoPort>[1] = {}) {
    const { port } = fakePhotoPort([], {
      resolveLink: jest.fn(async () => REAL),
      fetchPhoto: jest.fn(async () => downloaded()),
      ...over,
    });
    const made = makePhotoDownloadService({ port });
    return { port, ...made, r5: storeResult(made.store, photo(5, { imageUrl: GOTO })) };
  }

  it('goto para um supermercado: o endereço resolvido é o baixado, uma resolução só', async () => {
    const { service, port, r5 } = setup();

    const view = await service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(r5.resultId));

    expect(port.resolveLink).toHaveBeenCalledTimes(1);
    expect(port.resolveLink).toHaveBeenCalledWith(GOTO);
    expect(port.fetchPhoto).toHaveBeenCalledWith(REAL);
    expect(view.imageId).toBe('galeria-1');
  });

  it('goto resolvido para endereço interno: 422 PRIVATE_ADDRESS pelas regras do download, nada registrado', async () => {
    const { service, port, r5, registerDownloaded } = setup({
      resolveLink: jest.fn(async () => 'http://10.0.0.5/foto.jpg'),
      fetchPhoto: jest.fn(async () => {
        throw new SafeDownloadError('PRIVATE_ADDRESS', 'endereço interno');
      }),
    });

    const error = await refusalOf(
      service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(r5.resultId)),
    );

    expect(port.fetchPhoto).toHaveBeenCalledWith('http://10.0.0.5/foto.jpg');
    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toMatchObject({
      code: 'FLYER_PRO_PHOTO_DOWNLOAD_REFUSED',
      details: { reason: 'PRIVATE_ADDRESS' },
    });
    expect(registerDownloaded).not.toHaveBeenCalled();
  });

  it('resultado com endereço direto: nenhuma resolução, nem a conferência da chave (sem chave também baixa)', async () => {
    const { port } = fakePhotoPort([], {
      unavailableReason: jest.fn(() => 'NO_API_KEY' as const),
      resolveLink: jest.fn(),
      fetchPhoto: jest.fn(async () => downloaded()),
    });
    const { service, store } = makePhotoDownloadService({ port });
    const r3 = storeResult(store, photo(3));

    await service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(r3.resultId));

    expect(port.resolveLink).not.toHaveBeenCalled();
    expect(port.unavailableReason).not.toHaveBeenCalled();
    expect(port.fetchPhoto).toHaveBeenCalledTimes(1);
  });

  it('goto sem a chave: 503 NO_API_KEY só nesse caso, sem resolver nem baixar', async () => {
    const { service, port, r5, registerDownloaded } = setup({
      unavailableReason: () => 'NO_API_KEY',
    });

    const error = await refusalOf(
      service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(r5.resultId)),
    );

    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({
      code: 'FLYER_PRO_PHOTO_SEARCH_UNAVAILABLE',
      details: { reason: 'NO_API_KEY' },
    });
    expect(port.resolveLink).not.toHaveBeenCalled();
    expect(port.fetchPhoto).not.toHaveBeenCalled();
    expect(registerDownloaded).not.toHaveBeenCalled();
  });

  it('resolução que falha (erro, link ainda não pronto, fora da forma, prazo): 502 RESOLVE_FAILED, uma tentativa, nada baixado nem registrado', async () => {
    const { service, port, r5, registerDownloaded } = setup({
      resolveLink: jest.fn(async () => {
        throw new PhotoLinkResolveFailure('falhou');
      }),
    });

    const error = await refusalOf(
      service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(r5.resultId)),
    );

    expect(error.getStatus()).toBe(502);
    expect(error.getResponse()).toMatchObject({
      code: 'FLYER_PRO_PHOTO_DOWNLOAD_FAILED',
      details: { reason: 'RESOLVE_FAILED' },
    });
    expect(port.resolveLink).toHaveBeenCalledTimes(1);
    expect(port.fetchPhoto).not.toHaveBeenCalled();
    expect(registerDownloaded).not.toHaveBeenCalled();
  });

  it('resolução com o teto cheio: a busca nova é 429, e o download do goto resolve e responde 200 (não conta no teto)', async () => {
    captureLogs();
    const store = new FlyerProPhotoSearchStore();
    const { port, search: providerSearch } = fakePhotoPort([photo(5, { imageUrl: GOTO })], {
      resolveLink: jest.fn(async () => REAL),
      fetchPhoto: jest.fn(async () => downloaded()),
    });
    const search = makePhotoSearchService({ port, store, config: { maxPerHour: 1 } }).service;
    const downloading = makePhotoDownloadService({ port, store }).service;
    const page = await search.search(DOCUMENT_ID, ITEM_ID, bodyOf('BANANA NANICA KG'));
    const full = await refusalOf(search.search(DOCUMENT_ID, ITEM_ID, bodyOf('outro termo')));
    expect(full.getStatus()).toBe(429);

    expect(providerSearch).toHaveBeenCalledTimes(1);

    const view = await downloading.download(
      DOCUMENT_ID,
      ITEM_ID,
      bodyOfDownload(page.results[0].resultId),
    );

    expect(port.resolveLink).toHaveBeenCalledTimes(1);
    expect(view.imageId).toBe('galeria-1');
    expect(providerSearch).toHaveBeenCalledTimes(1);
  });
});
