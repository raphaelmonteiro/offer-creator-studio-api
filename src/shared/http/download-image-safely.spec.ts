import { jpegOf } from '../image/image-fixtures.testutil';
import { downloadImageSafely } from './download-image-safely';
import { imageResponse, fetchFrom } from './download-image-safely.testutil';
import { createPinnedFetch } from './pinned-fetch';
import {
  connectedTo,
  connectionError,
  connectionReply,
  fakeLookup,
  fakeRequest,
  redirectTo,
} from './pinned-fetch.testutil';
import { SafeDownloadError } from './safe-download-error';

const HOST = 'https://www.extrabom.com.br/img/coxao-mole.jpg';

const reasonOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SafeDownloadError);
    return (error as SafeDownloadError).reason;
  }
  throw new Error('não recusou');
};

describe('downloadImageSafely: esquema e credenciais', () => {
  it.each([
    'ftp://exemplo.com/x.jpg',
    'file:///etc/passwd',
    'data:image/png;base64,iVBORw0KGgo=',
    'javascript:alert(1)',
    'https://usuario:senha@exemplo.com/x.jpg',
    'não é uma URL',
  ])('%s: SCHEME, sem requisição', async (url) => {
    const fetch = fetchFrom({});

    expect(await reasonOf(downloadImageSafely(url, { fetch }))).toBe('SCHEME');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('Endereço público comum: baixa a foto, com o tipo e a extensão do conteúdo', async () => {
    const jpeg = await jpegOf(120, 80);
    const fetch = fetchFrom({ [HOST]: imageResponse(jpeg) });

    const image = await downloadImageSafely(HOST, { fetch });

    expect(image).toMatchObject({
      format: 'jpeg',
      width: 120,
      height: 80,
      extension: '.jpg',
      mimeType: 'image/jpeg',
    });
    expect(image.buffer.equals(jpeg)).toBe(true);
  });

  it('a regra a mais do chamador (allowUrl) vale para o primeiro endereço e para cada salto, antes de conectar', async () => {
    const jpeg = await jpegOf(10, 10);
    const allowUrl = jest.fn((url: URL) => {
      if (url.hostname !== 'pixabay.com')
        throw new SafeDownloadError('SCHEME', 'host fora do Pixabay');
    });
    const fetch = fetchFrom({
      'https://pixabay.com/get/a.jpg': () =>
        new Response(null, { status: 302, headers: { location: 'https://exemplo.com/x.jpg' } }),
      'https://pixabay.com/get/ok.jpg': imageResponse(jpeg),
    });

    expect(
      await reasonOf(downloadImageSafely('https://pixabay.com/get/a.jpg', { fetch, allowUrl })),
    ).toBe('SCHEME');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://pixabay.com/get/a.jpg']);
    expect(
      await reasonOf(downloadImageSafely('https://exemplo.com/x.jpg', { fetch, allowUrl })),
    ).toBe('SCHEME');
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      downloadImageSafely('https://pixabay.com/get/ok.jpg', { fetch, allowUrl }),
    ).resolves.toMatchObject({ format: 'jpeg' });
  });
});

describe('downloadImageSafely: endereço conferido (com a conexão simulada, sem soquete)', () => {
  const pinned = (table: Record<string, string[]>, script: Parameters<typeof fakeRequest>[0]) => {
    const lookup = fakeLookup(table);
    const request = fakeRequest(script);
    return { lookup, request, fetch: createPinnedFetch({ lookup, request }) };
  };

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:3001/v1/health',
    'http://localhost/x.jpg',
    'http://[::1]/x.jpg',
    'http://[::ffff:10.0.0.5]/x.jpg',
    'http://chroma_x_postgres:5432/',
  ])('%s: PRIVATE_ADDRESS, sem conexão', async (url) => {
    const { fetch, request } = pinned(
      { localhost: ['127.0.0.1'], chroma_x_postgres: ['172.18.0.2'] },
      () => connectionReply(Buffer.alloc(0)),
    );

    expect(await reasonOf(downloadImageSafely(url, { fetch }))).toBe('PRIVATE_ADDRESS');

    expect(request).not.toHaveBeenCalled();
  });

  it('Redirecionamento para a rede interna: PRIVATE_ADDRESS, e nenhuma conexão sai para 10.0.0.5', async () => {
    const { fetch, request } = pinned({ 'www.extrabom.com.br': ['203.0.113.7'] }, () =>
      redirectTo('http://10.0.0.5/x.jpg'),
    );

    expect(await reasonOf(downloadImageSafely(HOST, { fetch }))).toBe('PRIVATE_ADDRESS');

    expect(connectedTo(request)).toEqual(['203.0.113.7']);
  });

  it('Três saltos e o quarto: baixa no terceiro, e o quarto é TOO_MANY_REDIRECTS', async () => {
    const jpeg = await jpegOf(30, 30);
    const table = { 'a.exemplo.com': ['203.0.113.7'] };
    const chain = (hops: number) => (options: { url: URL }, call: number) =>
      call < hops ? redirectTo(`/hop${call + 1}.jpg`) : connectionReply(jpeg);

    const three = pinned(table, chain(3));
    const four = pinned(table, (options, call) =>
      call < 4 ? redirectTo(`/hop${call + 1}.jpg`) : connectionReply(jpeg),
    );

    await expect(
      downloadImageSafely('https://a.exemplo.com/a.jpg', { fetch: three.fetch }),
    ).resolves.toMatchObject({ width: 30 });
    expect(
      await reasonOf(downloadImageSafely('https://a.exemplo.com/a.jpg', { fetch: four.fetch })),
    ).toBe('TOO_MANY_REDIRECTS');
    expect(four.request).toHaveBeenCalledTimes(4);
  });

  it('Redirecionamento para outro esquema: SCHEME', async () => {
    const { fetch } = pinned({ 'a.exemplo.com': ['203.0.113.7'] }, () =>
      redirectTo('ftp://exemplo.com/x.jpg', 301),
    );

    expect(await reasonOf(downloadImageSafely('https://a.exemplo.com/x.jpg', { fetch }))).toBe(
      'SCHEME',
    );
  });

  it('redirecionamento sem destino: ORIGIN_STATUS', async () => {
    const { fetch } = pinned({ 'a.exemplo.com': ['203.0.113.7'] }, () =>
      connectionReply(Buffer.alloc(0), 302),
    );

    expect(await reasonOf(downloadImageSafely('https://a.exemplo.com/x.jpg', { fetch }))).toBe(
      'ORIGIN_STATUS',
    );
  });

  it('Primeiro endereço conferido fora do ar: baixa do segundo dentro do mesmo prazo, com o nome resolvido uma vez', async () => {
    const jpeg = await jpegOf(60, 40);
    const { fetch, lookup, request } = pinned(
      { 'cdn.exemplo.com': ['203.0.113.7', '198.51.100.20'] },
      (options) =>
        options.address.address === '203.0.113.7'
          ? connectionError('ECONNREFUSED')
          : connectionReply(jpeg),
    );

    const image = await downloadImageSafely('https://cdn.exemplo.com/x.jpg', { fetch });

    expect(image.width).toBe(60);
    expect(connectedTo(request)).toEqual(['203.0.113.7', '198.51.100.20']);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('Faixas de documentação seguem públicas: as três fotos são baixadas', async () => {
    const jpeg = await jpegOf(20, 20);
    for (const address of ['192.0.2.10', '198.51.100.20', '203.0.113.7']) {
      const { fetch } = pinned({ 'fotos.exemplo.com': [address] }, () => connectionReply(jpeg));

      await expect(
        downloadImageSafely('https://fotos.exemplo.com/x.jpg', { fetch }),
      ).resolves.toMatchObject({ format: 'jpeg' });
    }
  });

  it('nome que não resolve e conexão recusada em todos os endereços: NETWORK', async () => {
    const down = pinned({ 'cdn.exemplo.com': ['203.0.113.7'] }, () =>
      connectionError('ECONNREFUSED'),
    );

    expect(
      await reasonOf(downloadImageSafely('https://cdn.exemplo.com/x.jpg', { fetch: down.fetch })),
    ).toBe('NETWORK');
    expect(
      await reasonOf(
        downloadImageSafely('https://nao-existe.exemplo.com/x.jpg', { fetch: down.fetch }),
      ),
    ).toBe('NETWORK');
  });
});
