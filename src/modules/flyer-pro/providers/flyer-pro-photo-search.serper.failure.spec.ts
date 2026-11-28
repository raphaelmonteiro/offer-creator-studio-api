import { PROVIDER_ERROR_FIXTURES } from '../../../shared/providers/__fixtures__/provider-error-bodies';
import { PhotoSearchFailure } from './flyer-pro-photo-search.port';
import { SerperPhotoSearch } from './flyer-pro-photo-search.serper';
import {
  captureLogs,
  jsonReply,
  respondWithHangingBody,
  TEST_SERPER_KEY,
} from './flyer-pro-photo-search.testutil';

const fixture = (status: number) => {
  const found = PROVIDER_ERROR_FIXTURES.find((f) => f.provider === 'serper' && f.status === status);
  if (!found) throw new Error(`sem fixture da Serper com status ${status}`);
  return found;
};

describe('SerperPhotoSearch: falha da busca (uma chamada só, nunca repetida)', () => {
  let fetchSpy: jest.SpyInstance;
  const provider = new SerperPhotoSearch(TEST_SERPER_KEY);
  const query = { term: 'BATATA DOCE ROXA KG', page: 2 };

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch' as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const searchFailure = async (): Promise<PhotoSearchFailure> => {
    const error = await provider.search(query).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PhotoSearchFailure);
    return error as PhotoSearchFailure;
  };

  /** O fetch que só termina quando o controller do provedor aborta (a Serper que não responde). */
  const neverAnswer = () => {
    jest.useFakeTimers();
    const aborted = { signal: undefined as AbortSignal | undefined };
    fetchSpy.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          aborted.signal = init.signal as AbortSignal;
          aborted.signal.addEventListener('abort', () =>
            reject(new Error('This operation was aborted')),
          );
        }),
    );
    return aborted;
  };

  it.each([
    ['401', 401, '{"message":"Unauthorized"}', 'AUTH'],
    ['403 sem chave ou chave inválida (corpo observado)', 403, fixture(403).body, 'AUTH'],
    ['400 saldo acabado (forma provável)', 400, fixture(400).body, 'QUOTA'],
    ['400 insufficient credits', 400, '{"message":"Insufficient credits"}', 'QUOTA'],
    ['402', 402, '', 'QUOTA'],
    [
      '400 outra recusa',
      400,
      '{"message":"Invalid parameters","statusCode":400}',
      'PROVIDER_ERROR',
    ],
    ['422', 422, '{"message":"x"}', 'PROVIDER_ERROR'],
    ['429 limite de taxa', 429, '{"message":"Too many requests"}', 'PROVIDER_ERROR'],
    ['500', 500, '', 'PROVIDER_ERROR'],
    ['502', 502, '', 'PROVIDER_ERROR'],
  ])('%s vira o motivo %s', async (_name, status, body, reason) => {
    fetchSpy.mockResolvedValue(jsonReply(body, status));

    const failure = await searchFailure();

    expect(failure.reason).toBe(reason);
    expect(failure.httpStatus).toBe(status);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('queda de rede antes do prazo é PROVIDER_ERROR, não TIMEOUT', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

    const failure = await searchFailure();

    expect(failure.reason).toBe('PROVIDER_ERROR');
    expect(failure.httpStatus).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sem resposta em 10 s: a requisição é abortada e a falha é TIMEOUT', async () => {
    const aborted = neverAnswer();

    const pending = searchFailure();
    await jest.advanceTimersByTimeAsync(9_999);
    expect(aborted.signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const failure = await pending;

    expect(aborted.signal?.aborted).toBe(true);
    expect(failure.reason).toBe('TIMEOUT');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('o corpo que trava depois dos cabeçalhos: abortado em 10 s e a falha é TIMEOUT (D-orq-267)', async () => {
    jest.useFakeTimers();
    const request = respondWithHangingBody(fetchSpy);

    const pending = searchFailure();
    await jest.advanceTimersByTimeAsync(9_999);
    expect(request.signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const failure = await pending;

    expect(request.signal?.aborted).toBe(true);
    expect(failure.reason).toBe('TIMEOUT');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['objeto sem a lista images', {}],
    ['images que não é lista', { images: 'x' }],
    ['lista na raiz', []],
    ['texto que não é JSON', '<html>erro</html>'],
  ])('resposta 200 fora da forma (%s) é PROVIDER_ERROR', async (_name, body) => {
    fetchSpy.mockResolvedValue(jsonReply(body));

    expect((await searchFailure()).reason).toBe('PROVIDER_ERROR');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  describe('a chave de teste nunca aparece', () => {
    /** O que um chamador (log, erro, URL, corpo) poderia deixar vazar. */
    const expectKeyAbsent = (failure: PhotoSearchFailure, logs: string[]) => {
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(failure.message).not.toContain(TEST_SERPER_KEY);
      expect(String(failure.stack)).not.toContain(TEST_SERPER_KEY);
      expect(logs.join('\n')).not.toContain(TEST_SERPER_KEY);
      expect(url + String(init.body)).not.toContain(TEST_SERPER_KEY);
    };

    it.each([
      ['401', 401, '{"message":"Unauthorized"}'],
      ['402', 402, '{"message":"Payment required"}'],
      ['500', 500, ''],
    ])('falha %s', async (_name, status, body) => {
      const logs = captureLogs();
      fetchSpy.mockResolvedValue(jsonReply(body, status));

      expectKeyAbsent(await searchFailure(), logs());
    });

    it('falha sem responder (prazo)', async () => {
      const logs = captureLogs();
      neverAnswer();

      const pending = searchFailure();
      await jest.advanceTimersByTimeAsync(10_000);

      expectKeyAbsent(await pending, logs());
    });

    it('o controle: a chave de teste está no cabeçalho do pedido', async () => {
      fetchSpy.mockResolvedValue(jsonReply({ images: [] }));

      await provider.search(query);

      expect((fetchSpy.mock.calls[0][1] as RequestInit).headers).toHaveProperty(
        'X-API-KEY',
        TEST_SERPER_KEY,
      );
    });
  });
});
