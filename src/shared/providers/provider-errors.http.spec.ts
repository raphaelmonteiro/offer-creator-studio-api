import { ConfigService } from '@nestjs/config';
import { PROVIDER_ERROR_FIXTURES } from './__fixtures__/provider-error-bodies';
import { ElevenLabsProvider } from './elevenlabs.provider';
import { FalQueueClient } from './fal-queue.client';
import { TerminalProviderError, TransientProviderError } from './provider-errors';

/** As fixtures de corpo passam pelos clientes reais (fetch falso): fal pela base HTTP, ElevenLabs pelo `postGeneration`. */
describe('classificação de erro de fornecedor nos clientes HTTP (B1)', () => {
  let fetchSpy: jest.SpyInstance;
  const reply = (status: number, body: string) =>
    Promise.resolve(new Response(body, { status }) as never);

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch' as never);
  });
  afterEach(() => fetchSpy.mockRestore());

  describe('fal (FalQueueClient)', () => {
    const client = new FalQueueClient({ get: () => 'fake-fal' } as unknown as ConfigService);
    const fixtures = PROVIDER_ERROR_FIXTURES.filter((f) => f.provider === 'fal');

    it.each(fixtures.map((f) => [f.name, f] as const))('%s', async (_name, fixture) => {
      fetchSpy.mockImplementation(() => reply(fixture.status, fixture.body));
      const err = await client.submit('fal-ai/kling', {}).catch((e: unknown) => e);
      if (fixture.expected === 'transient') {
        expect(err).toBeInstanceOf(TransientProviderError);
      } else {
        expect(err).toBeInstanceOf(TerminalProviderError);
        expect((err as TerminalProviderError).code).toBe(fixture.expected);
      }
      expect(fetchSpy).toHaveBeenCalledTimes(1); // a classe terminal não re-tenta
    });
  });

  describe('ElevenLabs (postGeneration)', () => {
    const provider = new ElevenLabsProvider({
      get: () => 'fake-eleven',
    } as unknown as ConfigService);
    const terminal = PROVIDER_ERROR_FIXTURES.filter(
      (f) => f.provider === 'elevenlabs' && f.expected !== 'transient',
    );

    it.each(terminal.map((f) => [f.name, f] as const))('%s', async (_name, fixture) => {
      fetchSpy.mockImplementation(() => reply(fixture.status, fixture.body));
      const err = await provider
        .synthesizeWithTimestamps({ text: 'Olá!', voiceId: 'v1' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TerminalProviderError);
      expect((err as TerminalProviderError).code).toBe(fixture.expected);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // sem nova tentativa paga
    });
  });
});
