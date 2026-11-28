import type { HttpException } from '@nestjs/common';
import { FlyerProPhotoSearchStore } from './flyer-pro-photo-search-store';
import {
  bodyOfDownload,
  downloaded,
  DOCUMENT_ID,
  fakePhotoPort,
  ITEM_ID,
  makePhotoDownloadService,
  OTHER_DOCUMENT_ID,
  OTHER_ITEM_ID,
  photo,
  storeResult,
} from './flyer-pro-photo-search.service.testutil';

const START = new Date('2026-11-28T10:00:00Z');
const HOUR = 3_600_000;
const COXAO = 'https://www.extrabom.com.br/img/coxao-mole.jpg';

const refusalOf = (pending: Promise<unknown>) =>
  pending.then(
    () => {
      throw new Error('deveria recusar');
    },
    (e: unknown) => e as HttpException,
  );

describe('FlyerProPhotoDownloadService: download só de resultado guardado do item', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function setup(over: Parameters<typeof makePhotoDownloadService>[0] = {}) {
    const { port } = fakePhotoPort([], { fetchPhoto: jest.fn(async () => downloaded()) });
    return { port, ...makePhotoDownloadService({ port, ...over }) };
  }

  it('foto da busca do item: 200, e a foto baixada é a do endereço do resultado, sem resolver nada', async () => {
    const { service, store, port, registerDownloaded } = setup();
    const r3 = storeResult(store, photo(3, { imageUrl: COXAO }));

    const view = await service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(r3.resultId));

    expect(port.fetchPhoto).toHaveBeenCalledTimes(1);
    expect(port.fetchPhoto).toHaveBeenCalledWith(COXAO);
    expect(port.resolveLink).not.toHaveBeenCalled();
    expect(registerDownloaded).toHaveBeenCalledWith(downloaded(), 'COXÃO MOLE BIFE KG');
    expect(view).toEqual({
      imageUrl: 'http://localhost:3101/uploads/products/foto-1.jpg',
      imageId: 'galeria-1',
      width: 1000,
      height: 1000,
      small: false,
    });
  });

  it('resultado de outro item e de outro encarte: 404 FLYER_PRO_PHOTO_RESULT_NOT_FOUND, sem requisição externa', async () => {
    const { service, store, port, registerDownloaded, findOne } = setup();
    const r3 = storeResult(store, photo(3));

    const otherItem = await refusalOf(
      service.download(DOCUMENT_ID, OTHER_ITEM_ID, bodyOfDownload(r3.resultId)),
    );
    const otherDocument = await refusalOf(
      service.download(OTHER_DOCUMENT_ID, ITEM_ID, bodyOfDownload(r3.resultId)),
    );

    for (const error of [otherItem, otherDocument]) {
      expect(error.getStatus()).toBe(404);
      expect(error.getResponse()).toMatchObject({ code: 'FLYER_PRO_PHOTO_RESULT_NOT_FOUND' });
    }
    expect(findOne).toHaveBeenCalledTimes(2);
    expect(port.fetchPhoto).not.toHaveBeenCalled();
    expect(port.resolveLink).not.toHaveBeenCalled();
    expect(registerDownloaded).not.toHaveBeenCalled();
  });

  it('resultId inventado ou de busca vencida (25 horas): 404, sem requisição externa', async () => {
    const { service, store, port } = setup();
    const old = storeResult(store, photo(3));
    jest.advanceTimersByTime(25 * HOUR);

    const expired = await refusalOf(
      service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(old.resultId)),
    );
    const invented = await refusalOf(service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload('r3')));

    expect([expired.getStatus(), invented.getStatus()]).toEqual([404, 404]);
    expect(port.fetchPhoto).not.toHaveBeenCalled();
  });

  it('resultado de outro termo do mesmo item: a foto baixada é a do primeiro termo', async () => {
    const { service, store, port } = setup();
    const first = storeResult(store, photo(3, { imageUrl: COXAO }));
    storeResult(store, photo(7, { imageUrl: 'https://friboi.com.br/x.jpg' }), {
      term: 'coxão mole friboi',
    });

    await service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(first.resultId));

    expect(port.fetchPhoto).toHaveBeenCalledWith(COXAO);
  });

  it('resultado de antes do reinício, depois de nova busca do item: 404, sem requisição externa', async () => {
    const before = new FlyerProPhotoSearchStore();
    const old = storeResult(before, photo(3));
    jest.advanceTimersByTime(5 * 60_000);
    const after = new FlyerProPhotoSearchStore();
    storeResult(after, photo(7), { term: 'coxão mole friboi' });
    const { service, port } = setup({ store: after });

    const error = await refusalOf(
      service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(old.resultId)),
    );

    expect(error.getResponse()).toMatchObject({ code: 'FLYER_PRO_PHOTO_RESULT_NOT_FOUND' });
    expect(port.fetchPhoto).not.toHaveBeenCalled();
  });

  it('o resultId é conferido à mão: o corpo {} é 400 BAD_REQUEST, antes de ler o encarte', async () => {
    const { service, findOne, port } = setup();

    const error = await refusalOf(service.download(DOCUMENT_ID, ITEM_ID, {} as never));

    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toMatchObject({ code: 'BAD_REQUEST' });
    expect(findOne).not.toHaveBeenCalled();
    expect(port.fetchPhoto).not.toHaveBeenCalled();
  });

  it('encarte inexistente ou excluído: 404 FLYER_PRO_NOT_FOUND, antes de procurar o resultado', async () => {
    const { service, store, port } = setup({ document: null });
    const r3 = storeResult(store, photo(3));

    const error = await refusalOf(
      service.download(DOCUMENT_ID, ITEM_ID, bodyOfDownload(r3.resultId)),
    );

    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toMatchObject({ code: 'FLYER_PRO_NOT_FOUND' });
    expect(port.fetchPhoto).not.toHaveBeenCalled();
  });
});
