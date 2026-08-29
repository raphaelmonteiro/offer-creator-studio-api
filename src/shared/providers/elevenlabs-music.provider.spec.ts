import { ConfigService } from '@nestjs/config';
import {
  ElevenLabsMusicProvider,
  MUSIC_MAX_LENGTH_MS,
  MUSIC_MIN_LENGTH_MS,
  MUSIC_UNAVAILABLE_CODE,
} from './elevenlabs-music.provider';
import { TerminalProviderError, TransientProviderError } from './provider-errors';

function configOf(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    // TextEncoder devolve um ArrayBuffer do TAMANHO exato (Buffer.from().buffer
    // entregaria o pool de 8KB do Node e o teste mediria lixo).
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode('mp3-bytes').buffer),
  } as unknown as Response;
}

function errorResponse(status: number, body = 'sem acesso'): Response {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('ElevenLabsMusicProvider — trilha instrumental (plano §5.1 etapa 6)', () => {
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('POST /v1/music com prompt, duração e force_instrumental', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const provider = new ElevenLabsMusicProvider(configOf({ ELEVENLABS_API_KEY: 'k' }));

    const audio = await provider.compose({ prompt: 'trilha de varejo', lengthMs: 20_000 });

    expect(audio.toString()).toBe('mp3-bytes');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/music');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('k');
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: 'trilha de varejo',
      music_length_ms: 20_000,
      force_instrumental: true,
    });
  });

  it('não envia model_id por padrão (default da conta) e envia quando configurado', async () => {
    fetchMock.mockResolvedValue(okResponse());
    await new ElevenLabsMusicProvider(
      configOf({ ELEVENLABS_API_KEY: 'k', ELEVENLABS_MUSIC_MODEL: 'music_v2' }),
    ).compose({ prompt: 'p', lengthMs: 10_000 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).model_id).toBe('music_v2');
  });

  it('faz clamp da duração nos limites do endpoint (3s–10min)', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const provider = new ElevenLabsMusicProvider(configOf({ ELEVENLABS_API_KEY: 'k' }));

    await provider.compose({ prompt: 'p', lengthMs: 10 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).music_length_ms).toBe(
      MUSIC_MIN_LENGTH_MS,
    );

    await provider.compose({ prompt: 'p', lengthMs: 999_999_999 });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).music_length_ms).toBe(
      MUSIC_MAX_LENGTH_MS,
    );
  });

  it.each([401, 403, 422])(
    'HTTP %i (conta sem Eleven Music) → terminal music_unavailable (o assembly degrada)',
    async (status) => {
      fetchMock.mockResolvedValue(errorResponse(status));
      const provider = new ElevenLabsMusicProvider(configOf({ ELEVENLABS_API_KEY: 'k' }));
      await expect(provider.compose({ prompt: 'p', lengthMs: 10_000 })).rejects.toMatchObject({
        code: MUSIC_UNAVAILABLE_CODE,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1); // terminal: sem retry
    },
  );

  it('sem chave configurada nem chega a chamar a API', async () => {
    const provider = new ElevenLabsMusicProvider(configOf({}));
    await expect(provider.compose({ prompt: 'p', lengthMs: 10_000 })).rejects.toBeInstanceOf(
      TerminalProviderError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resposta vazia é terminal (não adianta re-tentar um mp3 de 0 byte)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as Response);
    const provider = new ElevenLabsMusicProvider(configOf({ ELEVENLABS_API_KEY: 'k' }));
    await expect(provider.compose({ prompt: 'p', lengthMs: 10_000 })).rejects.toMatchObject({
      code: MUSIC_UNAVAILABLE_CODE,
    });
  });

  it('5xx/429 são transientes (o withRetry re-tenta e só depois desiste)', async () => {
    fetchMock.mockResolvedValue(errorResponse(503, 'indisponível'));
    const provider = new ElevenLabsMusicProvider(configOf({ ELEVENLABS_API_KEY: 'k' }));
    await expect(provider.compose({ prompt: 'p', lengthMs: 10_000 })).rejects.toBeInstanceOf(
      TransientProviderError,
    );
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  }, 15_000);
});
