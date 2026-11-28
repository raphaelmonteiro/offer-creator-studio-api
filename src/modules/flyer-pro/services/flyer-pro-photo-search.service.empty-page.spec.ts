import type { HttpException } from '@nestjs/common';
import { SerperPhotoSearch } from '../providers/flyer-pro-photo-search.serper';
import {
  captureLogs,
  jsonReply,
  TEST_SERPER_KEY,
} from '../providers/flyer-pro-photo-search.testutil';
import {
  bodyOf,
  DOCUMENT_ID,
  ITEM_ID,
  makePhotoSearchService,
} from './flyer-pro-photo-search.service.testutil';

const TERM = 'TERMO SEM RESULTADO XYZ';

/** A resposta 200 da Serper sem a lista `images` é página vazia, e não erro (D-orq-268), com o provedor real e o `fetch` simulado. */
describe('FlyerProPhotoSearchService: página vazia da Serper', () => {
  let fetchSpy: jest.SpyInstance;
  let logs: () => string[];

  beforeEach(() => {
    logs = captureLogs();
    fetchSpy = jest.spyOn(global, 'fetch' as never);
  });
  afterEach(() => jest.restoreAllMocks());

  const serviceOverSerper = () =>
    makePhotoSearchService({ port: new SerperPhotoSearch(TEST_SERPER_KEY) });

  it.each([
    ['objeto sem a lista images', {}],
    ['images vazia', { images: [] }],
  ])('%s: 0 resultados, hasMore false, guardada como qualquer página', async (_name, body) => {
    fetchSpy.mockImplementation(() => Promise.resolve(jsonReply(body)));
    const { service, store } = serviceOverSerper();

    const first = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf(TERM));
    const second = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf(TERM));

    expect(first).toMatchObject({ results: [], hasMore: false, fromCache: false, page: 1 });
    expect(second).toMatchObject({ results: [], hasMore: false, fromCache: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(store.pageCount).toBe(1);
  });

  it('o aviso "resposta sem a lista images" só sai quando a lista falta, sem o termo e sem a chave', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(jsonReply({})));
    const { service } = serviceOverSerper();

    await service.search(DOCUMENT_ID, ITEM_ID, bodyOf(TERM));

    const text = logs().join('\n');
    expect(text).toContain('Busca de fotos no Google: resposta sem a lista images');
    expect(text).not.toContain(TERM);
    expect(text).not.toContain(TEST_SERPER_KEY);
  });

  it('images que não é lista segue PROVIDER_ERROR: 503, nada guardado, e cada tentativa sai de novo (e conta no teto)', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(jsonReply({ images: 'x' })));
    const { service, store } = serviceOverSerper();
    const attempt = () =>
      service.search(DOCUMENT_ID, ITEM_ID, bodyOf(TERM)).then(
        () => {
          throw new Error('deveria falhar');
        },
        (e: unknown) => e as HttpException,
      );

    const errors = [await attempt(), await attempt()];

    expect(errors.map((e) => e.getStatus())).toEqual([503, 503]);
    expect(errors[0].getResponse()).toMatchObject({ details: { reason: 'PROVIDER_ERROR' } });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(store.pageCount).toBe(0);
  });
});
