import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import { classifyOpenAiErrorStrict } from './openai-errors';
import { TerminalProviderError, TransientProviderError } from './provider-errors';

const apiError = (status: number, code: string | null = null) =>
  Object.assign(new Error(`HTTP ${status}`), { status, code });

describe('classifyOpenAiErrorStrict (modo estrito, change 28)', () => {
  it.each([
    ['429 de limite de taxa', apiError(429, 'rate_limit_exceeded')],
    ['500', apiError(500)],
    ['503', apiError(503)],
    ['falha de conexão', new APIConnectionError({ message: 'socket hang up' })],
    ['prazo estourado', new APIConnectionTimeoutError()],
    ['erro sem status e sem código', new Error('algo inesperado')],
  ])('%s é transitório', (_, error) => {
    expect(classifyOpenAiErrorStrict(error)).toBeInstanceOf(TransientProviderError);
  });

  it.each([
    ['400', apiError(400)],
    ['401', apiError(401)],
    ['403', apiError(403)],
    ['404', apiError(404)],
  ])('%s é terminal', (_, error) => {
    expect(classifyOpenAiErrorStrict(error)).toBeInstanceOf(TerminalProviderError);
  });

  it('429 sem crédito é terminal com o código quota (nunca repetido)', () => {
    const result = classifyOpenAiErrorStrict(apiError(429, 'insufficient_quota'));
    expect(result).toBeInstanceOf(TerminalProviderError);
    expect(result).toMatchObject({ code: 'quota' });
  });

  it('401 e 403 levam o código provider_auth; 400 e 404 o código padrão', () => {
    expect(classifyOpenAiErrorStrict(apiError(401))).toMatchObject({ code: 'provider_auth' });
    expect(classifyOpenAiErrorStrict(apiError(403))).toMatchObject({ code: 'provider_auth' });
    expect(classifyOpenAiErrorStrict(apiError(400))).toMatchObject({ code: 'provider_rejected' });
    expect(classifyOpenAiErrorStrict(apiError(404))).toMatchObject({ code: 'provider_rejected' });
  });

  it('erro já classificado passa como veio', () => {
    const transient = new TransientProviderError('já classificado', 7);
    const terminal = new TerminalProviderError('já classificado', 'content_policy');
    expect(classifyOpenAiErrorStrict(transient)).toBe(transient);
    expect(classifyOpenAiErrorStrict(terminal)).toBe(terminal);
  });

  it('valor que não é erro (undefined, texto) vira transitório sem lançar', () => {
    expect(classifyOpenAiErrorStrict(undefined)).toBeInstanceOf(TransientProviderError);
    expect(classifyOpenAiErrorStrict('falhou')).toBeInstanceOf(TransientProviderError);
  });
});
