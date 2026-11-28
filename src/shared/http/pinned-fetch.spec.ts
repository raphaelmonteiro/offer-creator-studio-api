import { Readable } from 'node:stream';
import { DOWNLOAD_USER_AGENT, createPinnedFetch } from './pinned-fetch';
import {
  connectedTo,
  connectionError,
  connectionReply,
  fakeLookup,
  fakeRequest,
} from './pinned-fetch.testutil';

const signal = () => new AbortController().signal;
const fetchWith = (
  table: Record<string, string[]>,
  script: Parameters<typeof fakeRequest>[0] = () => connectionReply(Buffer.from('ok')),
) => {
  const lookup = fakeLookup(table);
  const request = fakeRequest(script);
  return { lookup, request, fetch: createPinnedFetch({ lookup, request }) };
};
const get = (fetch: ReturnType<typeof createPinnedFetch>, url: string, s = signal()) =>
  fetch(url, { signal: s, redirect: 'manual' });

describe('createPinnedFetch: a conexão vai ao endereço conferido', () => {
  it('conecta ao IP resolvido e leva o nome no Host, sem consultar o nome de novo', async () => {
    const { fetch, lookup, request } = fetchWith({ 'cdn.exemplo.com': ['203.0.113.7'] });

    const res = await get(fetch, 'https://cdn.exemplo.com/img/a.jpg?v=2');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(lookup).toHaveBeenCalledTimes(1);
    const [options] = request.mock.calls[0];
    expect(options.address).toEqual({ address: '203.0.113.7', family: 4 });
    expect(options.url.href).toBe('https://cdn.exemplo.com/img/a.jpg?v=2');
    expect(options.headers.host).toBe('cdn.exemplo.com');
  });

  it('Nome que muda de endereço entre a conferência e a conexão: vai a 203.0.113.7, e nada sai para 127.0.0.1', async () => {
    const lookup = jest
      .fn()
      .mockResolvedValueOnce([{ address: '203.0.113.7', family: 4 }])
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const request = fakeRequest(() => connectionReply(Buffer.from('ok')));
    const fetch = createPinnedFetch({ lookup, request });

    await get(fetch, 'https://troca.exemplo.com/x.jpg');

    expect(connectedTo(request)).toEqual(['203.0.113.7']);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('o Host leva a porta quando ela não é a padrão', async () => {
    const { fetch, request } = fetchWith({ 'cdn.exemplo.com': ['203.0.113.7'] });

    await get(fetch, 'http://cdn.exemplo.com:8080/x.jpg');

    expect(request.mock.calls[0][0].headers.host).toBe('cdn.exemplo.com:8080');
  });

  it('cabeçalhos do pedido: sem compressão, accept de imagem, user-agent sem nome nem domínio do dono', async () => {
    const { fetch, request } = fetchWith({ 'cdn.exemplo.com': ['203.0.113.7'] });

    await get(fetch, 'https://cdn.exemplo.com/x.jpg');

    const { headers } = request.mock.calls[0][0];
    expect(headers['accept-encoding']).toBe('identity');
    expect(headers.accept).toMatch(/^image\/avif,image\/webp,image\/\*/);
    expect(headers['user-agent']).toBe('Mozilla/5.0 (compatible; Chroma/1.0)');
    expect(DOWNLOAD_USER_AGENT).toBe(headers['user-agent']);
    expect(headers.connection).toBe('close');
  });

  it.each([
    ['http://169.254.169.254/latest/meta-data/', {}],
    ['http://127.0.0.1:3001/v1/health', {}],
    ['http://localhost/x.jpg', { localhost: ['127.0.0.1', '::1'] }],
    ['http://[::1]/x.jpg', {}],
    ['http://chroma_x_postgres:5432/', { chroma_x_postgres: ['172.18.0.2'] }],
    ['https://fotos.exemplo.com/x.jpg', { 'fotos.exemplo.com': ['192.168.0.10'] }],
    ['https://cdn.exemplo.com/x.jpg', { 'cdn.exemplo.com': ['203.0.113.7', '10.0.0.5'] }],
    ['http://[::ffff:10.0.0.5]/x.jpg', {}],
    ['http://[::10.0.0.5]/x.jpg', {}],
    ['http://[64:ff9b::a00:5]/x.jpg', {}],
    ['http://[64:ff9b:1::a00:5]/x.jpg', {}],
    ['http://[fec0::1]/x.jpg', {}],
    ['http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/x.jpg', {}],
    ['http://[2002:a00:5::1]/x.jpg', {}],
    ['http://[ff02::1]/x.jpg', {}],
    ['https://fotos.exemplo.com/x.jpg', { 'fotos.exemplo.com': ['64:ff9b::a00:5'] }],
  ])('endereço interno %s: PRIVATE_ADDRESS, nenhuma conexão', async (url, table) => {
    const { fetch, request } = fetchWith(table);

    await expect(get(fetch, url)).rejects.toMatchObject({ reason: 'PRIVATE_ADDRESS' });

    expect(request).not.toHaveBeenCalled();
  });

  it('Faixas de documentação seguem públicas: cada nome conecta ao seu endereço', async () => {
    const { fetch, request } = fetchWith({
      'a.exemplo.com': ['192.0.2.10'],
      'b.exemplo.com': ['198.51.100.20'],
      'c.exemplo.com': ['203.0.113.7'],
    });

    for (const host of ['a', 'b', 'c']) await get(fetch, `https://${host}.exemplo.com/x.jpg`);

    expect(connectedTo(request)).toEqual(['192.0.2.10', '198.51.100.20', '203.0.113.7']);
  });
});

describe('createPinnedFetch: mais de um endereço conferido', () => {
  it('Primeiro endereço conferido fora do ar: a conexão seguinte vai ao outro, com o nome resolvido uma vez', async () => {
    const { fetch, lookup, request } = fetchWith(
      { 'cdn.exemplo.com': ['203.0.113.7', '198.51.100.20'] },
      (options) =>
        options.address.address === '203.0.113.7'
          ? connectionError('ECONNREFUSED')
          : connectionReply(Buffer.from('jpeg')),
    );

    const res = await get(fetch, 'https://cdn.exemplo.com/x.jpg');

    expect(await res.text()).toBe('jpeg');
    expect(connectedTo(request)).toEqual(['203.0.113.7', '198.51.100.20']);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('IPv4 primeiro; sem rota IPv6 (ENETUNREACH) no fim da lista, o erro sai', async () => {
    const { fetch, request } = fetchWith(
      { 'dual.exemplo.com': ['2606:4700::1', '203.0.113.7'] },
      () => connectionError('ENETUNREACH'),
    );

    await expect(get(fetch, 'https://dual.exemplo.com/x.jpg')).rejects.toMatchObject({
      code: 'ENETUNREACH',
    });

    expect(connectedTo(request)).toEqual(['203.0.113.7', '2606:4700::1']);
  });

  it.each(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'])(
    'erro de conexão %s passa ao próximo endereço',
    async (code) => {
      const { fetch, request } = fetchWith(
        { 'cdn.exemplo.com': ['203.0.113.7', '198.51.100.20'] },
        (_options, call) =>
          call === 0 ? connectionError(code) : connectionReply(Buffer.from('ok')),
      );

      await get(fetch, 'https://cdn.exemplo.com/x.jpg');

      expect(connectedTo(request)).toHaveLength(2);
    },
  );

  it('erro que não é de conexão (certificado, reset) não tenta o próximo endereço', async () => {
    const { fetch, request } = fetchWith(
      { 'cdn.exemplo.com': ['203.0.113.7', '198.51.100.20'] },
      () => connectionError('CERT_HAS_EXPIRED'),
    );

    await expect(get(fetch, 'https://cdn.exemplo.com/x.jpg')).rejects.toMatchObject({
      code: 'CERT_HAS_EXPIRED',
    });

    expect(connectedTo(request)).toEqual(['203.0.113.7']);
  });

  it('prazo esgotado no meio: não tenta o próximo endereço', async () => {
    const controller = new AbortController();
    const { fetch, request } = fetchWith(
      { 'cdn.exemplo.com': ['203.0.113.7', '198.51.100.20'] },
      () => {
        controller.abort();
        return connectionError('ETIMEDOUT');
      },
    );

    await expect(
      get(fetch, 'https://cdn.exemplo.com/x.jpg', controller.signal),
    ).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });

    expect(connectedTo(request)).toEqual(['203.0.113.7']);
  });
});

describe('createPinnedFetch: a resposta', () => {
  it('leva status e cabeçalhos (inclusive os repetidos) e não segue redirecionamento', async () => {
    const { fetch } = fetchWith({ 'a.exemplo.com': ['203.0.113.7'] }, () =>
      Object.assign(connectionReply(Buffer.alloc(0), 302, { location: 'http://10.0.0.5/x.jpg' }), {
        headers: { location: 'http://10.0.0.5/x.jpg', 'set-cookie': ['a=1', 'b=2'] },
      }),
    );

    const res = await get(fetch, 'https://a.exemplo.com/x.jpg');

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://10.0.0.5/x.jpg');
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });

  it('status sem corpo (304) vira Response sem corpo e consome o stream', async () => {
    const stream = Readable.from([]);
    const { fetch } = fetchWith({ 'a.exemplo.com': ['203.0.113.7'] }, () =>
      connectionReply(stream, 304),
    );

    const res = await get(fetch, 'https://a.exemplo.com/x.jpg');

    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    await new Promise((resolve) => stream.once('end', resolve));
  });

  it('nome que não resolve: erro de rede do resolvedor, sem conexão', async () => {
    const { fetch, request } = fetchWith({});

    await expect(get(fetch, 'https://nao-existe.exemplo.com/x.jpg')).rejects.toMatchObject({
      reason: 'NETWORK',
    });
    expect(request).not.toHaveBeenCalled();
  });
});
