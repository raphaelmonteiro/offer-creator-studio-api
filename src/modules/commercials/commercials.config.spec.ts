import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { CreditsService } from '../../shared/credits/credits.service';
import { summarizeRenderPreflight } from '../../shared/ffmpeg/render-preflight';
import { MediaAssetsService } from '../../shared/media-assets/media-assets.service';
import { AnimationQueueService } from '../../shared/queue/animation-queue.service';
import { SystemSettingsService } from '../../shared/settings/system-settings.service';
import { WORKER_HEARTBEAT_KEY } from '../../shared/settings/worker-heartbeat.service';
import { TaskTransitionService } from '../../shared/state/task-transition.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CommercialsController } from './commercials.controller';
import { CommercialsService } from './commercials.service';
import { McEnabledGuard } from './mc-enabled.guard';
import { McArtService } from './services/mc-art.service';
import { McFromArtService } from './services/mc-from-art.service';
import { McKitCandidatesService } from './services/mc-kit-candidates.service';
import { McKitsService } from './services/mc-kits.service';
import { McProjectActionsService } from './services/mc-project-actions.service';
import { McQualityService } from './services/mc-quality.service';
import { McVoicesService } from './services/mc-voices.service';

/**
 * `GET /commercials/config` (achado da verificação manual): a UI só oferece
 * os formatos que a criação admitiria — `MC_FORMATS` + executor v2 — e mostra
 * quando o worker não tem o necessário para renderizar um formato.
 */
describe('CommercialsService.getConfig — formatos habilitados + render do heartbeat', () => {
  let settings: { get: jest.Mock; getFresh: jest.Mock };
  let service: CommercialsService;

  const preflight = (missing: string[]) =>
    summarizeRenderPreflight(
      (['ffmpeg', 'ffprobe', 'fonts', 'browser'] as const).map((id) => ({
        id,
        ok: !missing.includes(id),
        version: missing.includes(id) ? null : id,
        detail: missing.includes(id) ? `${id}: não encontrado` : undefined,
      })),
      '2026-10-12T00:00:00.000Z',
    );

  beforeEach(() => {
    settings = { get: jest.fn(), getFresh: jest.fn().mockResolvedValue(null) };
    service = new CommercialsService(
      {} as DataSource,
      {} as TaskTransitionService,
      {} as AnimationQueueService,
      settings as unknown as SystemSettingsService,
      {} as CreditsService,
      {} as MediaAssetsService,
    );
  });

  it('MC_FORMATS=talking_art com v2=all → só scenes e talking_art; render null sem heartbeat', async () => {
    const config = await service.getConfig({ MC_FORMATS: 'talking_art', MC_PIPELINE_V2: 'all' });
    expect(config).toEqual({
      formats: { scenes: true, talking_art: true, offer_carousel: false },
      render: null,
    });
    expect(settings.getFresh).toHaveBeenCalledWith(WORKER_HEARTBEAT_KEY);
  });

  it('MC_FORMATS vazio → só scenes (o F3 nunca é gated por MC_FORMATS)', async () => {
    const config = await service.getConfig({ MC_PIPELINE_V2: 'all' });
    expect(config.formats).toEqual({ scenes: true, talking_art: false, offer_carousel: false });
  });

  it('formato listado sem MC_PIPELINE_V2=all não conta como habilitado (a criação daria PIPELINE_V2_REQUIRED)', async () => {
    const config = await service.getConfig({
      MC_FORMATS: 'talking_art,offer_carousel',
      MC_PIPELINE_V2: 'cohort',
    });
    expect(config.formats).toEqual({ scenes: true, talking_art: false, offer_carousel: false });
  });

  it('render = worker.render.formats do heartbeat (sem navegador → offer_carousel indisponível)', async () => {
    settings.getFresh.mockResolvedValue({
      at: '2026-10-12T00:00:00.000Z',
      pid: 1,
      render: preflight(['browser']),
    });
    const config = await service.getConfig({
      MC_FORMATS: 'talking_art,offer_carousel',
      MC_PIPELINE_V2: 'all',
    });
    expect(config.formats).toEqual({ scenes: true, talking_art: true, offer_carousel: true });
    expect(config.render).toEqual({
      scenes: { available: true, missing: [] },
      talking_art: { available: true, missing: [] },
      offer_carousel: { available: false, missing: ['browser'] },
    });
  });

  it('heartbeat sem preflight ou leitura falhando → render null (desconhecido, não bloqueia)', async () => {
    settings.getFresh.mockResolvedValueOnce({ at: '2026-10-12T00:00:00.000Z', pid: 1 });
    expect((await service.getConfig({ MC_FORMATS: 'talking_art' })).render).toBeNull();
    settings.getFresh.mockRejectedValueOnce(new Error('relation does not exist'));
    expect((await service.getConfig({ MC_FORMATS: 'talking_art' })).render).toBeNull();
  });

  it('token desconhecido em MC_FORMATS é erro de configuração (mesmo parse do boot)', async () => {
    await expect(service.getConfig({ MC_FORMATS: 'video_magico' })).rejects.toThrow(
      /MC_FORMATS: formato desconhecido/,
    );
  });
});

describe('CommercialsController — GET /commercials/config', () => {
  it('delega ao service, atrás do JWT e do McEnabledGuard (404 MC_DISABLED com o módulo desligado)', async () => {
    const config = {
      formats: { scenes: true, talking_art: true, offer_carousel: false },
      render: null,
    };
    const commercials = { getConfig: jest.fn().mockResolvedValue(config) };
    const controller = new CommercialsController(
      commercials as unknown as CommercialsService,
      {} as McKitsService,
      {} as McKitCandidatesService,
      {} as McVoicesService,
      {} as McProjectActionsService,
      {} as McQualityService,
      {} as SystemSettingsService,
      {} as ConfigService,
      {} as McArtService,
      {} as McFromArtService,
    );
    await expect(controller.getConfig()).resolves.toBe(config);
    expect(commercials.getConfig).toHaveBeenCalledTimes(1);

    const guards = Reflect.getMetadata(GUARDS_METADATA, CommercialsController) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, McEnabledGuard]);
  });
});
