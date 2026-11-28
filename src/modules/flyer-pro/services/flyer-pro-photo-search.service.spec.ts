import { HttpException } from '@nestjs/common';
import { captureLogs } from '../providers/flyer-pro-photo-search.testutil';
import {
  bodyOf,
  DOCUMENT_ID,
  failure,
  fakePhotoPort,
  ITEM_ID,
  makePhotoSearchService,
  OTHER_ITEM_ID,
  photo,
  tenPhotos,
} from './flyer-pro-photo-search.service.testutil';

const START = new Date('2026-11-28T10:00:00Z');
const HOUR = 3_600_000;

/** O erro HTTP que o serviço lançou: status e corpo `{ code, message, details }`. */
async function refusalOf(pending: Promise<unknown>) {
  const error = await pending.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpException);
  const http = error as HttpException;
  return { status: http.getStatus(), body: http.getResponse() as Record<string, unknown> };
}

describe('FlyerProPhotoSearchService: a busca (B1)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
    captureLogs();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('primeira página: 10 resultados, page 1, hasMore, fromCache falso e uma busca no provedor', async () => {
    const { port, search } = fakePhotoPort(tenPhotos());
    const { service } = makePhotoSearchService({ port });

    const view = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('COXÃO MOLE BIFE KG', 1));

    expect(view).toMatchObject({
      term: 'COXÃO MOLE BIFE KG',
      page: 1,
      hasMore: true,
      fromCache: false,
    });
    expect(view.results).toHaveLength(10);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith({ term: 'COXÃO MOLE BIFE KG', page: 1 });
  });

  it('página omitida vale 1', async () => {
    const { port, search } = fakePhotoPort();
    const { service } = makePhotoSearchService({ port });

    const view = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('ACÉM COM OSSO KG'));

    expect(view.page).toBe(1);
    expect(search).toHaveBeenCalledWith({ term: 'ACÉM COM OSSO KG', page: 1 });
  });

  it('o resultado sai com resultId, miniatura, tamanho, site, título e small, e sem o endereço da foto', async () => {
    const { port } = fakePhotoPort([photo(1), photo(2, { width: 240, height: 240 })]);
    const { service } = makePhotoSearchService({ port });

    const view = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x'));

    expect(view.results[0]).toEqual({
      resultId: expect.stringMatching(/^r\d+$/),
      thumbnailUrl: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:1',
      width: 1000,
      height: 1000,
      domain: 'extrabom.com.br',
      title: 'Foto 1',
      small: false,
    });
    expect(view.results[1]).toMatchObject({ width: 240, height: 240, small: true });
    expect(JSON.stringify(view)).not.toContain('extrabom.com.br/img');
  });

  it('240 x 240 é pequena, 300 x 300 não, e o menor lado é que conta', async () => {
    const { port } = fakePhotoPort([
      photo(1, { width: 240, height: 240 }),
      photo(2, { width: 300, height: 300 }),
      photo(3, { width: 2000, height: 299 }),
    ]);
    const { service } = makePhotoSearchService({ port });

    const view = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x'));

    expect(view.results.map((r) => r.small)).toEqual([true, false, true]);
  });

  it('foto sem tamanho informado vem com width e height nulos e small falso, sem sair da resposta (D-orq-259)', async () => {
    const { port } = fakePhotoPort([
      photo(1, { width: null, height: null, domain: 'atacadao.com.br' }),
      photo(2),
    ]);
    const { service } = makePhotoSearchService({ port });

    const view = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('ACÉM COM OSSO KG'));

    expect(view.results[0]).toMatchObject({
      width: null,
      height: null,
      small: false,
      domain: 'atacadao.com.br',
    });
    expect(view.results).toHaveLength(2);
  });

  it('thumbnailUrl nulo e título vazio seguem como vieram do provedor', async () => {
    const { port } = fakePhotoPort([photo(1, { thumbnailUrl: null, title: '' })]);
    const { service } = makePhotoSearchService({ port });

    const view = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x'));

    expect(view.results[0]).toMatchObject({ thumbnailUrl: null, title: '' });
  });

  describe('o corpo e o encarte', () => {
    it.each([
      ['corpo {}', {}],
      ['termo só com espaços', { term: '   ' }],
    ])('%s: 400 BAD_REQUEST dos campos ausentes, sem consulta e sem busca', async (_name, body) => {
      const { port, search } = fakePhotoPort();
      const { service, findOne } = makePhotoSearchService({ port });

      const refusal = await refusalOf(service.search(DOCUMENT_ID, ITEM_ID, body as never));

      expect(refusal.status).toBe(400);
      expect(refusal.body).toMatchObject({ code: 'BAD_REQUEST' });
      expect(search).not.toHaveBeenCalled();
      expect(findOne).not.toHaveBeenCalled();
    });

    it('encarte excluído: 404 FLYER_PRO_NOT_FOUND, e nenhuma busca sai', async () => {
      const { port, search } = fakePhotoPort();
      const { service } = makePhotoSearchService({ port, document: null });

      const refusal = await refusalOf(service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x')));

      expect(refusal.status).toBe(404);
      expect(refusal.body).toMatchObject({ code: 'FLYER_PRO_NOT_FOUND' });
      expect(search).not.toHaveBeenCalled();
    });

    it('o item não precisa estar gravado: qualquer itemId do encarte vivo busca', async () => {
      const { service } = makePhotoSearchService();

      await expect(
        service.search(DOCUMENT_ID, '33333333-3333-4333-8333-333333333333', bodyOf('x')),
      ).resolves.toMatchObject({ fromCache: false });
    });
  });

  describe('provedor real sem a chave', () => {
    it('503 FLYER_PRO_PHOTO_SEARCH_UNAVAILABLE com NO_API_KEY, e o provedor nem é chamado', async () => {
      const { port, search } = fakePhotoPort(tenPhotos(), {
        unavailableReason: () => 'NO_API_KEY',
      });
      const { service } = makePhotoSearchService({ port });

      const refusal = await refusalOf(service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x')));

      expect(refusal.status).toBe(503);
      expect(refusal.body).toMatchObject({
        code: 'FLYER_PRO_PHOTO_SEARCH_UNAVAILABLE',
        details: { reason: 'NO_API_KEY' },
      });
      expect(search).not.toHaveBeenCalled();
    });
  });

  describe('resposta guardada', () => {
    it('o mesmo pedido de novo responde da guardada, com fromCache e sem busca', async () => {
      const { port, search } = fakePhotoPort(tenPhotos());
      const { service } = makePhotoSearchService({ port });
      const first = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('COXÃO MOLE BIFE KG'));
      jest.advanceTimersByTime(2 * HOUR);

      const again = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('COXÃO MOLE BIFE KG'));

      expect(again).toEqual({ ...first, fromCache: true });
      expect(search).toHaveBeenCalledTimes(1);
    });

    it('o mesmo termo com outra caixa e espaços: mesmos resultados e o term como o operador mandou, aparado', async () => {
      const { port, search } = fakePhotoPort(tenPhotos());
      const { service } = makePhotoSearchService({ port });
      const first = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('COXÃO MOLE BIFE KG'));

      const again = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('  coxão   mole bife kg '));

      expect(again.results).toEqual(first.results);
      expect(again).toMatchObject({ fromCache: true, term: 'coxão   mole bife kg' });
      expect(search).toHaveBeenCalledTimes(1);
    });

    it('outro termo e outro item saem para o provedor', async () => {
      const { port, search } = fakePhotoPort(tenPhotos());
      const { service } = makePhotoSearchService({ port });
      await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('COXÃO MOLE BIFE KG'));

      await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('coxão mole friboi'));
      await service.search(DOCUMENT_ID, OTHER_ITEM_ID, bodyOf('COXÃO MOLE BIFE KG'));

      expect(search).toHaveBeenCalledTimes(3);
    });

    it('depois de 24 horas e 1 minuto a busca sai de novo, com fromCache falso', async () => {
      const { port, search } = fakePhotoPort(tenPhotos());
      const { service } = makePhotoSearchService({ port });
      await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x'));
      jest.advanceTimersByTime(24 * HOUR + 60_000);

      const again = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x'));

      expect(again.fromCache).toBe(false);
      expect(search).toHaveBeenCalledTimes(2);
    });

    it('a API reiniciada (serviço e memória novos) busca de novo', async () => {
      const { port, search } = fakePhotoPort(tenPhotos());
      await makePhotoSearchService({ port }).service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x'));

      await makePhotoSearchService({ port }).service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x'));

      expect(search).toHaveBeenCalledTimes(2);
    });
  });

  describe('falha da Serper', () => {
    it.each(['TIMEOUT', 'AUTH', 'QUOTA', 'PROVIDER_ERROR'] as const)(
      '%s vira 503 FLYER_PRO_PHOTO_SEARCH_FAILED com o motivo, sem repetir',
      async (reason) => {
        const { port, search } = fakePhotoPort(failure(reason, 502));
        const { service } = makePhotoSearchService({ port });

        const refusal = await refusalOf(service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x')));

        expect(refusal.status).toBe(503);
        expect(refusal.body).toMatchObject({
          code: 'FLYER_PRO_PHOTO_SEARCH_FAILED',
          details: { reason },
        });
        expect(search).toHaveBeenCalledTimes(1);
      },
    );

    it('erro que não é do provedor também é PROVIDER_ERROR', async () => {
      const { port } = fakePhotoPort(new TypeError('bug'));
      const { service } = makePhotoSearchService({ port });

      const refusal = await refusalOf(service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x')));

      expect(refusal.body).toMatchObject({ details: { reason: 'PROVIDER_ERROR' } });
    });

    it('a falha não fica guardada: a busca seguinte sai e a resposta 200 dela fica guardada', async () => {
      let calls = 0;
      const { port, search } = fakePhotoPort(() =>
        ++calls === 1
          ? Promise.reject(failure('PROVIDER_ERROR', 500))
          : Promise.resolve(tenPhotos()),
      );
      const { service } = makePhotoSearchService({ port });
      await refusalOf(service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x')));

      const second = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x'));
      const third = await service.search(DOCUMENT_ID, ITEM_ID, bodyOf('x'));

      expect(second.fromCache).toBe(false);
      expect(third).toEqual({ ...second, fromCache: true });
      expect(search).toHaveBeenCalledTimes(2);
    });
  });
});
