import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemSettingsService } from '../../shared/settings/system-settings.service';
import { CommercialsController } from './commercials.controller';
import { CommercialsService } from './commercials.service';
import { McArtService } from './services/mc-art.service';
import { McFromArtService } from './services/mc-from-art.service';
import { McPiecesService } from './services/mc-pieces.service';
import { McFromPieceService } from './services/mc-from-piece.service';
import { McPieceBackgroundService } from './services/mc-piece-background.service';
import { McKitCandidatesService } from './services/mc-kit-candidates.service';
import { McKitsService } from './services/mc-kits.service';
import { McProjectActionsService } from './services/mc-project-actions.service';
import { McQualityService } from './services/mc-quality.service';
import { McVoicesService } from './services/mc-voices.service';

/**
 * Rotas da ponte arte → projeto (tarefas 5.1–5.6): o controller só delega,
 * com o usuário autenticado; ownership e regras são do service.
 */
describe('CommercialsController — ponte arte → projeto (D9)', () => {
  const user = { id: 'u1' };
  let commercials: Record<string, jest.Mock>;
  let art: Record<string, jest.Mock>;
  let fromArt: Record<string, jest.Mock>;
  let controller: CommercialsController;

  beforeEach(() => {
    commercials = {
      findAllProjects: jest.fn().mockResolvedValue([]),
      findOneProject: jest.fn().mockResolvedValue({ id: 'p1', sourceArt: null }),
    };
    art = {
      upload: jest.fn().mockResolvedValue({ assetId: 'a1' }),
      findOne: jest.fn().mockResolvedValue({ assetId: 'a1' }),
    };
    fromArt = {
      listOffers: jest.fn().mockResolvedValue({ offers: [] }),
      createFromArt: jest.fn().mockResolvedValue({ id: 'p1' }),
      detectLogoBox: jest.fn().mockResolvedValue({ projectId: 'p1', source: 'detected' }),
      setLogoBox: jest.fn().mockResolvedValue({ projectId: 'p1', source: 'user' }),
      suggestKit: jest.fn().mockResolvedValue({ kit: null }),
      withSourceArtStatus: jest.fn((view: Record<string, unknown>) =>
        Promise.resolve({ ...view, sourceArtChanged: false, sourceArtMissing: false }),
      ),
    };
    controller = new CommercialsController(
      commercials as unknown as CommercialsService,
      {} as McKitsService,
      {} as McKitCandidatesService,
      {} as McVoicesService,
      {} as McProjectActionsService,
      {} as McQualityService,
      {} as SystemSettingsService,
      {} as ConfigService,
      art as unknown as McArtService,
      fromArt as unknown as McFromArtService,
      {} as McPiecesService,
      {} as McFromPieceService,
      {} as McPieceBackgroundService,
    );
  });

  it('POST /art entrega o arquivo multipart ao McArtService; GET /art/:id lê o asset do usuário', async () => {
    const file = { buffer: Buffer.from('x'), mimetype: 'image/png' } as Express.Multer.File;
    await controller.uploadArt(user, file);
    expect(art.upload).toHaveBeenCalledWith('u1', file);
    await controller.findOneArt(user, 'a1');
    expect(art.findOne).toHaveBeenCalledWith('u1', 'a1');
  });

  it('GET /art-sources/:kind/:id/offers valida o kind e repassa a página (default 0)', async () => {
    await controller.listArtOffers('social', 'doc-1', {});
    expect(fromArt.listOffers).toHaveBeenCalledWith('social', 'doc-1', 0);
    await controller.listArtOffers('flyer', 'f-1', { pageIndex: 2 });
    expect(fromArt.listOffers).toHaveBeenLastCalledWith('flyer', 'f-1', 2);
    expect(() => controller.listArtOffers('pdf', 'f-1', {})).toThrow(BadRequestException);
  });

  it('POST /projects/from-art delega com o usuário e o DTO', async () => {
    const dto = {
      artAssetId: 'a1',
      sourceKind: 'v2_document',
      sourceId: 'doc-1',
      format: 'talking_art',
    } as never;
    await controller.createProjectFromArt(user, dto);
    expect(fromArt.createFromArt).toHaveBeenCalledWith('u1', dto);
  });

  it('GET /projects passa o filtro da arte; GET /projects/:id ganha sourceArt/sourceArtChanged', async () => {
    await controller.findAllProjects(user, { sourceKind: 'flyer', sourceId: 'f-1' });
    expect(commercials.findAllProjects).toHaveBeenCalledWith('u1', {
      sourceKind: 'flyer',
      sourceId: 'f-1',
    });
    const view = await controller.findOneProject(user, 'p1');
    expect(commercials.findOneProject).toHaveBeenCalledWith('u1', 'p1');
    expect(fromArt.withSourceArtStatus).toHaveBeenCalledWith({ id: 'p1', sourceArt: null });
    expect(view).toMatchObject({ id: 'p1', sourceArtChanged: false });
  });

  it('GET /kits/suggest?clientId= delega a sugestão', async () => {
    await controller.suggestKit(user, { clientId: 'c1' });
    expect(fromArt.suggestKit).toHaveBeenCalledWith('u1', 'c1');
  });

  it('caixa do logo (4.6): POST .../logo-box/detect e PUT .../logo-box delegam com o usuário', async () => {
    await controller.detectLogoBox(user, 'p1');
    expect(fromArt.detectLogoBox).toHaveBeenCalledWith('u1', 'p1');
    // só x/y/w/h seguem para o service
    await controller.setLogoBox(user, 'p1', { x: 0.1, y: 0.8, w: 0.2, h: 0.1 });
    expect(fromArt.setLogoBox).toHaveBeenCalledWith('u1', 'p1', { x: 0.1, y: 0.8, w: 0.2, h: 0.1 });
  });
});
