import { ArgumentsHost, ConflictException, UnprocessableEntityException } from '@nestjs/common';
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
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ url: '/x' }) }),
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
