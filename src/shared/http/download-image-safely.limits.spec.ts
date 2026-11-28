import { jpegOf, paddedTo } from '../image/image-fixtures.testutil';
import { downloadImageSafely, DOWNLOAD_TIMEOUT_MS } from './download-image-safely';
import { chunkedBody, fetchFrom, imageResponse } from './download-image-safely.testutil';
import { createPinnedFetch } from './pinned-fetch';
import { connectionReply, fakeLookup, fakeRequest } from './pinned-fetch.testutil';

const URL_OF = 'https://www.extrabom.com.br/img/x.jpg';
const MB = 1024 * 1024;

const download = (response: Response | (() => Response), timeoutMs?: number) =>
  downloadImageSafely(URL_OF, { fetch: fetchFrom({ [URL_OF]: response }), timeoutMs });

describe('downloadImageSafely: teto de 10 MB', () => {
  it('Tamanho declarado acima do teto: TOO_LARGE sem ler o corpo', async () => {
    const { body, seen } = chunkedBody(12 * MB, MB);

    await expect(
      download(
        imageResponse(body, { 'content-type': 'image/jpeg', 'content-length': String(12 * MB) }),
      ),
    ).rejects.toMatchObject({ reason: 'TOO_LARGE' });

    expect(seen.pulled).toBe(0);
    expect(seen.cancelled).toBe(true);
  });

  it('Tamanho não declarado acima do teto: a leitura para logo depois de 10 MB e é TOO_LARGE', async () => {
    const { body, seen } = chunkedBody(12 * MB, MB);

    await expect(download(imageResponse(body))).rejects.toMatchObject({ reason: 'TOO_LARGE' });

    expect(seen.pulled).toBe(11);
    expect(seen.cancelled).toBe(true);
  });

  it('Exatamente 10 MB: um JPEG de 10 485 760 bytes é gravado, e com um byte a mais é TOO_LARGE', async () => {
    const jpeg = await jpegOf(300, 200);

    const exact = await download(imageResponse(paddedTo(jpeg, 10 * MB)));

    expect(exact.buffer).toHaveLength(10_485_760);
    await expect(download(imageResponse(paddedTo(jpeg, 10 * MB + 1)))).rejects.toMatchObject({
      reason: 'TOO_LARGE',
    });
  });
});

describe('downloadImageSafely: prazo de 30 s no total', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('Origem lenta: o corpo que passa de 30 s desiste com TIMEOUT aos 30 s', async () => {
    const jpeg = await jpegOf(100, 100);
    const slow = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(jpeg.subarray(0, 100)));
      },
    });
    const outcome = download(imageResponse(slow)).catch((error) => error);

    await jest.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS - 1);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1);

    expect(await outcome).toMatchObject({ reason: 'TIMEOUT' });
    expect(DOWNLOAD_TIMEOUT_MS).toBe(30_000);
  });

  it('o prazo vale também para a resolução do nome, que nada cancela', async () => {
    const lookup = jest.fn(() => new Promise<never>(() => undefined));
    const fetch = createPinnedFetch({
      lookup,
      request: fakeRequest(() => connectionReply(Buffer.alloc(0))),
    });
    const outcome = downloadImageSafely(URL_OF, { fetch }).catch((error) => error);

    await jest.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS);

    expect(await outcome).toMatchObject({ reason: 'TIMEOUT' });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('o prazo vale na conexão: a resposta que não chega dentro dos 30 s é TIMEOUT', async () => {
    const lookup = fakeLookup({ 'www.extrabom.com.br': ['203.0.113.7'] });
    const request = jest.fn(() => new Promise<never>(() => undefined));
    const fetch = createPinnedFetch({ lookup, request });
    const outcome = downloadImageSafely(URL_OF, { fetch }).catch((error) => error);

    await jest.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS);

    expect(await outcome).toMatchObject({ reason: 'TIMEOUT' });
  });

  it('download que termina limpa o relógio: nenhum temporizador fica pendente', async () => {
    await download(imageResponse(await jpegOf(10, 10)));

    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('downloadImageSafely: a origem falha', () => {
  it.each([404, 403, 500, 502])('a origem responde %s: ORIGIN_STATUS', async (status) => {
    await expect(download(new Response('erro', { status }))).rejects.toMatchObject({
      reason: 'ORIGIN_STATUS',
    });
  });

  it('a conexão cai no meio do corpo: NETWORK', async () => {
    const dropped = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
      },
    });

    await expect(download(imageResponse(dropped))).rejects.toMatchObject({
      reason: 'NETWORK',
      message: 'falha de rede (ECONNRESET)',
    });
  });

  it('a URL e a consulta nunca vão na mensagem do erro', async () => {
    const url = 'https://www.extrabom.com.br/x.jpg?token=segredo-da-origem';
    const fetch = fetchFrom({ [url]: new Response('erro', { status: 404 }) });

    const error = await downloadImageSafely(url, { fetch }).catch((e) => e);

    expect(error.message).not.toContain('segredo-da-origem');
  });
});
