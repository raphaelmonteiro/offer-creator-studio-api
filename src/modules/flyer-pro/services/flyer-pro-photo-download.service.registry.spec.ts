import {
  bodyOfDownload,
  downloaded,
  DOCUMENT_ID,
  fakePhotoPort,
  ITEM_ID,
  makePhotoDownloadService,
  photo,
  storeResult,
} from './flyer-pro-photo-search.service.testutil';

describe('FlyerProPhotoDownloadService: foto registrada na Galeria e foto pequena pela medida', () => {
  function setup(image = downloaded()) {
    const { port } = fakePhotoPort([], { fetchPhoto: jest.fn(async () => image) });
    return { port, ...makePhotoDownloadService({ port }) };
  }

  it('a resposta traz a foto registrada, com a medida do arquivo (a que o registro devolveu, com a orientação do EXIF)', async () => {
    const { service, store } = setup(downloaded(900, 1200));
    const r3 = storeResult(store, photo(3, { width: 1200, height: 900 }));

    const view = await service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(r3.resultId));

    expect(view).toMatchObject({ width: 900, height: 1200, small: false });
  });

  it('o nome do arquivo na Galeria sai do termo da busca que achou o resultado', async () => {
    const { service, store, registerDownloaded } = setup();
    const r3 = storeResult(store, photo(3), { term: 'ACÉM COM OSSO KG' });

    await service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(r3.resultId));

    expect(registerDownloaded.mock.calls[0][1]).toBe('ACÉM COM OSSO KG');
  });

  it('duas vezes o mesmo resultado: dois registros, cada resposta com um imageId diferente', async () => {
    const { service, store, registerDownloaded } = setup();
    const r3 = storeResult(store, photo(3));

    const first = await service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(r3.resultId));
    const second = await service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(r3.resultId));

    expect(registerDownloaded).toHaveBeenCalledTimes(2);
    expect(first.imageId).not.toBe(second.imageId);
    expect(first.imageUrl).not.toBe(second.imageUrl);
  });

  it.each([
    ['299 × 300', 299, 300, true],
    ['300 × 300 (no limite)', 300, 300, false],
    ['300 × 240', 300, 240, true],
    ['1000 × 299', 1000, 299, true],
  ])('small pela medida do arquivo baixado: %s', async (_name, width, height, small) => {
    const { service, store } = setup(downloaded(width, height));
    const r3 = storeResult(store, photo(3, { width: 1200, height: 1200 }));

    const view = await service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(r3.resultId));

    expect(view).toMatchObject({ width, height, small });
  });

  it('download da foto sem tamanho na busca: o arquivo de 240 × 240 vira 240, 240 e small true', async () => {
    const { service, store } = setup(downloaded(240, 240));
    const r3 = storeResult(store, photo(3, { width: null, height: null }));

    const view = await service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(r3.resultId));

    expect(view).toMatchObject({ width: 240, height: 240, small: true });
  });
});
