import {
  ForbiddenException,
  INestApplication,
  NotFoundException,
  Provider,
  Type,
} from '@nestjs/common';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { sign } from 'jsonwebtoken';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as request from 'supertest';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { CommercialsController } from './commercials.controller';
import { CommercialsService } from './commercials.service';
import { McArtService } from './services/mc-art.service';
import { McFromArtService } from './services/mc-from-art.service';
import { McFromPieceService } from './services/mc-from-piece.service';
import { McKitCandidatesService } from './services/mc-kit-candidates.service';
import { McKitsService } from './services/mc-kits.service';
import { McPieceBackgroundService } from './services/mc-piece-background.service';
import { McPiecesService } from './services/mc-pieces.service';
import { McProjectActionsService } from './services/mc-project-actions.service';
import { McQualityService } from './services/mc-quality.service';
import { McVoicesService } from './services/mc-voices.service';
import { SystemSettingsService } from '../../shared/settings/system-settings.service';
import { ConfigService } from '@nestjs/config';

const SECRET = 'segredo-de-teste';
const PROJECT_ID = '3f2c1d0e-5b6a-4c7d-8e9f-0a1b2c3d4e5f';
const MESSAGE =
  'O estúdio de vídeo está indisponível no momento. Nossa equipe já foi avisada; tente de novo mais tarde.';

class TestJwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: SECRET });
  }
  validate(payload: { sub: string }) {
    return { id: payload.sub };
  }
}

/** `GET /v1/commercials/projects/:id` pelo HTTP: envelope, 200, 400, 401, 403, 404 (design B4). */
describe('GET /commercials/projects/:id — motivo da falha em pt-BR (HTTP)', () => {
  const originalEnabled = process.env.MC_ENABLED;
  let app: INestApplication;
  let commercials: { findOneProject: jest.Mock };
  const token = (sub: string) => `Bearer ${sign({ sub }, SECRET)}`;

  beforeAll(async () => {
    process.env.MC_ENABLED = 'true';
    commercials = { findOneProject: jest.fn() };
    const stub = (provide: Type<unknown>, useValue: object = {}): Provider => ({
      provide,
      useValue,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [CommercialsController],
      providers: [
        TestJwtStrategy,
        stub(CommercialsService, commercials),
        stub(McKitsService),
        stub(McKitCandidatesService),
        stub(McVoicesService),
        stub(McProjectActionsService),
        stub(McQualityService),
        stub(SystemSettingsService),
        stub(ConfigService),
        stub(McArtService),
        stub(McFromArtService, { withSourceArtStatus: (p: unknown) => Promise.resolve(p) }),
        stub(McPiecesService),
        stub(McFromPieceService),
        stub(McPieceBackgroundService),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    await app.close();
    if (originalEnabled === undefined) delete process.env.MC_ENABLED;
    else process.env.MC_ENABLED = originalEnabled;
  });

  beforeEach(() => commercials.findOneProject.mockReset());

  it('200 no envelope { success, data } com errorCode, errorMessage e errorAction', async () => {
    commercials.findOneProject.mockResolvedValue({
      id: PROJECT_ID,
      status: 'needs_attention',
      errorCode: 'quota',
      errorMessage: MESSAGE,
      errorAction: 'tentar_mais_tarde',
      scenes: [
        { idx: 0, errorCode: 'quota', errorMessage: MESSAGE, errorAction: 'tentar_mais_tarde' },
      ],
    });
    const res = await request(app.getHttpServer())
      .get(`/v1/commercials/projects/${PROJECT_ID}`)
      .set('Authorization', token('u1'))
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      errorCode: 'quota',
      errorMessage: MESSAGE,
      errorAction: 'tentar_mais_tarde',
    });
    expect(commercials.findOneProject).toHaveBeenCalledWith('u1', PROJECT_ID);
  });

  it('401 sem token: nada do projeto é consultado', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/commercials/projects/${PROJECT_ID}`)
      .expect(401);
    expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    expect(commercials.findOneProject).not.toHaveBeenCalled();
  });

  it('400 BAD_REQUEST quando o id não é UUID', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/commercials/projects/nao-e-uuid')
      .set('Authorization', token('u1'))
      .expect(400);
    expect(res.body).toMatchObject({ success: false, error: { code: 'BAD_REQUEST' } });
    expect(commercials.findOneProject).not.toHaveBeenCalled();
  });

  it('403 FORBIDDEN para projeto de outro usuário, sem errorMessage', async () => {
    commercials.findOneProject.mockRejectedValue(new ForbiddenException());
    const res = await request(app.getHttpServer())
      .get(`/v1/commercials/projects/${PROJECT_ID}`)
      .set('Authorization', token('u2'))
      .expect(403);
    expect(res.body).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    expect(JSON.stringify(res.body)).not.toMatch(/errorMessage|estúdio/);
  });

  it('404 NOT_FOUND para projeto inexistente', async () => {
    commercials.findOneProject.mockRejectedValue(new NotFoundException('Projeto não encontrado'));
    const res = await request(app.getHttpServer())
      .get(`/v1/commercials/projects/${PROJECT_ID}`)
      .set('Authorization', token('u1'))
      .expect(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });

  it('404 MC_DISABLED com o módulo desligado', async () => {
    process.env.MC_ENABLED = 'false';
    try {
      const res = await request(app.getHttpServer())
        .get(`/v1/commercials/projects/${PROJECT_ID}`)
        .set('Authorization', token('u1'))
        .expect(404);
      expect(res.body.error.code).toBe('MC_DISABLED');
    } finally {
      process.env.MC_ENABLED = 'true';
    }
  });
});
