import { Body, Controller, INestApplication, Post, UseInterceptors } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import * as request from 'supertest';
import { ResponseInterceptor } from '../interceptors/response.interceptor';
import { configureHttpApp } from './http-app.config';

class EchoDto {
  @IsString()
  text: string;
}

@Controller('eco')
@UseInterceptors(ResponseInterceptor)
class EchoController {
  @Post()
  echo(@Body() body: EchoDto) {
    return { size: body.text.length };
  }
}

/** A configuração HTTP que o `main.ts` e o app de teste do e2e compartilham. */
describe('configureHttpApp', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // O filtro escreve `console.error` fora de produção; aqui o 400 é esperado.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({ controllers: [EchoController] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureHttpApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  const post = (url: string) => request(app.getHttpServer()).post(url);

  it('serve sob o prefixo /v1 e não fora dele', async () => {
    await post('/v1/eco').send({ text: 'oi' }).expect(201);
    await post('/eco').send({ text: 'oi' }).expect(404);
  });

  it('lê JSON maior que o limite padrão do Express (100 kB): 1 MB passa', async () => {
    const response = await post('/v1/eco').send({ text: 'x'.repeat(1_000_000) });
    expect(response.status).toBe(201);
    expect(response.body.data.size).toBe(1_000_000);
  });

  it('o pipe global recusa campo desconhecido (400) e o filtro devolve o envelope de erro', async () => {
    const response = await post('/v1/eco').send({ text: 'oi', extra: 1 });
    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });
});
