import { ConfigService } from '@nestjs/config';
import { FalQueueClient } from './fal-queue.client';
import { TerminalProviderError, TransientProviderError } from './provider-errors';

/**
 * HTTP mockado via jest.spyOn(global.fetch) — o repo não usa nock (não está
 * no package.json); specs aqui são unit puros e o fetch nativo é o único
 * ponto de saída HTTP do cliente.
 */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('FalQueueClient — cliente genérico da fila fal (plano §5.2)', () => {
  const config = { get: jest.fn().mockReturnValue('fal-test-key') } as unknown as ConfigService;
  let client: FalQueueClient;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    client = new FalQueueClient(config);
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => fetchSpy.mockRestore());

  it('submit envia Authorization: Key e devolve requestId + URLs da resposta', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        request_id: 'req-1',
        status_url: 'https://queue.fal.run/fal-ai/kling/requests/req-1/status',
        response_url: 'https://queue.fal.run/fal-ai/kling/requests/req-1',
      }),
    );
    const result = await client.submit('fal-ai/kling', { prompt: 'p' });

    expect(result).toEqual({
      requestId: 'req-1',
      statusUrl: 'https://queue.fal.run/fal-ai/kling/requests/req-1/status',
      responseUrl: 'https://queue.fal.run/fal-ai/kling/requests/req-1',
    });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://queue.fal.run/fal-ai/kling');
    expect((init.headers as Record<string, string>).Authorization).toBe('Key fal-test-key');
    expect(JSON.parse(String(init.body))).toEqual({ prompt: 'p' });
  });

  it('submit monta as URLs a partir do request_id quando a resposta não as traz', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { request_id: 'req-2' }));
    const result = await client.submit('fal-ai/seedance', {});
    expect(result.statusUrl).toBe('https://queue.fal.run/fal-ai/seedance/requests/req-2/status');
    expect(result.responseUrl).toBe('https://queue.fal.run/fal-ai/seedance/requests/req-2');
  });

  it('submit sem request_id na resposta → erro de validação terminal', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, {}));
    await expect(client.submit('fal-ai/kling', {})).rejects.toMatchObject({
      code: 'invalid_provider_output',
    });
  });

  it('status faz o parse dos três estados documentados', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { status: 'IN_QUEUE', queue_position: 3 }));
    await expect(client.status('https://queue.fal.run/x/requests/1/status')).resolves.toEqual({
      status: 'IN_QUEUE',
      queuePosition: 3,
    });

    fetchSpy.mockResolvedValue(jsonResponse(200, { status: 'COMPLETED' }));
    await expect(client.status('https://queue.fal.run/x/requests/1/status')).resolves.toEqual({
      status: 'COMPLETED',
      queuePosition: undefined,
    });
  });

  it('status desconhecido → erro de validação terminal (nunca fica em loop de poll)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { status: 'EXPLODED' }));
    await expect(client.status('https://u')).rejects.toMatchObject({
      code: 'invalid_provider_output',
    });
  });

  it('result devolve o JSON cru; resultVideoUrl extrai video.url', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { video: { url: 'https://cdn/v.mp4' } }));
    await expect(client.resultVideoUrl('https://queue.fal.run/x/requests/1')).resolves.toBe(
      'https://cdn/v.mp4',
    );
  });

  it('COMPLETED sem vídeo = erro de VALIDAÇÃO terminal, nunca retry', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { detail: 'ok mas sem video' }));
    const promise = client.resultVideoUrl('https://queue.fal.run/x/requests/1');
    await expect(promise).rejects.toBeInstanceOf(TerminalProviderError);
    await promise.catch((err: TerminalProviderError) => {
      expect(err.code).toBe('invalid_provider_output');
      expect(err.message).toMatch(/video\.url/);
    });
  });

  it('classificação herdada do http-provider.base: 5xx transiente, 4xx terminal', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(500, {}));
    await expect(client.status('https://u')).rejects.toBeInstanceOf(TransientProviderError);

    fetchSpy.mockResolvedValue(jsonResponse(400, { error: 'bad input' }));
    await expect(client.status('https://u')).rejects.toBeInstanceOf(TerminalProviderError);
  });
});
