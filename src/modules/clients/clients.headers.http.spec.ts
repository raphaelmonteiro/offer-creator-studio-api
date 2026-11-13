import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as request from 'supertest';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { SmartValidationPipe } from '../../common/pipes/smart-validation.pipe';
import { AuthService } from '../auth/auth.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { UploadsService } from '../uploads/uploads.service';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { ClientContact } from './entities/client-contact.entity';
import { ClientStore } from './entities/client-store.entity';
import { Client } from './entities/client.entity';
import {
  FakeClientRepository,
  fakeChildRepository,
  footerItem,
  headerItem,
} from './clients.testutil';

const SECRET = 'segredo-http-clients';

/** Fluxo base HTTP com o guard JWT real, o pipe global real e o repositório em memória. */
describe('Clients headers (HTTP)', () => {
  let app: INestApplication;
  let auth: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_SECRET: SECRET })],
        }),
        PassportModule,
        JwtModule.register({ secret: SECRET }),
      ],
      controllers: [ClientsController],
      providers: [
        ClientsService,
        JwtStrategy,
        { provide: getRepositoryToken(Client), useValue: new FakeClientRepository() },
        { provide: getRepositoryToken(ClientContact), useValue: fakeChildRepository() },
        { provide: getRepositoryToken(ClientStore), useValue: fakeChildRepository() },
        { provide: UploadsService, useValue: {} },
        {
          provide: AuthService,
          useValue: {
            validateUserById: async (id: string) => ({ id, email: 'a@b.c', role: 'admin' }),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(
      new SmartValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    auth = `Bearer ${moduleRef.get(JwtService).sign({ sub: 'u1' })}`;
  });

  afterAll(() => app.close());

  const http = () => request(app.getHttpServer());

  it('fluxo base: cria com headers, lê, atualiza só headers e limpa; rodapés intactos', async () => {
    const created = await http()
      .post('/clients')
      .set('Authorization', auth)
      .send({
        name: 'C',
        cnpj: '10',
        footers: [footerItem('f1', 'R')],
        headers: [headerItem('h1', 'A'), headerItem('h2', 'B')],
      })
      .expect(201);
    const id = created.body.id;
    expect(created.body.headers.map((h: { id: string }) => h.id)).toEqual(['h1', 'h2']);

    const patched = await http()
      .patch(`/clients/${id}`)
      .set('Authorization', auth)
      .send({ headers: [headerItem('h3', 'C')] })
      .expect(200);
    expect(patched.body.headers).toHaveLength(1);
    expect(patched.body.footers).toHaveLength(1);

    const read = await http().get(`/clients/${id}`).set('Authorization', auth).expect(200);
    expect(read.body.headers[0].id).toBe('h3');

    const cleared = await http()
      .patch(`/clients/${id}`)
      .set('Authorization', auth)
      .send({ headers: [] })
      .expect(200);
    expect(cleared.body.headers).toEqual([]);
    expect(cleared.body.footers).toHaveLength(1);
  });

  it('400 quando headers não é lista e nada é gravado', async () => {
    const { body } = await http()
      .post('/clients')
      .set('Authorization', auth)
      .send({ name: 'D', cnpj: '11' })
      .expect(201);
    await http()
      .patch(`/clients/${body.id}`)
      .set('Authorization', auth)
      .send({ headers: 'abc' })
      .expect(400);
    const read = await http().get(`/clients/${body.id}`).set('Authorization', auth).expect(200);
    expect(read.body.headers).toBeNull();
  });

  it('400 quando um item de headers não é objeto', async () => {
    await http()
      .post('/clients')
      .set('Authorization', auth)
      .send({ name: 'E', cnpj: '12', headers: ['x', 1] })
      .expect(400);
  });

  it('404 para cliente inexistente', async () => {
    await http()
      .patch('/clients/nao-existe')
      .set('Authorization', auth)
      .send({ headers: [] })
      .expect(404);
  });

  it('401 sem token em POST, GET e PATCH', async () => {
    await http().post('/clients').send({ name: 'F', cnpj: '13', headers: [] }).expect(401);
    await http().get('/clients/x').expect(401);
    await http().patch('/clients/x').send({ headers: [] }).expect(401);
  });
});
