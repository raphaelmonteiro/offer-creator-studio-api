import type { HttpException } from '@nestjs/common';
import { SerperPhotoSearch } from '../providers/flyer-pro-photo-search.serper';
import {
  captureLogs,
  jsonReply,
  respondWithHangingBody,
  serperImage,
  TEST_SERPER_KEY,
} from '../providers/flyer-pro-photo-search.testutil';
import {
  bodyOf,
  DOCUMENT_ID,
  ITEM_ID,
  makePhotoSearchService,
} from './flyer-pro-photo-search.service.testutil';

/**
 * O corpo da Serper que trava depois dos cabeçalhos (D-orq-267), com o provedor real sobre um `fetch` simulado: o prazo de
 * 10 s cobre a leitura do corpo, e o pedido igual no ar (A-8) não fica preso junto.
 */
describe('FlyerProPhotoSearchService: corpo da Serper que não chega', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    captureLogs();
    fetchSpy = jest.spyOn(global, 'fetch' as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const failureOf = (pending: Promise<unknown>) =>
    pending.then(
      () => {
        throw new Error('deveria falhar');
      },
      (e: unknown) => e as HttpException,
    );

  it('os pedidos iguais juntados falham juntos com TIMEOUT em 10 s, nada fica guardado e o pedido é liberado', async () => {
    const { service, store } = makePhotoSearchService({
      port: new SerperPhotoSearch(TEST_SERPER_KEY),
    });
    respondWithHangingBody(fetchSpy);

    const first = failureOf(service.search(DOCUMENT_ID, ITEM_ID, bodyOf('ACÉM COM OSSO KG')));
    const joined = failureOf(service.search(DOCUMENT_ID, ITEM_ID, bodyOf('acém  com osso kg')));
    await jest.advanceTimersByTimeAsync(9_999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    const errors = await Promise.all([first, joined]);

    expect(errors.map((e) => e.getStatus())).toEqual([503, 503]);
    expect(errors.map((e) => e.getResponse())).toEqual([
      expect.objectContaining({
        code: 'FLYER_PRO_PHOTO_SEARCH_FAILED',
        details: { reason: 'TIMEOUT' },
      }),
      expect.objectContaining({ details: { reason: 'TIMEOUT' } }),
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(store.pageCount).toBe(0);

    // liberado: a busca igual de agora sai de novo para a Serper (não fica presa à promessa que travou) e guarda a página
    fetchSpy.mockImplementation(() => Promise.resolve(jsonReply({ images: [serperImage()] })));
    const again = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('ACÉM COM OSSO KG'));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(again).toMatchObject({ fromCache: false, results: [expect.any(Object)] });
    expect(store.pageCount).toBe(1);
  });

  it('os pedidos juntados contam uma vez só no teto: com o teto em 2, a busca nova seguinte passa e a terceira é 429', async () => {
    const { service } = makePhotoSearchService({
      port: new SerperPhotoSearch(TEST_SERPER_KEY),
      config: { maxPerHour: 2 },
    });
    respondWithHangingBody(fetchSpy);
    const pair = Promise.all([
      failureOf(service.search(DOCUMENT_ID, ITEM_ID, bodyOf('um'))),
      failureOf(service.search(DOCUMENT_ID, ITEM_ID, bodyOf('um'))),
    ]);
    await jest.advanceTimersByTimeAsync(10_000);
    await pair;
    fetchSpy.mockImplementation(() => Promise.resolve(jsonReply({ images: [serperImage()] })));

    await expect(service.search(DOCUMENT_ID, ITEM_ID, bodyOf('dois'))).resolves.toMatchObject({
      fromCache: false,
    });
    const refused = await failureOf(service.search(DOCUMENT_ID, ITEM_ID, bodyOf('tres')));

    expect(refused.getStatus()).toBe(429);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
