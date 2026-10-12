import { DataSource } from 'typeorm';
import { CreditsService } from '../../shared/credits/credits.service';
import { AnimationAsset } from '../../shared/media-assets/animation-asset.entity';
import { MediaAssetsService } from '../../shared/media-assets/media-assets.service';
import { AnimationQueueService } from '../../shared/queue/animation-queue.service';
import { SystemSettingsService } from '../../shared/settings/system-settings.service';
import { TaskTransitionService } from '../../shared/state/task-transition.service';
import { CommercialsService } from './commercials.service';
import { McStepType } from './domain/mc-types';
import { McProject } from './entities/mc-project.entity';
import { McScene } from './entities/mc-scene.entity';
import { McStep } from './entities/mc-step.entity';

/**
 * `GET /commercials/projects/:id` (tarefa 7.2): cada cena e cada step de
 * motor expõem `engine` (modelo que gerou o clipe) e `resolution` (medidas +
 * veredito do 1080p premium), lidos do asset publicado pelo ingest.
 */
describe('CommercialsService.findOneProject — motor e resolução do clipe (7.2)', () => {
  const PRO = 'fal-ai/kling-video/ai-avatar/v2/pro';
  const project = {
    id: 'p1',
    userId: 'u1',
    tier: 'premium',
    format: 'talking_art',
    finalAssetId: null,
    quality: null,
  };
  const scenes = [
    { id: 'sc1', projectId: 'p1', idx: 0, finalAssetId: 'clip-1', audioAssetId: 'au-1' },
    { id: 'sc2', projectId: 'p1', idx: 1, finalAssetId: null, audioAssetId: 'au-2' },
  ];
  const steps = [
    {
      id: 'st-tts',
      projectId: 'p1',
      type: McStepType.TTS,
      provider: 'elevenlabs',
      outputAssetId: 'au-1',
      inputSnapshot: {},
    },
    {
      id: 'st-talk-1',
      projectId: 'p1',
      type: McStepType.TALK,
      provider: PRO,
      outputAssetId: 'clip-1',
      inputSnapshot: { engine: { key: 'premium', model: PRO } },
    },
    {
      id: 'st-talk-2',
      projectId: 'p1',
      type: McStepType.TALK,
      provider: PRO,
      outputAssetId: null,
      inputSnapshot: {
        engine: { key: 'premium', model: PRO },
        effectiveEngine: { key: 'premium', model: PRO },
      },
    },
  ];
  const assets = [
    {
      id: 'clip-1',
      kind: 'scene_synced',
      mimeType: 'video/mp4',
      fileUrl: '/uploads/commercials/u1/p1/scenes/0/g1/synced.mp4',
      posterUrl: '/uploads/commercials/u1/p1/scenes/0/g1/synced-poster.jpg',
      width: 1080,
      height: 1440,
      metadata: {
        provider: PRO,
        engine: { key: 'premium', model: PRO, usdPerSecond: 0.115 },
        tier: 'premium',
        premiumResolutionOk: true,
      },
    },
    {
      id: 'au-1',
      kind: 'audio',
      mimeType: 'audio/mpeg',
      fileUrl: '/uploads/a.mp3',
      posterUrl: null,
      width: null,
      height: null,
      metadata: {},
    },
  ];

  function service(): CommercialsService {
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn(() => Promise.resolve(entity === McProject ? project : null)),
        find: jest.fn(() => {
          if (entity === McScene) return Promise.resolve(scenes);
          if (entity === McStep) return Promise.resolve(steps);
          if (entity === AnimationAsset) return Promise.resolve(assets);
          return Promise.resolve([]);
        }),
      })),
    };
    return new CommercialsService(
      dataSource as unknown as DataSource,
      {} as TaskTransitionService,
      {} as AnimationQueueService,
      {} as SystemSettingsService,
      {} as CreditsService,
      {} as MediaAssetsService,
    );
  }

  it('cena com clipe: engine + resolution; cena sem clipe: nulos', async () => {
    const view = await service().findOneProject('u1', 'p1');
    expect(view.scenes[0]).toMatchObject({
      id: 'sc1',
      finalUrl: '/uploads/commercials/u1/p1/scenes/0/g1/synced.mp4',
      engine: PRO,
      resolution: { width: 1080, height: 1440, premiumResolutionOk: true },
    });
    expect(view.scenes[1]).toMatchObject({ id: 'sc2', engine: null, resolution: null });
  });

  it('steps: talk concluído lê o asset; talk em voo lê o motor efetivo; tts fica sem motor', async () => {
    const view = await service().findOneProject('u1', 'p1');
    const byId = Object.fromEntries(view.steps.map((s) => [s.id, s]));
    expect(byId['st-talk-1']).toMatchObject({
      engine: PRO,
      resolution: { width: 1080, height: 1440, premiumResolutionOk: true },
      outputUrl: '/uploads/commercials/u1/p1/scenes/0/g1/synced.mp4',
      outputPosterUrl: '/uploads/commercials/u1/p1/scenes/0/g1/synced-poster.jpg',
    });
    expect(byId['st-talk-2']).toMatchObject({ engine: PRO, resolution: null, outputUrl: null });
    expect(byId['st-tts']).toMatchObject({
      engine: null,
      resolution: null,
      outputUrl: '/uploads/a.mp3',
    });
  });
});
