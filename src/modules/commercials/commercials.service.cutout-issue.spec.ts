import { DataSource } from 'typeorm';
import { CreditsService } from '../../shared/credits/credits.service';
import { MediaAssetsService } from '../../shared/media-assets/media-assets.service';
import { AnimationQueueService } from '../../shared/queue/animation-queue.service';
import { SystemSettingsService } from '../../shared/settings/system-settings.service';
import { TaskTransitionService } from '../../shared/state/task-transition.service';
import { CommercialsService } from './commercials.service';
import { McProjectStatus, McStepStatus } from './domain/mc-state-machines';
import { McStepType } from './domain/mc-types';
import { McEvent } from './entities/mc-event.entity';
import { McProject } from './entities/mc-project.entity';
import { McStep } from './entities/mc-step.entity';

/** `GET projects/:id`: `availableActions` e `cutoutIssue` do recorte reprovado (D7). */
describe('CommercialsService.findOneProject — recorte reprovado (video-mascote-transparente, 1.8)', () => {
  let project: Record<string, unknown>;
  let steps: Array<Record<string, unknown>>;
  let events: Array<Record<string, unknown>>;
  let eventFind: jest.Mock;

  beforeEach(() => {
    project = {
      id: 'p1',
      userId: 'u1',
      tier: 'economico',
      format: 'offer_piece',
      status: McProjectStatus.NEEDS_ATTENTION,
      revision: 4,
      errorCode: 'character_cutout_failed',
      finalAssetId: null,
      quality: null,
    };
    steps = [
      {
        id: 'cmp-ok',
        projectId: 'p1',
        sceneId: null,
        type: McStepType.COMPOSE_FFMPEG,
        status: McStepStatus.FAILED,
        projectRevision: 3,
        inputSnapshot: {},
      },
      {
        id: 'cmp-1',
        projectId: 'p1',
        sceneId: null,
        type: McStepType.COMPOSE_FFMPEG,
        status: McStepStatus.FAILED,
        projectRevision: 4,
        inputSnapshot: {},
      },
    ];
    events = [
      {
        refId: 'cmp-1',
        kind: 'cutout_rejected',
        detail: {
          keyColor: '#00B140',
          framing: 'corpo',
          scenes: [
            {
              sceneId: 'sc2',
              idx: 1,
              reasons: ['background_unstable'],
              metrics: { backgroundDrift: 6.4 },
            },
          ],
        },
      },
    ];
    eventFind = jest.fn(() => Promise.resolve(events[0] ?? null));
  });

  function service(): CommercialsService {
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn(() => Promise.resolve(entity === McProject ? project : null)),
        findOne: entity === McEvent ? eventFind : jest.fn(),
        find: jest.fn(() => Promise.resolve(entity === McStep ? steps : [])),
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

  it('needs_attention por recorte: ações e relatório com os mesmos nomes, motivos em pt-BR', async () => {
    const view = await service().findOneProject('u1', 'p1');
    expect(view.availableActions).toEqual(['gerar_fala_de_novo', 'usar_painel_liso']);
    expect(view.cutoutIssue).toEqual({
      code: 'character_cutout_failed',
      message: expect.stringContaining('1 fala(s)'),
      keyColor: '#00B140',
      scenes: [
        {
          sceneId: 'sc2',
          idx: 1,
          reasons: [
            { code: 'background_unstable', message: 'O fundo mudou de tom durante a fala.' },
          ],
          metrics: { backgroundDrift: 6.4 },
        },
      ],
      actions: ['gerar_fala_de_novo', 'usar_painel_liso'],
    });
    // só o compose falho da revisão corrente entra na consulta
    expect(eventFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ kind: 'cutout_rejected' }) }),
    );
    const ids = (eventFind.mock.calls[0][0] as { where: { refId: { _value: string[] } } }).where
      .refId._value;
    expect(ids).toEqual(['cmp-1']);
  });

  it('fora do estado (outro erro, ou outro status) cutoutIssue é null', async () => {
    project.errorCode = 'compose_failed';
    expect((await service().findOneProject('u1', 'p1')).cutoutIssue).toBeNull();
    project.errorCode = 'character_cutout_failed';
    project.status = McProjectStatus.SUCCEEDED;
    const view = await service().findOneProject('u1', 'p1');
    expect(view.cutoutIssue).toBeNull();
    expect(view.availableActions).toEqual([]);
  });
});
