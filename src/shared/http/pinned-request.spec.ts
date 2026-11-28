import { EventEmitter } from 'node:events';
import type { PinnedRequestOptions } from './pinned-request';

const mockHttp = jest.fn();
const mockHttps = jest.fn();
jest.mock('node:http', () => ({ request: (...args: unknown[]) => mockHttp(...args) }));
jest.mock('node:https', () => ({ request: (...args: unknown[]) => mockHttps(...args) }));

import { nodeRequest } from './pinned-request';

/** `ClientRequest` de mentira: `end()` entrega a resposta (ou o erro) e nada abre soquete. */
function fakeClientRequest(outcome: { reply?: object; error?: Error }) {
  return (_options: unknown, onResponse: (reply: object) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      if (outcome.error) req.emit('error', outcome.error);
      else onResponse(outcome.reply);
    };
    return req;
  };
}

const optionsFor = (
  url: string,
  address: PinnedRequestOptions['address'],
): PinnedRequestOptions => ({
  url: new URL(url),
  address,
  headers: { host: new URL(url).host },
  signal: new AbortController().signal,
});

describe('nodeRequest: as opções que o Node recebe', () => {
  beforeEach(() => {
    mockHttp.mockReset();
    mockHttps.mockReset();
  });

  it('https: host é o IP conferido, servername e Host são o nome, agent false, sem resolver o nome', async () => {
    const reply = { statusCode: 200 };
    mockHttps.mockImplementation(fakeClientRequest({ reply }));
    const options = optionsFor('https://cdn.exemplo.com/img/a.jpg?v=2', {
      address: '203.0.113.7',
      family: 4,
    });

    expect(await nodeRequest(options)).toBe(reply);

    expect(mockHttp).not.toHaveBeenCalled();
    expect(mockHttps.mock.calls[0][0]).toMatchObject({
      host: '203.0.113.7',
      port: 443,
      path: '/img/a.jpg?v=2',
      method: 'GET',
      agent: false,
      servername: 'cdn.exemplo.com',
      headers: { host: 'cdn.exemplo.com' },
      signal: options.signal,
    });
  });

  it('http com porta e IPv6: porta da URL, host é o endereço sem colchetes, sem servername', async () => {
    mockHttp.mockImplementation(fakeClientRequest({ reply: {} }));

    await nodeRequest(
      optionsFor('http://cdn.exemplo.com:8080/x.jpg', { address: '2606:4700::1', family: 6 }),
    );

    const [options] = mockHttp.mock.calls[0];
    expect(options).toMatchObject({
      host: '2606:4700::1',
      port: 8080,
      path: '/x.jpg',
      agent: false,
    });
    expect(options.servername).toBeUndefined();
  });

  it('https para um endereço escrito na URL: o SNI não é um IP (o certificado é conferido contra o endereço)', async () => {
    mockHttps.mockImplementation(fakeClientRequest({ reply: {} }));

    await nodeRequest(
      optionsFor('https://203.0.113.7/x.jpg', { address: '203.0.113.7', family: 4 }),
    );
    await nodeRequest(
      optionsFor('https://[2606:4700::1]/x.jpg', { address: '2606:4700::1', family: 6 }),
    );

    expect(mockHttps.mock.calls[0][0].servername).toBeUndefined();
    expect(mockHttps.mock.calls[1][0].servername).toBeUndefined();
  });

  it('erro da conexão rejeita com o próprio erro (o código chega a quem decide o próximo endereço)', async () => {
    const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    mockHttps.mockImplementation(fakeClientRequest({ error }));

    await expect(
      nodeRequest(
        optionsFor('https://cdn.exemplo.com/x.jpg', { address: '203.0.113.7', family: 4 }),
      ),
    ).rejects.toBe(error);
  });
});
