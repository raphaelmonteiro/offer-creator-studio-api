import { Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { EmailService } from '../../email/email.service';
import { CommercialsService } from '../commercials.service';
import { MC_PIPELINE_LEGACY, MC_PIPELINE_V2, resolveQuality } from '../domain/mc-quality';
import { McProjectStatus, McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McMaterializerService } from './mc-materializer.service';
import { McPipelineService } from './mc-pipeline.service';

/**
 * P-33 (change video-fala-continua, 1.7, D19): refazer uma fala/cena com outras também em falha não
 * pode deixar o projeto em `generating` sem ações. `parkIfOnlyFailuresRemain` o devolve a
 * `needs_attention` com o motivo da falha que resta; vale no modo de hoje e no contínuo.
 */
type Row = Record<string, unknown> & { id: string };

describe('McPipelineService.parkIfOnlyFailuresRemain (P-33)', () => {
  let project: Row;
  let scenes: Row[];
  let steps: Row[];
  let events: Array<{ kind: string; detail: Record<string, unknown> }>;
  let casCalls: Array<{ entity: unknown; from: unknown; to: unknown; patch: Row }>;
  let service: McPipelineService;

  const scene = (
    id: string,
    idx: number,
    status: McSceneStatus,
    error?: [string, string],
  ): Row => ({
    id,
    idx,
    projectId: 'p1',
    scriptSceneId: `s${idx}`,
    status,
    errorCode: error?.[0] ?? null,
    errorMessage: error?.[1] ?? null,
  });
  const step = (id: string, status: McStepStatus): Row => ({
    id,
    projectId: 'p1',
    status,
    type: McStepType.TALK,
  });

  beforeEach(() => {
    project = {
      id: 'p1',
      userId: 'u1',
      status: McProjectStatus.GENERATING,
      pipelineVersion: MC_PIPELINE_V2,
      revision: 1,
      quality: resolveQuality(null),
    };
    scenes = [
      scene('a', 0, McSceneStatus.READY),
      scene('b', 1, McSceneStatus.FAILED, [
        'provider_transient',
        'O serviço de produção do vídeo está fora do ar no momento. Tente de novo em alguns minutos.',
      ]),
      scene('c', 2, McSceneStatus.FAILED, [
        'quota',
        'O estúdio de vídeo está indisponível no momento. Nossa equipe já foi avisada; tente de novo mais tarde.',
      ]),
    ];
    steps = [
      step('t-b', McStepStatus.FAILED),
      step('t-c', McStepStatus.FAILED),
      step('t-a', McStepStatus.SUCCEEDED),
    ];
    events = [];
    casCalls = [];
    const manager = {
      findOneByOrFail: jest.fn(() => Promise.resolve(project)),
      find: jest.fn((entity: unknown) =>
        Promise.resolve(entity === McScene ? scenes : entity === McStep ? steps : []),
      ),
      count: jest.fn((_e: unknown, opts: { where: { status: { _value: McStepStatus[] } } }) =>
        Promise.resolve(
          steps.filter((s) => opts.where.status._value.includes(s.status as McStepStatus)).length,
        ),
      ),
      query: jest.fn().mockResolvedValue([]),
    };
    const transitions = {
      casTransition: jest.fn(
        (
          _m: unknown,
          entity: unknown,
          _id: string,
          from: unknown,
          to: unknown,
          patch: Row = { id: '' },
        ) => {
          casCalls.push({ entity, from, to, patch });
          if (entity === McProject) Object.assign(project, { status: to }, patch);
          return Promise.resolve(true);
        },
      ),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    const commercials = {
      appendEvent: jest.fn((_m: unknown, e: { kind: string; detail: Record<string, unknown> }) => {
        events.push({ kind: e.kind, detail: e.detail });
        return Promise.resolve();
      }),
    };
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    service = new McPipelineService(
      { transaction: jest.fn() } as unknown as DataSource,
      transitions as unknown as TaskTransitionService,
      { publish: jest.fn() } as unknown as AnimationQueueService,
      { refundUnconsumed: jest.fn() } as unknown as CreditsService,
      commercials as unknown as CommercialsService,
      { sendCommercialFinished: jest.fn() } as unknown as EmailService,
      {} as unknown as McMaterializerService,
    );
    (service as unknown as { __manager: unknown }).__manager = manager;
  });

  afterEach(() => jest.restoreAllMocks());

  const park = () =>
    service.parkIfOnlyFailuresRemain(
      (service as unknown as { __manager: EntityManager }).__manager,
      'p1',
    );

  it('duas falas em falha, a regravada terminou e nada anda: volta a needs_attention com o motivo da 1ª que resta (por idx) e resumePhase production', async () => {
    await expect(park()).resolves.toBe(true);
    expect(project.status).toBe(McProjectStatus.NEEDS_ATTENTION);
    expect(project.errorCode).toBe('provider_transient');
    expect(String(project.errorMessage)).toContain('fora do ar');
    expect((project.quality as { resumePhase: string }).resumePhase).toBe('production');
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'transition',
        detail: expect.objectContaining({
          reason: 'remaining_failures',
          sceneId: 's1',
          failedScenes: 2,
        }),
      }),
    ]);
    expect(casCalls[0]).toMatchObject({
      entity: McProject,
      from: McProjectStatus.GENERATING,
      to: McProjectStatus.NEEDS_ATTENTION,
    });
  });

  it('com step ainda andando (queued, running, provider_wait ou ingesting) o projeto continua em generating', async () => {
    for (const status of [
      McStepStatus.QUEUED,
      McStepStatus.RUNNING,
      McStepStatus.PROVIDER_WAIT,
      McStepStatus.INGESTING,
    ]) {
      steps.push(step('active', status));
      await expect(park()).resolves.toBe(false);
      expect(project.status).toBe(McProjectStatus.GENERATING);
      steps.pop();
    }
    expect(casCalls).toHaveLength(0);
  });

  it('sem falha restante a cadeia de montagem segue: nada muda', async () => {
    scenes[1].status = McSceneStatus.READY;
    scenes[2].status = McSceneStatus.READY;
    await expect(park()).resolves.toBe(false);
    expect(project.status).toBe(McProjectStatus.GENERATING);
  });

  it('só atua em generating do pipeline v2 (needs_attention já tem ações; legado não tem reroll por cena)', async () => {
    project.status = McProjectStatus.NEEDS_ATTENTION;
    await expect(park()).resolves.toBe(false);
    project.status = McProjectStatus.GENERATING;
    project.pipelineVersion = MC_PIPELINE_LEGACY;
    await expect(park()).resolves.toBe(false);
    expect(casCalls).toHaveLength(0);
  });

  it('cena cancelada não conta como falha; cena pending esperando a junção não impede o parqueamento', async () => {
    scenes[1].status = McSceneStatus.CANCELED;
    scenes.push(scene('d', 3, McSceneStatus.PENDING));
    await expect(park()).resolves.toBe(true);
    expect(project.errorCode).toBe('quota');
  });

  it('perder o CAS (outro caminho já moveu o projeto) não grava evento', async () => {
    (
      service as unknown as { transitions: { casTransition: jest.Mock } }
    ).transitions.casTransition.mockResolvedValue(false);
    await expect(park()).resolves.toBe(false);
    expect(events).toHaveLength(0);
  });
});
