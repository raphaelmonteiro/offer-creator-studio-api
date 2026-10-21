import {
  ArgumentsHost,
  ConflictException,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

function run(exception: unknown): { status: number; body: any } {
  const result: { status: number; body: any } = { status: 0, body: null };
  const response = {
    status: jest.fn((s: number) => {
      result.status = s;
      return response;
    }),
    json: jest.fn((b: unknown) => {
      result.body = b;
      return response;
    }),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'GET', url: '/x', originalUrl: '/v1/x' }),
    }),
  } as unknown as ArgumentsHost;
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    new HttpExceptionFilter().catch(exception, host);
  } finally {
    process.env.NODE_ENV = original;
  }
  return result;
}

describe('HttpExceptionFilter — campos estruturados do erro chegam ao cliente', () => {
  it('encaminha issues[], revision e demais campos extras de um 422/409 (pipeline v2)', () => {
    const issues = [
      { code: 'AUDIO_EXCEEDS_CLIP', sceneId: 's2', message: 'não cabe', detail: { clipS: 5 } },
    ];
    const r = run(
      new UnprocessableEntityException({ code: 'AUDIO_EXCEEDS_CLIP', message: 'não cabe', issues }),
    );
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'AUDIO_EXCEEDS_CLIP', message: 'não cabe', issues });
    const c = run(new ConflictException({ code: 'REVISION_CONFLICT', message: 'x', revision: 3 }));
    expect(c.body.error).toMatchObject({ code: 'REVISION_CONFLICT', revision: 3 });
  });

  it('erro padrão do Nest (statusCode/message/error) continua no formato antigo, sem vazar statusCode', () => {
    const r = run(new UnprocessableEntityException('inválido'));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBeDefined();
    expect(r.body.error.message).toBe('inválido');
    expect(r.body.error.statusCode).toBeUndefined();
  });
});

describe('HttpExceptionFilter — erro não tratado (500)', () => {
  let logError: jest.SpyInstance;

  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logError.mockRestore();
  });

  it('em produção responde INTERNAL_SERVER_ERROR sem detalhes e LOGA rota, mensagem e stack', () => {
    const boom = new Error('column "x" does not exist');
    const r = run(boom);
    expect(r.status).toBe(500);
    expect(r.body.error).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Erro interno do servidor',
      details: undefined,
    });
    expect(logError).toHaveBeenCalledTimes(1);
    const [message, stack] = logError.mock.calls[0];
    expect(message).toContain('500 em GET /v1/x');
    expect(message).toContain('column "x" does not exist');
    expect(stack).toBe(boom.stack);
  });

  it('4xx não vai para o log de erro', () => {
    run(new UnprocessableEntityException('inválido'));
    expect(logError).not.toHaveBeenCalled();
  });
});
