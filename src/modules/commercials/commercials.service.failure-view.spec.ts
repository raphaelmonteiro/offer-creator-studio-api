import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CreditsService } from '../../shared/credits/credits.service';
import { MediaAssetsService } from '../../shared/media-assets/media-assets.service';
import { AnimationQueueService } from '../../shared/queue/animation-queue.service';
import { SystemSettingsService } from '../../shared/settings/system-settings.service';
import { TaskTransitionService } from '../../shared/state/task-transition.service';
import { CommercialsService } from './commercials.service';
import { McProjectStatus, McSceneStatus, McStepStatus } from './domain/mc-state-machines';
import { McStepType } from './domain/mc-types';
import { McProject } from './entities/mc-project.entity';
import { McScene } from './entities/mc-scene.entity';
import { McStep } from './entities/mc-step.entity';

const P27 =
  'O estúdio de vídeo está indisponível no momento. Nossa equipe já foi avisada; tente de novo mais tarde.';
const RAW = 'HTTP 403: {"detail":"User is locked. Reason: Exhausted balance"}';

/** `GET projects/:id` e a lista: motivo e ação recomputados do `errorCode` (design B4). */
describe('CommercialsService — campos de falha em pt-BR (video-worker-confiabilidade, 1.5)', () => {
  let projects: Array<Record<string, unknown>>;
  let scenes: Array<Record<string, unknown>>;
  let steps: Array<Record<string, unknown>>;

  beforeEach(() => {
    projects = [
      {
        id: 'p1',
        userId: 'u1',
        status: McProjectStatus.NEEDS_ATTENTION,
        revision: 1,
        errorCode: 'quota',
        // linha antiga: mensagem crua em inglês gravada
        errorMessage: RAW,
        finalAssetId: null,
        quality: { resumePhase: 'production' },
      },
    ];
    scenes = [
      {
        id: 'sc1',
        projectId: 'p1',
        idx: 0,
        status: McSceneStatus.FAILED,
        errorCode: 'quota',
        errorMessage: RAW,
      },
      { id: 'sc2', projectId: 'p1', idx: 1, status: McSceneStatus.READY, errorCode: null },
    ];
    steps = [
      {
        id: 'st1',
        projectId: 'p1',
        sceneId: 'sc1',
        type: McStepType.TALK,
        status: McStepStatus.FAILED,
        errorClass: 'quota',
        errorCode: 'quota',
        errorMessage: RAW,
      },
    ];
  });

  function service(): CommercialsService {
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn((where: { id: string }) =>
          Promise.resolve(
            entity === McProject ? (projects.find((p) => p.id === where.id) ?? null) : null,
          ),
        ),
        find: jest.fn(() =>
          Promise.resolve(entity === McScene ? scenes : entity === McStep ? steps : projects),
        ),
        findOne: jest.fn(),
      })),
    };
    return new CommercialsService(
      dataSource as unknown as DataSource,
      {} as TaskTransitionService,
      {} as AnimationQueueService,
      {} as SystemSettingsService,
      {} as CreditsService,
      { resolveAssetUrls: jest.fn() } as unknown as MediaAssetsService,
    );
  }

  it('cota: projeto, cena e step trazem o texto de P-27 e nunca a mensagem crua; ação tentar_mais_tarde', async () => {
    const view = await service().findOneProject('u1', 'p1');
    expect(view).toMatchObject({
      errorCode: 'quota',
      errorMessage: P27,
      errorAction: 'tentar_mais_tarde',
      quality: { resumePhase: 'production' },
    });
    expect(view.scenes[0]).toMatchObject({
      errorCode: 'quota',
      errorMessage: P27,
      errorAction: 'tentar_mais_tarde',
    });
    expect(view.scenes[1]).toMatchObject({ errorMessage: null, errorAction: null });
    expect(view.steps[0]).toMatchObject({
      errorClass: 'quota',
      errorCode: 'quota',
      errorMessage: P27,
    });
    expect(JSON.stringify(view)).not.toMatch(/Exhausted|locked|HTTP 403/);
  });

  it('projeto antigo sem errorMessage ganha o texto do código; sem errorCode fica null', async () => {
    projects[0].errorMessage = null;
    projects[0].errorCode = 'provider_transient';
    const view = await service().findOneProject('u1', 'p1');
    expect(view.errorMessage).toMatch(/fora do ar/);
    expect(view.errorAction).toBe('refazer');

    projects[0].errorCode = null;
    const clean = await service().findOneProject('u1', 'p1');
    expect(clean).toMatchObject({ errorMessage: null, errorAction: null });
  });

  it('código desconhecido → texto genérico, código original preservado', async () => {
    projects[0].errorCode = 'tts_failed';
    const view = await service().findOneProject('u1', 'p1');
    expect(view.errorCode).toBe('tts_failed');
    expect(view.errorMessage).toBe('Algo deu errado na produção do vídeo. Tente refazer.');
  });

  it('repetir a consulta devolve o mesmo corpo (leitura pura)', async () => {
    const first = await service().findOneProject('u1', 'p1');
    const second = await service().findOneProject('u1', 'p1');
    expect(second).toEqual(first);
  });

  it('projeto de outro usuário → 403 sem errorMessage; inexistente → 404', async () => {
    const err = await service()
      .findOneProject('u2', 'p1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(JSON.stringify((err as ForbiddenException).getResponse())).not.toMatch(
      /errorMessage|estúdio/,
    );
    await expect(service().findOneProject('u1', 'nao-existe')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('a lista aplica a mesma transformação em cada item', async () => {
    const list = await service().findAllProjects('u1');
    expect(list[0]).toMatchObject({ errorMessage: P27, errorAction: 'tentar_mais_tarde' });
  });
});
