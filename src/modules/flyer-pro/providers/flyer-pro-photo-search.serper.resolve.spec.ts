import * as downloadModule from '../../../shared/http/download-image-safely';
import { PhotoLinkResolveFailure } from './flyer-pro-photo-search.port';
import { SerperPhotoSearch } from './flyer-pro-photo-search.serper';
import { captureLogs, jsonReply, TEST_SERPER_KEY } from './flyer-pro-photo-search.testutil';

const RESOLVE_URL = 'https://google.serper.dev/resolve';
const GOTO = 'https://www.google.com/goto?url=CAESYwHr';
const REAL = 'https://pomarbrasilia.com.br/banana-nanica.jpg';

describe('SerperPhotoSearch: a chave, a resolução do link e o download', () => {
  let fetchSpy: jest.SpyInstance;
  const provider = new SerperPhotoSearch(TEST_SERPER_KEY);

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch' as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const resolveFailure = async () => {
    const error = await provider.resolveLink(GOTO).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PhotoLinkResolveFailure);
    return error as PhotoLinkResolveFailure;
  };

  describe('sem a chave', () => {
    it.each([
      ['ausente', undefined],
      ['vazia', ''],
    ])('chave %s: NO_API_KEY', (_name, key) => {
      expect(new SerperPhotoSearch(key).unavailableReason()).toBe('NO_API_KEY');
    });

    it('com a chave: disponível', () => {
      expect(provider.unavailableReason()).toBeNull();
    });
  });

  describe('resolveLink', () => {
    it('POST em /resolve com a chave só no cabeçalho e o link no corpo mínimo; devolve images[0].imageUrl', async () => {
      fetchSpy.mockResolvedValue(jsonReply({ images: [{ imageUrl: REAL }] }));

      await expect(provider.resolveLink(GOTO)).resolves.toBe(REAL);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(RESOLVE_URL);
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        'X-API-KEY': TEST_SERPER_KEY,
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(init.body as string)).toEqual({ images: [{ imageUrl: GOTO }] });
      expect(url + String(init.body)).not.toContain(TEST_SERPER_KEY);
    });

    it.each([
      ['500', () => jsonReply('', 500)],
      ['403', () => jsonReply('{"message":"Unauthorized"}', 403)],
      ['429', () => jsonReply('{"message":"slow down"}', 429)],
      ['o mesmo link de volta', () => jsonReply({ images: [{ imageUrl: GOTO }] })],
      [
        'o mesmo link e retryAfter',
        () => jsonReply({ images: [{ imageUrl: GOTO }], retryAfter: 20 }),
      ],
      [
        'endereço real com retryAfter',
        () => jsonReply({ images: [{ imageUrl: REAL }], retryAfter: 5 }),
      ],
      ['objeto vazio', () => jsonReply({})],
      ['lista de imagens vazia', () => jsonReply({ images: [] })],
      [
        'outro link do Google',
        () => jsonReply({ images: [{ imageUrl: 'https://www.google.com/goto?url=OUTRO' }] }),
      ],
      ['esquema ftp', () => jsonReply({ images: [{ imageUrl: 'ftp://exemplo.com/x.jpg' }] })],
      ['texto que não é URL', () => jsonReply({ images: [{ imageUrl: 'foto' }] })],
      ['texto que não é JSON', () => jsonReply('<html>erro</html>')],
    ])('%s vira PhotoLinkResolveFailure, com uma requisição só', async (_name, reply) => {
      fetchSpy.mockResolvedValue(reply());

      await resolveFailure();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('queda de rede vira PhotoLinkResolveFailure', async () => {
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      await resolveFailure();
    });

    it('sem resposta em 10 s: abortada, falha sem esperar nem repetir, e a chave fica fora do log e da mensagem', async () => {
      jest.useFakeTimers();
      const logs = captureLogs();
      let signal: AbortSignal | undefined;
      fetchSpy.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            signal = init.signal as AbortSignal;
            signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
          }),
      );

      const pending = resolveFailure();
      await jest.advanceTimersByTimeAsync(10_000);
      const failure = await pending;

      expect(signal?.aborted).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(failure.message + String(failure.stack) + logs().join('\n')).not.toContain(
        TEST_SERPER_KEY,
      );
    });
  });

  describe('fetchPhoto', () => {
    it('baixa pelo download seguro, só com o endereço (as regras e os limites são os dele)', async () => {
      const downloaded = { buffer: Buffer.from('x') } as downloadModule.DownloadedImage;
      const download = jest
        .spyOn(downloadModule, 'downloadImageSafely')
        .mockResolvedValue(downloaded);

      await expect(provider.fetchPhoto(REAL)).resolves.toBe(downloaded);

      expect(download).toHaveBeenCalledWith(REAL);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
