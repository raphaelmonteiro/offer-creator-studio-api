import { ConfigService } from '@nestjs/config';
import { ElevenLabsProvider } from './elevenlabs.provider';

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
