import { HttpException } from '@nestjs/common';
import { captureLogs } from '../providers/flyer-pro-photo-search.testutil';
import {
  bodyOf,
  DOCUMENT_ID,
  failure,
  fakePhotoPort,
  ITEM_ID,
  makePhotoSearchService,
  OTHER_DOCUMENT_ID,
  tenPhotos,
} from './flyer-pro-photo-search.service.testutil';

const START = new Date('2026-11-28T10:00:00Z');
const MINUTE = 60_000;

/** Termos novos, um por busca: cada um sai para o provedor. */
const term = (n: number) => `termo ${n}`;

describe('FlyerProPhotoSearchService: teto de buscas pagas por encarte', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    captureLogs();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  /** Gasta `count` buscas de termo novo, a primeira agora e as outras 1 minuto depois. */
  async function spend(
    service: ReturnType<typeof makePhotoSearchService>['service'],
    count: number,
  ) {
    await service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(0)));
    jest.advanceTimersByTime(MINUTE);
    for (let n = 1; n < count; n++) await service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(n)));
  }

  const refusalOf = (pending: Promise<unknown>) =>
    pending.then(
      () => {
        throw new Error('deveria recusar');
      },
      (e: unknown) => e as HttpException,
    );

  it('busca acima do teto: 429 FLYER_PRO_PHOTO_SEARCH_BUSY com HOURLY_LIMIT e retryAfterSeconds 600, sem chamar', async () => {
    const { port, search } = fakePhotoPort(tenPhotos());
    const { service } = makePhotoSearchService({ port });
    await spend(service, 300);
    jest.advanceTimersByTime(49 * MINUTE);
    expect(search).toHaveBeenCalledTimes(300);

    const error = await refusalOf(service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(999))));

    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({
      code: 'FLYER_PRO_PHOTO_SEARCH_BUSY',
      details: { reason: 'HOURLY_LIMIT', retryAfterSeconds: 600 },
    });
    expect(search).toHaveBeenCalledTimes(300);
  });

  it('o teto é FLYER_PRO_PHOTO_SEARCH_MAX_PER_HOUR: com 2, a terceira busca nova é recusada', async () => {
    const { port, search } = fakePhotoPort(tenPhotos());
    const { service } = makePhotoSearchService({ port, config: { maxPerHour: 2 } });
    await spend(service, 2);

    await refusalOf(service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(2))));

    expect(search).toHaveBeenCalledTimes(2);
  });

  it('a recusa por teto não guarda nada: passada a janela, a mesma busca sai', async () => {
    const { port, search } = fakePhotoPort(tenPhotos());
    const { service } = makePhotoSearchService({ port, config: { maxPerHour: 1 } });
    await service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(0)));
    await refusalOf(service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(1))));
    jest.advanceTimersByTime(60 * MINUTE);

    const view = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(1)));

    expect(view.fromCache).toBe(false);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('resposta guardada com o teto cheio: 200 com fromCache, sem contar', async () => {
    const { port, search } = fakePhotoPort(tenPhotos());
    const { service } = makePhotoSearchService({ port, config: { maxPerHour: 1 } });
    await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('COXÃO MOLE BIFE KG'));

    const again = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('COXÃO MOLE BIFE KG'));

    expect(again.fromCache).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('outro encarte: a busca sai normalmente com o teto cheio no encarte A', async () => {
    const { port, search } = fakePhotoPort(tenPhotos());
    const { service } = makePhotoSearchService({ port, config: { maxPerHour: 1 } });
    await service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(0)));

    await service.search(OTHER_DOCUMENT_ID, ITEM_ID, bodyOf(term(1)));

    expect(search).toHaveBeenCalledTimes(2);
  });
});

describe('FlyerProPhotoSearchService: o que conta no teto de buscas', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    captureLogs();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const busy = async (pending: Promise<unknown>) =>
    (
      await pending.then(
        () => null,
        (e: unknown) => e as HttpException,
      )
    )?.getStatus();

  it('busca que falhou conta: com 299, a que responde 503 PROVIDER_ERROR fecha o teto e a seguinte é 429', async () => {
    let calls = 0;
    const { port, search } = fakePhotoPort(() =>
      ++calls <= 299
        ? Promise.resolve(tenPhotos())
        : Promise.reject(failure('PROVIDER_ERROR', 500)),
    );
    const { service } = makePhotoSearchService({ port });
    for (let n = 0; n < 299; n++) await service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(n)));

    expect(await busy(service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(300))))).toBe(503);
    expect(await busy(service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(301))))).toBe(429);

    expect(search).toHaveBeenCalledTimes(300);
  });

  it('prazo vencido conta: com 299, a TIMEOUT fecha o teto e a seguinte é 429, sem chamar', async () => {
    let calls = 0;
    const { port, search } = fakePhotoPort(() =>
      ++calls <= 299 ? Promise.resolve(tenPhotos()) : Promise.reject(failure('TIMEOUT')),
    );
    const { service } = makePhotoSearchService({ port });
    for (let n = 0; n < 299; n++) await service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(n)));

    expect(await busy(service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(300))))).toBe(503);
    expect(await busy(service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(301))))).toBe(429);

    expect(search).toHaveBeenCalledTimes(300);
  });

  it('pedidos juntados contam uma vez: com 298, os dois da página 2 e um termo novo dão 200 e o seguinte é 429', async () => {
    const { port, search } = fakePhotoPort(tenPhotos());
    const { service } = makePhotoSearchService({ port });
    for (let n = 0; n < 298; n++) await service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(n)));

    const both = await Promise.all([
      service.search(DOCUMENT_ID, ITEM_ID, bodyOf('COXÃO MOLE BIFE KG', 2)),
      service.search(DOCUMENT_ID, ITEM_ID, bodyOf('COXÃO MOLE BIFE KG', 2)),
    ]);
    const fresh = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(999)));

    expect([...both, fresh].every((view) => view.results.length > 0)).toBe(true);
    expect(search).toHaveBeenCalledTimes(300);
    expect(await busy(service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(1000))))).toBe(429);
  });

  it('a recusa por NO_API_KEY e a por encarte excluído não gastam o teto', async () => {
    const { port } = fakePhotoPort(tenPhotos(), { unavailableReason: () => 'NO_API_KEY' });
    const { service } = makePhotoSearchService({ port, config: { maxPerHour: 1 } });

    for (let n = 0; n < 3; n++) {
      expect(await busy(service.search(DOCUMENT_ID, ITEM_ID, bodyOf(term(n))))).toBe(503);
    }
  });
});
