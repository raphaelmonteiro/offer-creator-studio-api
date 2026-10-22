import { ConfigService } from '@nestjs/config';
import { SystemSettingsService } from '../../shared/settings/system-settings.service';
import { CommercialsController } from './commercials.controller';
import { CommercialsService } from './commercials.service';
import { McArtService } from './services/mc-art.service';
import { McFromArtService } from './services/mc-from-art.service';
import { McPiecesService } from './services/mc-pieces.service';
import { McFromPieceService } from './services/mc-from-piece.service';
import { McKitCandidatesService } from './services/mc-kit-candidates.service';
import { McKitsService } from './services/mc-kits.service';
import { McProjectActionsService } from './services/mc-project-actions.service';
import { McQualityService } from './services/mc-quality.service';
import { McVoicesService } from './services/mc-voices.service';

/**
 * Rotas de candidatos e gate de boca (tarefa 2.5): o controller só delega,
 * sempre com o usuário autenticado (ownership é regra do service).
 */
describe('CommercialsController — rotas de candidatos do kit (D4)', () => {
  const user = { id: 'u1' };
  let kits: Record<string, jest.Mock>;
  let candidates: Record<string, jest.Mock>;
  let controller: CommercialsController;

  beforeEach(() => {
    kits = { approveKit: jest.fn().mockResolvedValue({ id: 'kit-1' }) };
    candidates = {
      list: jest.fn().mockResolvedValue({ rounds: [] }),
      startRound: jest.fn().mockResolvedValue({ id: 'kit-1' }),
      choose: jest.fn().mockResolvedValue({ id: 'kit-1' }),
      useAsIs: jest.fn().mockResolvedValue({ id: 'kit-1' }),
      requestMouthVariant: jest.fn().mockResolvedValue({ id: 'kit-1' }),
    };
    controller = new CommercialsController(
      {} as CommercialsService,
      kits as unknown as McKitsService,
      candidates as unknown as McKitCandidatesService,
      {} as McVoicesService,
      {} as McProjectActionsService,
      {} as McQualityService,
      {} as SystemSettingsService,
      {} as ConfigService,
      {} as McArtService,
      {} as McFromArtService,
      {} as McPiecesService,
      {} as McFromPieceService,
    );
  });

  it('GET /kits/:id/candidates lista as rodadas do usuário', async () => {
    await controller.listKitCandidates(user, 'kit-1');
    expect(candidates.list).toHaveBeenCalledWith('u1', 'kit-1');
  });

  it('POST /kits/:id/candidates abre nova rodada com os ajustes do body', async () => {
    await controller.startKitCandidatesRound(user, 'kit-1', { adjustments: 'menos infantil' });
    expect(candidates.startRound).toHaveBeenCalledWith('u1', 'kit-1', 'menos infantil');
    await controller.startKitCandidatesRound(user, 'kit-1', {});
    expect(candidates.startRound).toHaveBeenLastCalledWith('u1', 'kit-1', undefined);
  });

  it('POST /kits/:id/candidates/:cid/choose escolhe o candidato', async () => {
    await controller.chooseKitCandidate(user, 'kit-1', 'cand-1');
    expect(candidates.choose).toHaveBeenCalledWith('u1', 'kit-1', 'cand-1');
  });

  it('POST /kits/:id/use-as-is e POST /kits/:id/mouth-variant delegam ao service', async () => {
    await controller.useKitLogoAsIs(user, 'kit-1');
    expect(candidates.useAsIs).toHaveBeenCalledWith('u1', 'kit-1');
    await controller.requestKitMouthVariant(user, 'kit-1');
    expect(candidates.requestMouthVariant).toHaveBeenCalledWith('u1', 'kit-1');
  });

  it('POST /kits/:id/approve repassa acceptMouthRisk no DTO', async () => {
    await controller.approveKit(user, 'kit-1', { voiceId: 'v1', acceptMouthRisk: true });
    expect(kits.approveKit).toHaveBeenCalledWith('u1', 'kit-1', {
      voiceId: 'v1',
      acceptMouthRisk: true,
    });
  });
});
