// O controller puxa serviços que carregam sharp, que não carrega no host.
jest.mock('sharp', () => jest.fn());

import { ExecutionContext, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SmartValidationPipe } from '../../common/pipes/smart-validation.pipe';
import { SystemSettingsService } from '../../shared/settings/system-settings.service';
import { CommercialsController } from './commercials.controller';
import { CommercialsService } from './commercials.service';
import { McEnabledGuard } from './mc-enabled.guard';
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

const PROJECT = '0b5c7a3e-0000-4000-8000-000000000001';
const scene = { sceneType: 'talk_tile', durationS: 5, dialogue: 'Olá!' };

/** Rota real (pipe global como no main.ts): B1 da QA — `cutout`/`framing` do PATCH script eram ignorados. */
describe('PATCH /commercials/projects/:id/script — validação de cutout e framing (B1)', () => {
  let app: INestApplication;
  const quality = {
    updateScript: jest.fn().mockResolvedValue({ id: PROJECT }),
    updateComposition: jest.fn().mockResolvedValue({ id: PROJECT }),
    rerollCutoutScenes: jest.fn().mockResolvedValue({ id: PROJECT }),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [CommercialsController],
      providers: [
        {
          provide: CommercialsService,
          useValue: {
            findOneProject: jest.fn().mockResolvedValue({ id: PROJECT, pipelineVersion: 2 }),
          },
        },
        { provide: McKitsService, useValue: {} },
        { provide: McKitCandidatesService, useValue: {} },
        { provide: McVoicesService, useValue: {} },
        { provide: McProjectActionsService, useValue: {} },
        { provide: McQualityService, useValue: quality },
        { provide: SystemSettingsService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: McArtService, useValue: {} },
        { provide: McFromArtService, useValue: {} },
        { provide: McPiecesService, useValue: {} },
        { provide: McFromPieceService, useValue: {} },
        { provide: McPieceBackgroundService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = { id: 'u1' };
          return true;
        },
      })
      .overrideGuard(McEnabledGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new SmartValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        skipMissingProperties: false,
      }),
    );
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  const patch = (extra: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(`/commercials/projects/${PROJECT}/script`)
      .send({ expectedRevision: 1, scenes: [scene], ...extra });

  it.each([
    ['framing fora da lista', { framing: 'inteiro' }],
    ['cutout não booleano', { cutout: 'sim' }],
    ['cutout numérico', { cutout: 1 }],
  ])('%s → 400 e nada chega ao service', async (_n, extra) => {
    await patch(extra).expect(400);
    expect(quality.updateScript).not.toHaveBeenCalled();
  });

  it.each([
    ['corpo + cutout', { cutout: true, framing: 'corpo' }],
    ['busto, sem cutout', { cutout: false, framing: 'busto' }],
    ['sem os campos novos', {}],
  ])('%s → 200 com os valores tipados no service', async (_n, extra) => {
    await patch(extra).expect(200);
    expect(quality.updateScript).toHaveBeenCalledTimes(1);
    expect(quality.updateScript.mock.calls[0][2]).toMatchObject(extra);
  });

  /** video-fala-continua (1.8): roteiro vazio é regra de negócio (422 no service), não forma (400). */
  describe('roteiro curto da peça — forma do corpo', () => {
    it('scenes vazio chega ao service (a regra devolve 422 CAROUSEL_LINES_COUNT)', async () => {
      await request(app.getHttpServer())
        .patch(`/commercials/projects/${PROJECT}/script`)
        .send({ expectedRevision: 1, scenes: [] })
        .expect(200);
      expect(quality.updateScript.mock.calls[0][2].scenes).toEqual([]);
    });

    it.each([['texto'], [{ a: 1 }]])(
      'lines que não é lista (%j) → 400 e nada chega ao service',
      async (lines) => {
        await patch({ lines }).expect(400);
        expect(quality.updateScript).not.toHaveBeenCalled();
      },
    );
  });

  /** B6: o nome do produto vem da arte (sem teto na criação); a edição aceita até 120. */
  describe('nome do produto (snapshot e ofertas do F2)', () => {
    const product = (name: string) => ({ name, price: '9,99' });

    it.each([
      ['products', 60],
      ['products', 61],
      ['products', 103],
      ['products', 120],
      ['offers', 61],
      ['offers', 103],
      ['offers', 120],
    ])('%s com nome de %i caracteres → 200 e chega ao service', async (field, size) => {
      await patch({ [field]: [product('A'.repeat(size))] }).expect(200);
      expect(quality.updateScript.mock.calls[0][2][field][0].name).toHaveLength(size);
    });

    it.each(['products', 'offers'])(
      '%s com nome de 121 caracteres → 400 e nada chega ao service',
      async (field) => {
        const res = await patch({ [field]: [product('A'.repeat(121))] }).expect(400);
        expect(JSON.stringify(res.body)).toContain('name must be shorter than or equal to 120');
        expect(quality.updateScript).not.toHaveBeenCalled();
      },
    );
  });

  /** Preço, unidade e preço anterior vêm da arte sem teto: a edição aceita até 40 (decisão de 27/10/2026). */
  describe('price, originalPrice e unit (até 40)', () => {
    const fields = ['price', 'originalPrice', 'unit'] as const;
    const withField = (field: string, size: number) => ({
      name: 'Arroz',
      price: '9,99',
      [field]: 'X'.repeat(size),
    });

    describe.each(['products', 'offers'])('%s do PATCH script', (list) => {
      it.each(fields.flatMap((f) => [21, 40].map((n) => [f, n] as const)))(
        '%s com %i caracteres → 200 e chega ao service',
        async (field, size) => {
          await patch({ [list]: [withField(field, size)] }).expect(200);
          expect(quality.updateScript.mock.calls[0][2][list][0][field]).toHaveLength(size);
        },
      );

      it.each(fields)('%s com 41 caracteres → 400 e nada chega ao service', async (field) => {
        const res = await patch({ [list]: [withField(field, 41)] }).expect(400);
        expect(JSON.stringify(res.body)).toContain(`${field} must be shorter than or equal to 40`);
        expect(quality.updateScript).not.toHaveBeenCalled();
      });
    });

    describe('offers do PATCH composition', () => {
      const comp = (offer: Record<string, unknown>) =>
        request(app.getHttpServer())
          .patch(`/commercials/projects/${PROJECT}/composition`)
          .send({ expectedRevision: 1, offers: [{ id: 'o1', ...offer }] });

      it.each(fields.flatMap((f) => [21, 40].map((n) => [f, n] as const)))(
        '%s com %i caracteres → 200',
        async (field, size) => {
          await comp({ [field]: 'X'.repeat(size) }).expect(200);
          expect(quality.updateComposition).toHaveBeenCalledTimes(1);
        },
      );

      it.each(fields)('%s com 41 caracteres → 400', async (field) => {
        await comp({ [field]: 'X'.repeat(41) }).expect(400);
        expect(quality.updateComposition).not.toHaveBeenCalled();
      });
    });
  });

  /** R31: o `products` do PATCH composition usa o mesmo DTO de produto (nome até 120). */
  describe('nome do produto no PATCH composition (R31)', () => {
    const comp = (size: number) =>
      request(app.getHttpServer())
        .patch(`/commercials/projects/${PROJECT}/composition`)
        .send({ expectedRevision: 1, products: [{ name: 'A'.repeat(size), price: '9,99' }] });

    it('nome de 120 → 200 e chega ao service', async () => {
      await comp(120).expect(200);
      expect(quality.updateComposition.mock.calls[0][2].products[0].name).toHaveLength(120);
    });

    it('nome de 121 → 400 e nada chega ao service', async () => {
      const res = await comp(121).expect(400);
      expect(JSON.stringify(res.body)).toContain('name must be shorter than or equal to 120');
      expect(quality.updateComposition).not.toHaveBeenCalled();
    });
  });

  it('campo extra do cliente é descartado, não rejeitado (sem regressão)', async () => {
    await patch({ campoDesconhecido: 1 }).expect(200);
    expect(quality.updateScript.mock.calls[0][2]).not.toHaveProperty('campoDesconhecido');
  });

  it('POST cutout/reroll-scenes exige expectedRevision inteiro (400) e delega com a revisão', async () => {
    const url = `/commercials/projects/${PROJECT}/cutout/reroll-scenes`;
    await request(app.getHttpServer()).post(url).send({}).expect(400);
    await request(app.getHttpServer()).post(url).send({ expectedRevision: 'x' }).expect(400);
    expect(quality.rerollCutoutScenes).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post(url).send({ expectedRevision: 3 }).expect(201);
    expect(quality.rerollCutoutScenes).toHaveBeenCalledWith('u1', PROJECT, 3);
  });
});
