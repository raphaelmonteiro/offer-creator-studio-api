import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { EmailService } from '../../email/email.service';
import { CommercialsService } from '../commercials.service';
import { MC_PIPELINE_V2, McQualityState, resolveQuality } from '../domain/mc-quality';
import { McProjectStatus, McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { MC_CLIP_TEXT_ERROR_CODE } from '../domain/mc-error-classes';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McMaterializerService } from './mc-materializer.service';
import { McPipelineService } from './mc-pipeline.service';

type Row = Record<string, unknown> & { id: string };

function approvedQuality(revision: number, extra: Partial<McQualityState> = {}): McQualityState {
  return resolveQuality({
    approval: {
      scope: 'production',
      revision,
      manifestHash: 'h',
      approvedAt: 'now',
      userId: 'u1',
      budgetCredits: 0,
    },
    ...extra,
  });
}

describe('McPipelineService — pipeline v2 (gate do worker, retomada, liquidação por fase)', () => {
  let project: Row;
  let scene: Row;
  let steps: Row[];
  let manager: Record<string, jest.Mock>;
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let queue: { publish: jest.Mock };
  let credits: { refundUnconsumed: jest.Mock };
  let commercials: { appendEvent: jest.Mock };
  let materializer: { buildPreparationManifest: jest.Mock };
  let service: McPipelineService;

  beforeEach(() => {
    project = {
      id: 'p1',
      userId: 'u1',
      kitId: 'k1',
      status: McProjectStatus.GENERATING,
      pipelineVersion: MC_PIPELINE_V2,
      revision: 2,
      quality: approvedQuality(2),
      reservedCredits: 100,
      consumedCredits: 0,
      script: { schemaVersion: 2, version: 1, scenes: [] },
    };
    scene = {
      id: 'sc1',
      projectId: 'p1',
      idx: 0,
      generation: 1,
      status: McSceneStatus.PENDING,
      dialogue: null,
      sceneType: 'action',
      scriptSceneId: 's1',
    };
    steps = [];
    manager = {
      findOneByOrFail: jest.fn((entity: unknown, where: { id: string }) => {
        if (entity === McProject) return Promise.resolve(project);
        if (entity === McScene) return Promise.resolve(scene);
        if (entity === McCharacterKit) return Promise.resolve({ id: 'k1', version: 1 });
        const step = steps.find((s) => s.id === where.id);
        return step ? Promise.resolve(step) : Promise.reject(new Error('sem fixture'));
      }),
      findOneBy: jest.fn((entity: unknown, where: { id: string }) => {
        if (entity === McProject) return Promise.resolve(project);
        if (entity === McScene) return Promise.resolve(scene);
        return Promise.resolve(steps.find((s) => s.id === where.id) ?? null);
      }),
      find: jest.fn((entity: unknown) => {
        if (entity === McScene) return Promise.resolve([scene]);
        if (entity === McStep) return Promise.resolve(steps);
        return Promise.resolve([]);
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      increment: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn((where: { id: string }) => {
          if (entity === McProject) return Promise.resolve(project);
          if (entity === McStep)
            return Promise.resolve(steps.find((s) => s.id === where.id) ?? null);
          return Promise.resolve(null);
        }),
      })),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb(manager as unknown as EntityManager),
      ),
    };
    transitions = {
      casTransition: jest.fn().mockResolvedValue(true),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    credits = { refundUnconsumed: jest.fn().mockResolvedValue(0) };
    commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    queue = { publish: jest.fn().mockResolvedValue(undefined) };
    materializer = {
      buildPreparationManifest: jest
        .fn()
        .mockResolvedValue({ revision: 2, hash: 'manifest-hash', scenes: [], completedAt: 'now' }),
    };
    service = new McPipelineService(
      dataSource as unknown as DataSource,
      transitions as unknown as TaskTransitionService,
      queue as unknown as AnimationQueueService,
      credits as unknown as CreditsService,
      commercials as unknown as CommercialsService,
      { sendCommercialFinished: jest.fn() } as unknown as EmailService,
      materializer as unknown as McMaterializerService,
    );
  });

  function prodStep(over: Partial<Row> = {}): Row {
    return {
      id: 'st-video',
      projectId: 'p1',
      sceneId: 'sc1',
      sceneGeneration: 1,
      type: McStepType.VIDEO,
      status: McStepStatus.QUEUED,
      attempts: 0,
      projectRevision: 2,
      phase: 'production',
      costCredits: 89,
      providerJobId: null,
      ...over,
    };
  }

  describe('v2DenialReason / claimStep — nenhum job roda fora da revisão/fase aprovadas (ADR §4.1)', () => {
    it('produção autorizada: revisão igual, status generating e aprovação da revisão', () => {
      expect(
        service.v2DenialReason(prodStep() as unknown as McStep, project as unknown as McProject),
      ).toBeNull();
    });

    it('revisão antiga ⇒ superseded_revision (aprovação antiga não autoriza gasto)', () => {
      expect(
        service.v2DenialReason(
          prodStep({ projectRevision: 1 }) as unknown as McStep,
          project as unknown as McProject,
        ),
      ).toBe('superseded_revision');
    });

    it('sem aprovação da revisão ⇒ approval_missing; aprovação assembly_only não libera vídeo', () => {
      project.quality = resolveQuality({ approval: null });
      expect(
        service.v2DenialReason(prodStep() as unknown as McStep, project as unknown as McProject),
      ).toBe('approval_missing');
      project.quality = resolveQuality({
        approval: {
          scope: 'assembly_only',
          revision: 2,
          manifestHash: 'h',
          approvedAt: 'now',
          userId: 'u1',
          budgetCredits: 0,
        },
      });
      expect(
        service.v2DenialReason(prodStep() as unknown as McStep, project as unknown as McProject),
      ).toBe('approval_missing');
    });

    it('projeto fora de generating (visual_review/needs_attention/canceled) ⇒ phase_mismatch', () => {
      for (const status of [
        McProjectStatus.VISUAL_REVIEW,
        McProjectStatus.NEEDS_ATTENTION,
        McProjectStatus.CANCELED,
        McProjectStatus.PREPARING,
      ]) {
        project.status = status;
        expect(
          service.v2DenialReason(prodStep() as unknown as McStep, project as unknown as McProject),
        ).toBe('phase_mismatch');
      }
    });

    it('preparação só roda em preparing; steps legados (projectRevision null) nunca são negados', () => {
      project.status = McProjectStatus.PREPARING;
      project.quality = resolveQuality(null);
      expect(
        service.v2DenialReason(
          prodStep({ phase: 'preparation', type: McStepType.KEYFRAME }) as unknown as McStep,
          project as unknown as McProject,
        ),
      ).toBeNull();
      project.status = McProjectStatus.VISUAL_REVIEW;
      expect(
        service.v2DenialReason(
          prodStep({ phase: 'preparation', type: McStepType.KEYFRAME }) as unknown as McStep,
          project as unknown as McProject,
        ),
      ).toBe('phase_mismatch');
      expect(
        service.v2DenialReason(
          prodStep({ projectRevision: null, phase: null }) as unknown as McStep,
          project as unknown as McProject,
        ),
      ).toBeNull();
    });

    it('claimStep cancela o job negado (queued → canceled) sem executar nem consumir', async () => {
      steps = [prodStep({ projectRevision: 1 })];
      const claimed = await service.claimStep('st-video', McStepType.VIDEO);
      expect(claimed).toBeNull();
      expect(transitions.casTransition).toHaveBeenCalledWith(
        expect.anything(),
        McStep,
        'st-video',
        McStepStatus.QUEUED,
        McStepStatus.CANCELED,
        expect.objectContaining({ errorCode: 'superseded_revision' }),
      );
      // nunca chegou a running
      expect(transitions.casTransition).not.toHaveBeenCalledWith(
        expect.anything(),
        McStep,
        'st-video',
        McStepStatus.QUEUED,
        McStepStatus.RUNNING,
        expect.anything(),
      );
      expect(manager.increment).not.toHaveBeenCalled();
    });

    it('claimStep autorizado segue para running', async () => {
      steps = [prodStep()];
      const claimed = await service.claimStep('st-video', McStepType.VIDEO);
      expect(claimed?.status).toBe(McStepStatus.RUNNING);
    });

    it('assertSubmitAllowed revalida antes do submit pago: aprovação caiu ⇒ cancela e devolve false', async () => {
      const step = prodStep({ status: McStepStatus.RUNNING });
      steps = [step];
      expect(await service.assertSubmitAllowed(step as unknown as McStep)).toBe(true);
      project.revision = 3; // usuário editou entre o claim e o submit
      expect(await service.assertSubmitAllowed(step as unknown as McStep)).toBe(false);
      expect(transitions.casTransition).toHaveBeenCalledWith(
        expect.anything(),
        McStep,
        'st-video',
        McStepStatus.RUNNING,
        McStepStatus.CANCELED,
        expect.objectContaining({ errorCode: 'superseded_revision' }),
      );
      expect(commercials.appendEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: 'submit_denied' }),
      );
    });
  });

  describe('completeStepAndAdvance — preparação (ADR §4.1)', () => {
    it('step de preparação NUNCA marca a cena pronta; preparação completa ⇒ visual_review com manifesto', async () => {
      project.status = McProjectStatus.PREPARING;
      project.quality = resolveQuality({
        budgets: [
          {
            phase: 'preparation',
            revision: 2,
            quotedCredits: 1,
            reservedCredits: 1,
            consumedCredits: 0,
            refundedCredits: 0,
            ledgerKey: 'p1:preparation:r2',
            settledAt: null,
            items: [],
          },
        ],
      });
      const kf = prodStep({
        id: 'st-kf',
        type: McStepType.KEYFRAME,
        phase: 'preparation',
        status: McStepStatus.RUNNING,
        costCredits: 1,
      });
      steps = [kf];
      // após o CAS de sucesso, o step está succeeded no "banco"
      transitions.casTransition.mockImplementation(
        (_m: unknown, entity: unknown, id: string, _from: string, to: string) => {
          if (entity === McStep && id === 'st-kf') kf.status = to as McStepStatus;
          return Promise.resolve(true);
        },
      );
      const won = await service.completeStepAndAdvance(
        manager as unknown as EntityManager,
        kf as unknown as McStep,
        { from: McStepStatus.RUNNING, outputAssetId: 'a-kf', consumeOnSuccess: true },
      );
      expect(won).toBe(true);
      // cena NÃO vira ready (prévia pronta ≠ vídeo pronto)
      expect(transitions.casTransition).not.toHaveBeenCalledWith(
        expect.anything(),
        McScene,
        'sc1',
        McSceneStatus.RUNNING,
        McSceneStatus.READY,
        expect.anything(),
      );
      // projeto: preparing → visual_review com o manifesto assinado e a fase liquidada
      expect(materializer.buildPreparationManifest).toHaveBeenCalled();
      expect(transitions.casTransition).toHaveBeenCalledWith(
        expect.anything(),
        McProject,
        'p1',
        McProjectStatus.PREPARING,
        McProjectStatus.VISUAL_REVIEW,
        expect.objectContaining({
          quality: expect.objectContaining({
            preparation: expect.objectContaining({ hash: 'manifest-hash' }),
            resumePhase: null,
          }),
        }),
      );
      expect(credits.refundUnconsumed).toHaveBeenCalledWith(
        expect.anything(),
        'u1',
        'p1:preparation:r2',
        1,
        1,
      );
    });

    it('preparação incompleta (outra cena ainda pendente) não transiciona', async () => {
      project.status = McProjectStatus.PREPARING;
      const kf = prodStep({
        id: 'st-kf',
        type: McStepType.KEYFRAME,
        phase: 'preparation',
        status: McStepStatus.RUNNING,
      });
      const tts = prodStep({
        id: 'st-tts',
        type: McStepType.TTS,
        phase: 'preparation',
        status: McStepStatus.PENDING,
      });
      scene.sceneType = 'presenter';
      scene.dialogue = 'oi';
      steps = [kf, tts];
      transitions.casTransition.mockImplementation(
        (_m: unknown, entity: unknown, id: string, _f: string, to: string) => {
          if (entity === McStep && id === 'st-kf') kf.status = to as McStepStatus;
          return Promise.resolve(true);
        },
      );
      await service.completeStepAndAdvance(
        manager as unknown as EntityManager,
        kf as unknown as McStep,
        { from: McStepStatus.RUNNING, outputAssetId: 'a' },
      );
      expect(transitions.casTransition).not.toHaveBeenCalledWith(
        expect.anything(),
        McProject,
        'p1',
        McProjectStatus.PREPARING,
        McProjectStatus.VISUAL_REVIEW,
        expect.anything(),
      );
    });

    it('voiceover: video concluído não marca a cena pronta; scene_compose sim', async () => {
      scene.sceneType = 'action_voiceover';
      scene.dialogue = 'narração';
      const video = prodStep({ status: McStepStatus.INGESTING });
      steps = [video];
      await service.completeStepAndAdvance(
        manager as unknown as EntityManager,
        video as unknown as McStep,
        { from: McStepStatus.INGESTING, outputAssetId: 'vid' },
      );
      expect(transitions.casTransition).not.toHaveBeenCalledWith(
        expect.anything(),
        McScene,
        'sc1',
        McSceneStatus.RUNNING,
        McSceneStatus.READY,
        expect.anything(),
      );
      const compose = prodStep({
        id: 'st-compose',
        type: McStepType.SCENE_COMPOSE,
        status: McStepStatus.RUNNING,
      });
      steps = [video, compose];
      await service.completeStepAndAdvance(
        manager as unknown as EntityManager,
        compose as unknown as McStep,
        { from: McStepStatus.RUNNING, outputAssetId: 'final' },
      );
      expect(transitions.casTransition).toHaveBeenCalledWith(
        expect.anything(),
        McScene,
        'sc1',
        McSceneStatus.RUNNING,
        McSceneStatus.READY,
        expect.objectContaining({ finalAssetId: 'final' }),
      );
    });

    it('step final concluído em cena deixada `failed` (mesma geração): re-arma failed → pending e segue até ready', async () => {
      scene.status = McSceneStatus.FAILED;
      const video = prodStep({ status: McStepStatus.INGESTING });
      steps = [video];
      await service.completeStepAndAdvance(
        manager as unknown as EntityManager,
        video as unknown as McStep,
        { from: McStepStatus.INGESTING, outputAssetId: 'final' },
      );
      const sceneCalls = transitions.casTransition.mock.calls
        .filter((c) => c[1] === McScene)
        .map((c) => [c[3], c[4]]);
      expect(sceneCalls).toEqual([
        [McSceneStatus.FAILED, McSceneStatus.PENDING],
        [McSceneStatus.PENDING, McSceneStatus.RUNNING],
        [McSceneStatus.RUNNING, McSceneStatus.READY],
      ]);
    });

    it('cena pending: nenhuma tentativa de failed → pending', async () => {
      const video = prodStep({ status: McStepStatus.INGESTING });
      steps = [video];
      await service.completeStepAndAdvance(
        manager as unknown as EntityManager,
        video as unknown as McStep,
        { from: McStepStatus.INGESTING, outputAssetId: 'final' },
      );
      expect(transitions.casTransition).not.toHaveBeenCalledWith(
        expect.anything(),
        McScene,
        'sc1',
        McSceneStatus.FAILED,
        McSceneStatus.PENDING,
        expect.anything(),
      );
    });
  });

  describe('failStep — retomada por fase (ADR §4.1)', () => {
    it('reprovação por QUALIDADE (texto inventado) ⇒ failed → queued SEM o job antigo do provider, republicado no submit', async () => {
      project.status = McProjectStatus.GENERATING;
      const video = prodStep({
        status: McStepStatus.INGESTING,
        attempts: 1,
        providerJobId: 'job-antigo',
        provider: 'fal-ai/kling-video/ai-avatar/v2/standard',
      });
      steps = [video];
      await service.failStep(
        video as unknown as McStep,
        McStepStatus.INGESTING,
        new TerminalProviderError('legenda embaralhada', MC_CLIP_TEXT_ERROR_CODE),
      );
      expect(transitions.casTransition).toHaveBeenCalledWith(
        expect.anything(),
        McStep,
        'st-video',
        McStepStatus.INGESTING,
        McStepStatus.FAILED,
        expect.objectContaining({ errorClass: 'quality', providerJobId: null, provider: null }),
      );
      expect(transitions.casTransition).toHaveBeenCalledWith(
        expect.anything(),
        McStep,
        'st-video',
        McStepStatus.FAILED,
        McStepStatus.QUEUED,
      );
      expect(queue.publish).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ stepId: 'st-video' }),
        expect.objectContaining({ startAfterSeconds: expect.any(Number) }),
      );
      // a cena NÃO cai em failed nem o projeto em needs_attention: é retry, não falha terminal
      expect(transitions.casTransition).not.toHaveBeenCalledWith(
        expect.anything(),
        McProject,
        'p1',
        McProjectStatus.GENERATING,
        McProjectStatus.NEEDS_ATTENTION,
        expect.anything(),
      );
    });

    it('falha terminal em preparing ⇒ needs_attention com resumePhase=preparation', async () => {
      project.status = McProjectStatus.PREPARING;
      const kf = prodStep({
        id: 'st-kf',
        type: McStepType.KEYFRAME,
        phase: 'preparation',
        status: McStepStatus.RUNNING,
        attempts: 5,
      });
      steps = [kf];
      await service.failStep(
        kf as unknown as McStep,
        McStepStatus.RUNNING,
        new Error('bloqueado'),
        { errorClass: 'content_policy' },
      );
      expect(transitions.casTransition).toHaveBeenCalledWith(
        expect.anything(),
        McProject,
        'p1',
        McProjectStatus.PREPARING,
        McProjectStatus.NEEDS_ATTENTION,
        expect.objectContaining({
          quality: expect.objectContaining({ resumePhase: 'preparation' }),
        }),
      );
    });

    it('falha terminal em generating ⇒ resumePhase=production; assembly v2 ⇒ needs_attention (assembly), não failed', async () => {
      const video = prodStep({ status: McStepStatus.PROVIDER_WAIT, attempts: 5 });
      steps = [video];
      await service.failStep(
        video as unknown as McStep,
        McStepStatus.PROVIDER_WAIT,
        new Error('timeout'),
        { errorClass: 'provider_timeout' },
      );
      expect(transitions.casTransition).toHaveBeenCalledWith(
        expect.anything(),
        McProject,
        'p1',
        McProjectStatus.GENERATING,
        McProjectStatus.NEEDS_ATTENTION,
        expect.objectContaining({
          quality: expect.objectContaining({ resumePhase: 'production' }),
        }),
      );

      project.status = McProjectStatus.ASSEMBLING;
      const asm = prodStep({
        id: 'st-asm',
        type: McStepType.ASSEMBLY,
        phase: 'assembly',
        sceneId: null,
        status: McStepStatus.RUNNING,
        attempts: 5,
      });
      steps = [asm];
      await service.failStep(
        asm as unknown as McStep,
        McStepStatus.RUNNING,
        new Error('ffmpeg saiu com código 1'),
        { errorClass: 'internal' },
      );
      expect(transitions.casTransition).toHaveBeenCalledWith(
        expect.anything(),
        McProject,
        'p1',
        McProjectStatus.ASSEMBLING,
        McProjectStatus.NEEDS_ATTENTION,
        expect.objectContaining({ quality: expect.objectContaining({ resumePhase: 'assembly' }) }),
      );
      expect(transitions.casTransition).not.toHaveBeenCalledWith(
        expect.anything(),
        McProject,
        'p1',
        McProjectStatus.ASSEMBLING,
        McProjectStatus.FAILED,
        expect.anything(),
      );
      // sem estorno da reserva do projeto inteiro (as fases seguem abertas para a retomada)
      expect(credits.refundUnconsumed).not.toHaveBeenCalledWith(
        expect.anything(),
        'u1',
        'p1',
        100,
        0,
      );
    });
  });

  describe('steps de projeto do F1 — compose_ffmpeg → finalize (tarefa 4.3, D6)', () => {
    beforeEach(() => {
      project.format = 'talking_art';
      scene = {
        ...scene,
        sceneType: 'talk_tile',
        dialogue: 'fala',
        status: McSceneStatus.READY,
        finalAssetId: 'clip',
      };
    });

    it('todos os finais prontos: compose_ffmpeg vai para mc.ffmpeg com o type no payload e o projeto entra em assembling', async () => {
      project.status = McProjectStatus.GENERATING;
      steps = [
        prodStep({ id: 'st-talk', type: McStepType.TALK, status: McStepStatus.SUCCEEDED }),
        prodStep({
          id: 'st-compose',
          type: McStepType.COMPOSE_FFMPEG,
          phase: 'assembly',
          sceneId: null,
          sceneGeneration: null,
          status: McStepStatus.PENDING,
        }),
        prodStep({
          id: 'st-finalize',
          type: McStepType.FINALIZE,
          phase: 'assembly',
          sceneId: null,
          sceneGeneration: null,
          status: McStepStatus.PENDING,
        }),
      ];
      const enqueued = await service.enqueueReadySteps(manager as unknown as EntityManager, 'p1');
      expect(enqueued).toEqual(['st-compose']);
      expect(queue.publish).toHaveBeenCalledWith(
        QUEUES.MC_FFMPEG,
        { stepId: 'st-compose', projectId: 'p1', type: McStepType.COMPOSE_FFMPEG },
        expect.objectContaining({ expireInSeconds: 600 }),
      );
      expect(transitions.casTransition).toHaveBeenCalledWith(
        expect.anything(),
        McProject,
        'p1',
        McProjectStatus.GENERATING,
        McProjectStatus.ASSEMBLING,
      );
      // o finalize só depois do compose; nunca um assembly
      expect(queue.publish).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ stepId: 'st-finalize' }),
        expect.anything(),
      );
    });

    it('o job vai NA MESMA transação do step (regressão e2e F2: job consumido antes do commit era descartado)', async () => {
      project.status = McProjectStatus.GENERATING;
      steps = [
        prodStep({ id: 'st-talk', type: McStepType.TALK, status: McStepStatus.SUCCEEDED }),
        prodStep({
          id: 'st-compose',
          type: McStepType.COMPOSE_FFMPEG,
          phase: 'assembly',
          sceneId: null,
          sceneGeneration: null,
          status: McStepStatus.PENDING,
        }),
      ];
      const enqueued = await service.enqueueReadySteps(manager as unknown as EntityManager, 'p1');
      expect(enqueued).toEqual(['st-compose']);
      // o manager da transação viaja nas opções: a fila grava o job pelo MESMO
      // query runner (visível ao worker só no commit), nunca pelo pool do pg-boss
      expect(queue.publish).toHaveBeenCalledTimes(1);
      expect(queue.publish.mock.calls[0][2]).toEqual(expect.objectContaining({ manager }));
    });

    it('compose concluído (assembling) enfileira o finalize sem nova transição de projeto', async () => {
      project.status = McProjectStatus.ASSEMBLING;
      steps = [
        prodStep({
          id: 'st-compose',
          type: McStepType.COMPOSE_FFMPEG,
          phase: 'assembly',
          sceneId: null,
          sceneGeneration: null,
          status: McStepStatus.SUCCEEDED,
        }),
        prodStep({
          id: 'st-finalize',
          type: McStepType.FINALIZE,
          phase: 'assembly',
          sceneId: null,
          sceneGeneration: null,
          status: McStepStatus.PENDING,
        }),
      ];
      const enqueued = await service.enqueueReadySteps(manager as unknown as EntityManager, 'p1');
      expect(enqueued).toEqual(['st-finalize']);
      expect(queue.publish).toHaveBeenCalledWith(
        QUEUES.MC_FFMPEG,
        expect.objectContaining({ stepId: 'st-finalize', type: McStepType.FINALIZE }),
        expect.anything(),
      );
      expect(transitions.casTransition).not.toHaveBeenCalledWith(
        expect.anything(),
        McProject,
        'p1',
        McProjectStatus.GENERATING,
        McProjectStatus.ASSEMBLING,
      );
    });

    it('falha terminal do compose_ffmpeg/finalize ⇒ needs_attention com resumePhase=assembly (clipes e reservas ficam)', async () => {
      project.status = McProjectStatus.ASSEMBLING;
      for (const type of [McStepType.COMPOSE_FFMPEG, McStepType.FINALIZE]) {
        transitions.casTransition.mockClear();
        const step = prodStep({
          id: `st-${type}`,
          type,
          phase: 'assembly',
          sceneId: null,
          sceneGeneration: null,
          status: McStepStatus.RUNNING,
          attempts: 5,
        });
        steps = [step];
        await service.failStep(
          step as unknown as McStep,
          McStepStatus.RUNNING,
          new Error('ffmpeg saiu com código 1'),
          { errorClass: 'internal' },
        );
        expect(transitions.casTransition).toHaveBeenCalledWith(
          expect.anything(),
          McProject,
          'p1',
          McProjectStatus.ASSEMBLING,
          McProjectStatus.NEEDS_ATTENTION,
          expect.objectContaining({
            quality: expect.objectContaining({ resumePhase: 'assembly' }),
          }),
        );
        expect(transitions.casTransition).not.toHaveBeenCalledWith(
          expect.anything(),
          McProject,
          'p1',
          McProjectStatus.ASSEMBLING,
          McProjectStatus.FAILED,
          expect.anything(),
        );
      }
    });
  });

  describe('succeedProject v2 — preço fechado por fase (ADR §4.3)', () => {
    it('liquida produção/assembly pelas chaves das fases; NÃO consome a reserva integral do projeto', async () => {
      project.status = McProjectStatus.ASSEMBLING;
      project.quality = approvedQuality(2, {
        budgets: [
          {
            phase: 'preparation',
            revision: 2,
            quotedCredits: 5,
            reservedCredits: 5,
            consumedCredits: 5,
            refundedCredits: 0,
            ledgerKey: 'p1:preparation:r2',
            settledAt: 'done',
            items: [],
          },
          {
            phase: 'production',
            revision: 2,
            quotedCredits: 178,
            reservedCredits: 178,
            consumedCredits: 0,
            refundedCredits: 0,
            ledgerKey: 'p1:production:r2',
            settledAt: null,
            items: [],
          },
        ],
      });
      steps = [
        prodStep({
          id: 'v1',
          status: McStepStatus.SUCCEEDED,
          providerJobId: 'job-1',
          costCredits: 89,
        }),
        prodStep({ id: 'v2', status: McStepStatus.SKIPPED_CACHED, costCredits: 89 }), // reaproveitado: não cobra
      ];
      credits.refundUnconsumed.mockResolvedValue(89);
      const won = await service.succeedProject(
        manager as unknown as EntityManager,
        'p1',
        'final-asset',
      );
      expect(won).toBe(true);
      const patch = transitions.casTransition.mock.calls.find(
        (c) => c[1] === McProject && c[4] === McProjectStatus.SUCCEEDED,
      )?.[5] as { consumedCredits?: number; quality: McQualityState };
      expect(patch.consumedCredits).toBeUndefined(); // legado consumia max(reserved, consumed)
      const production = patch.quality.budgets.find((b) => b.phase === 'production')!;
      expect(production.consumedCredits).toBe(89);
      expect(production.refundedCredits).toBe(89);
      expect(production.settledAt).not.toBeNull();
      expect(credits.refundUnconsumed).toHaveBeenCalledWith(
        expect.anything(),
        'u1',
        'p1:production:r2',
        178,
        89,
      );
      // a fase de preparação já liquidada não é tocada de novo
      expect(credits.refundUnconsumed).not.toHaveBeenCalledWith(
        expect.anything(),
        'u1',
        'p1:preparation:r2',
        expect.anything(),
        expect.anything(),
      );
    });

    it('projeto legado mantém o consumo integral da reserva', async () => {
      project.status = McProjectStatus.ASSEMBLING;
      project.pipelineVersion = 1;
      project.quality = null;
      await service.succeedProject(manager as unknown as EntityManager, 'p1', 'final');
      const patch = transitions.casTransition.mock.calls.find(
        (c) => c[1] === McProject && c[4] === McProjectStatus.SUCCEEDED,
      )?.[5] as { consumedCredits?: number };
      expect(patch.consumedCredits).toBe(100);
      expect(credits.refundUnconsumed).not.toHaveBeenCalled();
    });
  });
});
