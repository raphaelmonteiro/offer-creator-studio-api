import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import {
  classifyMcError,
  MC_MAX_EXECUTIONS,
  mcErrorCode,
  mcRefundsOnTerminal,
  mcRetryDelayS,
  mcShouldRetry,
} from './mc-error-classes';

describe('mc-error-classes — classificação e política por classe (plano §6.4)', () => {
  it('TransientProviderError → transient', () => {
    expect(classifyMcError(new TransientProviderError('HTTP 503'))).toBe('transient');
  });

  it('TerminalProviderError content_policy → content_policy', () => {
    expect(classifyMcError(new TerminalProviderError('bloqueado', 'content_policy'))).toBe(
      'content_policy',
    );
  });

  it('TerminalProviderError quota → quota', () => {
    expect(classifyMcError(new TerminalProviderError('HTTP 402', 'quota'))).toBe('quota');
  });

  it('TerminalProviderError com qualquer outro code → validation', () => {
    expect(classifyMcError(new TerminalProviderError('sem vídeo', 'invalid_provider_output'))).toBe(
      'validation',
    );
    expect(classifyMcError(new TerminalProviderError('rejeitado'))).toBe('validation');
  });

  it('erro desconhecido → internal', () => {
    expect(classifyMcError(new Error('TypeError qualquer'))).toBe('internal');
    expect(classifyMcError('string')).toBe('internal');
  });

  it('transient: 3 retries (4 execuções) — retry nas execuções 1..3, terminal na 4ª', () => {
    expect(MC_MAX_EXECUTIONS.transient).toBe(4);
    expect(mcShouldRetry('transient', 1)).toBe(true);
    expect(mcShouldRetry('transient', 3)).toBe(true);
    expect(mcShouldRetry('transient', 4)).toBe(false);
  });

  it('internal: 1 retry (2 execuções)', () => {
    expect(mcShouldRetry('internal', 1)).toBe(true);
    expect(mcShouldRetry('internal', 2)).toBe(false);
  });

  it('content_policy/validation/quota/provider_timeout: terminais sem retry', () => {
    for (const cls of ['content_policy', 'validation', 'quota', 'provider_timeout'] as const) {
      expect(mcShouldRetry(cls, 1)).toBe(false);
    }
  });

  it('estorno no terminal para todas as classes exceto internal (reconciliação admin)', () => {
    expect(mcRefundsOnTerminal('transient')).toBe(true);
    expect(mcRefundsOnTerminal('content_policy')).toBe(true);
    expect(mcRefundsOnTerminal('validation')).toBe(true);
    expect(mcRefundsOnTerminal('quota')).toBe(true);
    expect(mcRefundsOnTerminal('provider_timeout')).toBe(true);
    expect(mcRefundsOnTerminal('internal')).toBe(false);
  });

  it('backoff 15/30/60 com cap no último degrau', () => {
    expect(mcRetryDelayS(1)).toBe(15);
    expect(mcRetryDelayS(2)).toBe(30);
    expect(mcRetryDelayS(3)).toBe(60);
    expect(mcRetryDelayS(9)).toBe(60);
  });

  it('mcErrorCode: usa o code do terminal, marcador fixo no transiente e fallback no resto', () => {
    expect(mcErrorCode(new TerminalProviderError('x', 'content_policy'), 'f')).toBe(
      'content_policy',
    );
    expect(mcErrorCode(new TransientProviderError('x'), 'f')).toBe('provider_transient');
    expect(mcErrorCode(new Error('x'), 'keyframe_failed')).toBe('keyframe_failed');
  });
});
