import { ConfigService } from '@nestjs/config';
import { ElevenLabsProvider, isPreRequestNetworkError } from './elevenlabs.provider';
import { TerminalProviderError } from './provider-errors';

describe('ElevenLabsProvider.synthesizeWithTimestamps — contexto de prosódia (previous_text/next_text)', () => {
  let fetchSpy: jest.SpyInstance;
  let provider: ElevenLabsProvider;

  beforeEach(() => {
    provider = new ElevenLabsProvider({ get: () => 'key' } as unknown as ConfigService);
    fetchSpy = jest.spyOn(global, 'fetch' as never).mockImplementation(
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              audio_base64: Buffer.from('mp3').toString('base64'),
              alignment: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ) as never,
    );
  });

  afterEach(() => fetchSpy.mockRestore());

  function sentBody(): Record<string, unknown> {
    const init = fetchSpy.mock.calls[0][1] as { body: string };
    return JSON.parse(init.body) as Record<string, unknown>;
  }

  it('envia previous_text/next_text só quando informados (e não vazios)', async () => {
    const result = await provider.synthesizeWithTimestamps({
      text: 'Fala do meio.',
      voiceId: 'v1',
      previousText: 'Fala anterior.',
      nextText: 'Fala seguinte.',
    });
    expect(result.audio.toString()).toBe('mp3');
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/v1/with-timestamps',
    );
    expect(sentBody()).toMatchObject({
      text: 'Fala do meio.',
      previous_text: 'Fala anterior.',
      next_text: 'Fala seguinte.',
    });
  });

  it('sem contexto, o corpo é o de antes (compatível com o módulo de animações)', async () => {
    await provider.synthesizeWithTimestamps({
      text: 'Só uma fala.',
      voiceId: 'v1',
      nextText: '  ',
    });
    const body = sentBody();
    expect(body).not.toHaveProperty('previous_text');
    expect(body).not.toHaveProperty('next_text');
    expect(body).toMatchObject({ text: 'Só uma fala.', model_id: 'eleven_multilingual_v2' });
  });
});

describe('ElevenLabsProvider — TTS sem geração paga em dobro (achado 2 da 3.7)', () => {
  let fetchSpy: jest.SpyInstance;
  let provider: ElevenLabsProvider;
  const env: Record<string, string> = { ELEVENLABS_API_KEY: 'key' };
  const ok = () =>
    new Response(JSON.stringify({ audio_base64: Buffer.from('mp3').toString('base64') }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  const fetchFailed = (code: string) =>
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(code), { code }),
    });
  const call = () => provider.synthesizeWithTimestamps({ text: 'Olá!', voiceId: 'v1' });

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    provider = new ElevenLabsProvider({ get: (k: string) => env[k] } as unknown as ConfigService);
    jest
      .spyOn((provider as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    fetchSpy = jest.spyOn(global, 'fetch' as never);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    jest.useRealTimers();
    delete env.ELEVENLABS_TTS_TIMEOUT_MS;
  });

  /** Roda a chamada avançando os timers do backoff do withRetry. */
  async function settle<T>(promise: Promise<T>): Promise<T> {
    const guarded = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(5_000);
    const result = (await guarded) as { value?: T; error?: unknown };
    if ('error' in result) throw result.error;
    return result.value as T;
  }

  it('isPreRequestNetworkError: só falhas antes da entrega (inclui AggregateError do happy eyeballs)', () => {
    expect(isPreRequestNetworkError(fetchFailed('ECONNREFUSED'))).toBe(true);
    expect(isPreRequestNetworkError(fetchFailed('UND_ERR_CONNECT_TIMEOUT'))).toBe(true);
    const aggregate = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(
        new AggregateError([
          Object.assign(new Error('a'), { code: 'ECONNREFUSED' }),
          Object.assign(new Error('b'), { code: 'EHOSTUNREACH' }),
        ]),
        { code: 'ECONNREFUSED' },
      ),
    });
    expect(isPreRequestNetworkError(aggregate)).toBe(true);
    expect(isPreRequestNetworkError(fetchFailed('ECONNRESET'))).toBe(false);
    expect(isPreRequestNetworkError(fetchFailed('UND_ERR_SOCKET'))).toBe(false);
    expect(isPreRequestNetworkError(new TypeError('fetch failed'))).toBe(false);
  });

  it('conexão recusada → re-tenta (nada foi gerado)', async () => {
    fetchSpy
      .mockRejectedValueOnce(fetchFailed('ECONNREFUSED') as never)
      .mockResolvedValueOnce(ok() as never);
    const result = await settle(call());
    expect(result.audio.toString()).toBe('mp3');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('429 e 5xx → re-tenta; o retry é logado', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('busy', { status: 429 }) as never)
      .mockResolvedValueOnce(new Response('oops', { status: 503 }) as never)
      .mockResolvedValueOnce(ok() as never);
    await settle(call());
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const warn = (provider as unknown as { logger: { warn: jest.Mock } }).logger.warn;
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('HTTP 429');
  });

  it('socket fechado/reset depois do envio → terminal provider_response_lost, SEM nova requisição', async () => {
    fetchSpy.mockRejectedValue(fetchFailed('UND_ERR_SOCKET') as never);
    await expect(settle(call())).rejects.toMatchObject({ code: 'provider_response_lost' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();
    fetchSpy.mockRejectedValue(fetchFailed('ECONNRESET') as never);
    await expect(settle(call())).rejects.toMatchObject({ code: 'provider_response_lost' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('timeout do cliente → terminal provider_timeout, SEM nova requisição', async () => {
    env.ELEVENLABS_TTS_TIMEOUT_MS = '1000';
    fetchSpy.mockImplementation(
      ((_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        })) as never,
    );
    await expect(settle(call())).rejects.toMatchObject({ code: 'provider_timeout' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('200 com corpo ilegível → terminal provider_response_lost (áudio cobrado), sem nova requisição', async () => {
    fetchSpy.mockResolvedValue(
      new Response('{corrompido', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as never,
    );
    await expect(settle(call())).rejects.toMatchObject({ code: 'provider_response_lost' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('400 → terminal provider_rejected com o motivo (fallback do chamador continua possível)', async () => {
    fetchSpy.mockResolvedValue(new Response('invalid_uid', { status: 400 }) as never);
    const err = await settle(call()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalProviderError);
    expect(err).toMatchObject({ code: 'provider_rejected' });
    expect((err as Error).message).toContain('invalid_uid');
  });
});
