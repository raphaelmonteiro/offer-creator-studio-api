import {
  ConflictException,
  ForbiddenException,
  INestApplication,
  NotFoundException,
  Provider,
  Type,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { sign } from 'jsonwebtoken';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as request from 'supertest';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { SystemSettingsService } from '../../shared/settings/system-settings.service';
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

const SECRET = 'segredo-de-teste';
const PROJECT_ID = '3f2c1d0e-5b6a-4c7d-8e9f-0a1b2c3d4e5f';
const SCENE_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

class TestJwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: SECRET });
  }
  validate(payload: { sub: string }) {
    return { id: payload.sub };
  }
}

/**
 * Rotas tocadas pela fala contínua pelo HTTP (change video-fala-continua, 1.7, D12): cotação, reroll e
 * aprovação da produção — envelope, 401, 400, 403, 404, 409 e 422 — e o `reroll` da resposta.
 */
describe('rotas da fala contínua (HTTP): quote, reroll e approve-production', () => {
  const originalEnabled = process.env.MC_ENABLED;
  let app: INestApplication;
  let quality: { quote: jest.Mock; rerollScene: jest.Mock; approveProduction: jest.Mock };
  const token = (sub: string) => `Bearer ${sign({ sub }, SECRET)}`;
  const quoteUrl = `/v1/commercials/projects/${PROJECT_ID}/quote?phase=production`;
  const rerollUrl = `/v1/commercials/projects/${PROJECT_ID}/scenes/${SCENE_ID}/reroll`;
  const approveUrl = `/v1/commercials/projects/${PROJECT_ID}/approve-production`;

  beforeAll(async () => {
    process.env.MC_ENABLED = 'true';
    quality = { quote: jest.fn(), rerollScene: jest.fn(), approveProduction: jest.fn() };
    const stub = (provide: Type<unknown>, useValue: object = {}): Provider => ({
      provide,
      useValue,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [CommercialsController],
      providers: [
        TestJwtStrategy,
        stub(CommercialsService),
        stub(McKitsService),
        stub(McKitCandidatesService),
        stub(McVoicesService),
        stub(McProjectActionsService),
        stub(McQualityService, quality),
        stub(SystemSettingsService),
        stub(ConfigService),
        stub(McArtService),
        stub(McFromArtService),
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

  beforeEach(() => Object.values(quality).forEach((fn) => fn.mockReset()));

  it('GET quote: 200 no envelope com o `talk` por trecho', async () => {
    const talk = { mode: { continuous: true }, chunks: [{ index: 0, reason: 'edited' }] };
    quality.quote.mockResolvedValue({ phase: 'production', items: [], totalCredits: 0, talk });
    const res = await request(app.getHttpServer())
      .get(quoteUrl)
      .set('Authorization', token('u1'))
      .expect(200);
    expect(res.body).toMatchObject({ success: true, data: { talk } });
    expect(quality.quote).toHaveBeenCalledWith('u1', PROJECT_ID, 'production', {});
  });

  it.each([
    ['GET', quoteUrl],
    ['POST', rerollUrl],
    ['POST', approveUrl],
  ])('401 sem token em %s %s: nada é consultado nem agendado', async (method, url) => {
    const agent = request(app.getHttpServer());
    const res = await (
      method === 'GET' ? agent.get(url) : agent.post(url).send({ expectedRevision: 1 })
    ).expect(401);
    expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    expect(quality.quote).not.toHaveBeenCalled();
    expect(quality.rerollScene).not.toHaveBeenCalled();
    expect(quality.approveProduction).not.toHaveBeenCalled();
  });

  it('GET quote: 403 para projeto de outro usuário e 404 para id inexistente', async () => {
    quality.quote.mockRejectedValueOnce(new ForbiddenException());
    const forbidden = await request(app.getHttpServer())
      .get(quoteUrl)
      .set('Authorization', token('u2'))
      .expect(403);
    expect(forbidden.body).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    quality.quote.mockRejectedValueOnce(new NotFoundException('Projeto não encontrado'));
    await request(app.getHttpServer()).get(quoteUrl).set('Authorization', token('u1')).expect(404);
  });

  it('POST reroll: 201 com projeto + `reroll` (trecho, falas e cascata) e a revisão esperada repassada', async () => {
    const reroll = { chunkIndex: 1, sceneIds: ['s3', 's4'], cascadeSceneIds: ['s5', 's6'] };
    quality.rerollScene.mockResolvedValue({ id: PROJECT_ID, status: 'generating', reroll });
    const res = await request(app.getHttpServer())
      .post(rerollUrl)
      .set('Authorization', token('u1'))
      .send({ expectedRevision: 3 })
      .expect(201);
    expect(res.body).toMatchObject({ success: true, data: { status: 'generating', reroll } });
    expect(quality.rerollScene).toHaveBeenCalledWith('u1', PROJECT_ID, SCENE_ID, 3);
  });

  it.each([
    ['ausente', {}],
    ['texto', { expectedRevision: 'abc' }],
    ['decimal', { expectedRevision: 1.5 }],
    ['negativo', { expectedRevision: -1 }],
  ])(
    'POST reroll: expectedRevision %s → 400 no envelope e nada é agendado',
    async (_name, body) => {
      const res = await request(app.getHttpServer())
        .post(rerollUrl)
        .set('Authorization', token('u1'))
        .send(body)
        .expect(400);
      expect(res.body).toMatchObject({ success: false, error: { code: 'BAD_REQUEST' } });
      expect(quality.rerollScene).not.toHaveBeenCalled();
    },
  );

  it('POST reroll: 403, 404, 409 REVISION_CONFLICT e 422 SCENE_NOT_REROLLABLE vêm do service no envelope', async () => {
    const send = () =>
      request(app.getHttpServer())
        .post(rerollUrl)
        .set('Authorization', token('u1'))
        .send({ expectedRevision: 1 });
    quality.rerollScene.mockRejectedValueOnce(new ForbiddenException());
    await send().expect(403);
    quality.rerollScene.mockRejectedValueOnce(new NotFoundException('Projeto não encontrado'));
    await send().expect(404);
    quality.rerollScene.mockRejectedValueOnce(
      new ConflictException({ code: 'REVISION_CONFLICT', message: 'revisão velha' }),
    );
    const conflict = await send().expect(409);
    expect(conflict.body.error.code).toBe('REVISION_CONFLICT');
    quality.rerollScene.mockRejectedValueOnce(
      new UnprocessableEntityException({ code: 'SCENE_NOT_REROLLABLE', message: 'em produção' }),
    );
    const unprocessable = await send().expect(422);
    expect(unprocessable.body.error.code).toBe('SCENE_NOT_REROLLABLE');
  });

  it('POST approve-production: repetir com revisão velha → 409 e a aprovação passa pelo service (nenhum talk novo é decidido no controller)', async () => {
    quality.approveProduction.mockRejectedValueOnce(
      new ConflictException({ code: 'REVISION_CONFLICT', message: 'revisão velha' }),
    );
    await request(app.getHttpServer())
      .post(approveUrl)
      .set('Authorization', token('u1'))
      .send({ expectedRevision: 1, manifestHash: 'h' })
      .expect(409);
    expect(quality.approveProduction).toHaveBeenCalledTimes(1);
  });
});
