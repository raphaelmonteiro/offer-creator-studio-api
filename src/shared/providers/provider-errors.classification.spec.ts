import { PROVIDER_ERROR_FIXTURES } from './__fixtures__/provider-error-bodies';
import {
  classifyHttpRejection,
  providerErrorForRejection,
  TerminalProviderError,
  TransientProviderError,
} from './provider-errors';

describe('classifyHttpRejection — fixtures de corpo dos fornecedores (B1)', () => {
  it.each(PROVIDER_ERROR_FIXTURES.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    expect(classifyHttpRejection(fixture.status, fixture.body)).toBe(fixture.expected);
  });

  it('402 é cota com qualquer corpo, inclusive vazio', () => {
    expect(classifyHttpRejection(402, '')).toBe('quota');
  });

  it('corpo desconhecido nunca vira cota; 5xx é sempre transitório', () => {
    expect(classifyHttpRejection(400, 'algo sobre quota na mensagem')).toBe('provider_rejected');
    expect(classifyHttpRejection(404, '{"detail":"Not found"}')).toBe('provider_rejected');
    expect(classifyHttpRejection(500, 'exhausted balance')).toBe('transient');
  });

  it('429 com marcador de cota é cota; sem marcador segue transitório', () => {
    expect(classifyHttpRejection(429, 'quota_exceeded')).toBe('quota');
    expect(classifyHttpRejection(429, 'slow down')).toBe('transient');
  });
});

describe('providerErrorForRejection', () => {
  it('cota e chave inválida viram TerminalProviderError com o código estável', () => {
    const quota = providerErrorForRejection(403, 'User is locked. Reason: Exhausted balance');
    expect(quota).toBeInstanceOf(TerminalProviderError);
    expect((quota as TerminalProviderError).code).toBe('quota');
    const auth = providerErrorForRejection(401, '{"detail":"Invalid key"}');
    expect((auth as TerminalProviderError).code).toBe('provider_auth');
    expect(auth.message).toContain('HTTP 401');
  });

  it('transitório carrega o Retry-After e recusa comum segue provider_rejected', () => {
    const transient = providerErrorForRejection(503, '', 7);
    expect(transient).toBeInstanceOf(TransientProviderError);
    expect((transient as TransientProviderError).retryAfterSeconds).toBe(7);
    expect((providerErrorForRejection(400, 'x') as TerminalProviderError).code).toBe(
      'provider_rejected',
    );
    expect((providerErrorForRejection(422, 'x') as TerminalProviderError).code).toBe(
      'content_policy',
    );
  });
});
