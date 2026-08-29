import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { EmailService } from '../../email/email.service';
import { CommercialsService } from '../commercials.service';
import { McProjectStatus, McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from './mc-pipeline.service';

type Row = Record<string, unknown> & { id: string };

/** Estado em memória: find/findOneBy(OrFail) resolvem por entidade; CAS é mockado à parte. */
function fixture(opts: { project: Row; scenes?: Row[]; steps?: Row[] }) {
  const state = { project: opts.project, scenes: opts.scenes ?? [], steps: opts.steps ?? [] };
  const pick = (entity: unknown): Row[] => {
    if (entity === McProject) return [state.project];
    if (entity === McScene) return state.scenes;
    if (entity === McStep) return state.steps;
    return [];
  };
  const manager = {
    find: jest.fn((entity: unknown) => Promise.resolve(pick(entity))),
    findOneBy: jest.fn((entity: unknown, where: { id: string }) =>
      Promise.resolve(pick(entity).find((r) => r.id === where.id) ?? null),
    ),
    findOneByOrFail: jest.fn((entity: unknown, where: { id: string }) => {
      const row = pick(entity).find((r) => r.id === where.id);
      return row ? Promise.resolve(row) : Promise.reject(new Error('not found'));
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    increment: jest.fn().mockResolvedValue(undefined),
    insert: jest.fn().mockResolvedValue(undefined),
  };
  const dataSource = {
    getRepository: jest.fn((entity: unknown) => ({
      findOneBy: (where: { id: string }) =>
        Promise.resolve(pick(entity).find((r) => r.id === where.id) ?? null),
    })),
    transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager as unknown as EntityManager),
    ),
    // users é lido por query crua no e-mail de conclusão (sem acoplar auth).
    query: jest.fn().mockResolvedValue([{ email: 'dono@loja.com', name: 'Dono' }]),
  };
  return { state, manager, dataSource };
}

describe('McPipelineService — avanço do scheduler e política de falha (plano §6.2/§6.4)', () => {
  const userId = 'u1';
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let queue: { publish: jest.Mock };
  let credits: { refundUnconsumed: jest.Mock };
  let commercials: { appendEvent: jest.Mock };
  let email: { sendCommercialFinished: jest.Mock };

  function build(fx: ReturnType<typeof fixture>): McPipelineService {
    return new McPipelineService(
      fx.dataSource as unknown as DataSource,
      transitions as unknown as TaskTransitionService,
      queue as unknown as AnimationQueueService,
      credits as unknown as CreditsService,
      commercials as unknown as CommercialsService,
      email as unknown as EmailService,
    );
  }

  beforeEach(() => {
    transitions = {
      casTransition: jest.fn().mockResolvedValue(true),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    queue = { publish: jest.fn().mockResolvedValue(undefined) };
    credits = { refundUnconsumed: jest.fn().mockResolvedValue(0) };
    commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    email = { sendCommercialFinished: jest.fn().mockResolvedValue(undefined) };
  });

  const project = (status = McProjectStatus.GENERATING): Row => ({
    id: 'p1',
    userId,
    status,
    reservedCredits: 160,
    consumedCredits: 5,
  });

  const spokenScene = (status = McSceneStatus.RUNNING): Row => ({
    id: 'sc1',
    projectId: 'p1',
    idx: 0,
    generation: 1,
    status,
    dialogue: 'Olá!',
    durationS: 10,
  });

  function step(type: McStepType, status: McStepStatus, extra: Partial<Row> = {}): Row {
    return {
      id: `st-${type}`,
      projectId: 'p1',
      sceneId: type === McStepType.ASSEMBLY ? null : 'sc1',
      sceneGeneration: type === McStepType.ASSEMBLY ? null : 1,
      type,
      status,
      costCredits: type === McStepType.LIPSYNC ? 56 : type === McStepType.TTS ? 4 : 1,
      attempts: 1,
      providerJobId: null,
      ...extra,
    };
  }

  it('conclusão do tts com keyframe pronto destrava o lipsync NA MESMA transação (§6.2)', async () => {
    const fx = fixture({
      project: project(),
      scenes: [spokenScene()],
      steps: [
        step(McStepType.KEYFRAME, McStepStatus.SUCCEEDED),
        step(McStepType.TTS, McStepStatus.SUCCEEDED), // estado pós-CAS
        step(McStepType.VIDEO, McStepStatus.SKIPPED_CACHED),
        step(McStepType.LIPSYNC, McStepStatus.PENDING),
        step(McStepType.ASSEMBLY, McStepStatus.PENDING),
      ],
    });
    const service = build(fx);
    const tts = fx.state.steps[1] as unknown as McStep;

    const won = await service.completeStepAndAdvance(fx.manager as unknown as EntityManager, tts, {
      from: McStepStatus.RUNNING,
      outputAssetId: 'asset-tts',
      consumeOnSuccess: true,
    });

    expect(won).toBe(true);
    // consumo no sucesso (§6.7): incrementa consumedCredits do projeto
    expect(fx.manager.increment).toHaveBeenCalledWith(
      McProject,
      { id: 'p1' },
      'consumedCredits',
      4,
    );
    // atalho da cena
    expect(fx.manager.update).toHaveBeenCalledWith(
      McScene,
      { id: 'sc1' },
      { audioAssetId: 'asset-tts' },
    );
    // lipsync foi enfileirado no mc.submit
    const submitCall = queue.publish.mock.calls.find(([q]) => q === QUEUES.MC_SUBMIT);
    expect(submitCall).toBeDefined();
    expect(submitCall?.[1]).toMatchObject({ stepId: 'st-lipsync' });
    expect(submitCall?.[2]).toMatchObject({ expireInSeconds: 120 });
    // assembly ainda não (cena sem final)
    expect(queue.publish.mock.calls.some(([q]) => q === QUEUES.MC_FFMPEG)).toBe(false);
  });

  it('lipsync (step final) conclui → cena ready com finalAssetId → assembly enfileirado + projeto assembling', async () => {
    const fx = fixture({
      project: project(),
      scenes: [spokenScene(McSceneStatus.RUNNING)],
      steps: [
        step(McStepType.KEYFRAME, McStepStatus.SUCCEEDED),
        step(McStepType.TTS, McStepStatus.SUCCEEDED),
        step(McStepType.VIDEO, McStepStatus.SKIPPED_CACHED),
        step(McStepType.LIPSYNC, McStepStatus.SUCCEEDED, { providerJobId: 'job-1' }),
        step(McStepType.ASSEMBLY, McStepStatus.PENDING),
      ],
    });
    const service = build(fx);
    const lipsync = fx.state.steps[3] as unknown as McStep;

    await service.completeStepAndAdvance(fx.manager as unknown as EntityManager, lipsync, {
      from: McStepStatus.INGESTING,
      outputAssetId: 'asset-final',
      consumeOnSuccess: false,
    });

    // cena running→ready com o final
    expect(transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McScene,
      'sc1',
      McSceneStatus.RUNNING,
      McSceneStatus.READY,
      expect.objectContaining({ finalAssetId: 'asset-final' }),
    );
    // assembly no mc.ffmpeg com expiração da fila pesada
    const ffmpegCall = queue.publish.mock.calls.find(([q]) => q === QUEUES.MC_FFMPEG);
    expect(ffmpegCall?.[1]).toMatchObject({ stepId: 'st-assembly' });
    expect(ffmpegCall?.[2]).toMatchObject({ expireInSeconds: 600 });
    // projeto generating→assembling
    expect(transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McProject,
      'p1',
      McProjectStatus.GENERATING,
      McProjectStatus.ASSEMBLING,
    );
  });

  it('step de geração antiga NÃO atualiza atalhos nem marca cena ready', async () => {
    const fx = fixture({
      project: project(),
      scenes: [{ ...spokenScene(), generation: 2 }],
      steps: [step(McStepType.LIPSYNC, McStepStatus.SUCCEEDED, { sceneGeneration: 1 })],
    });
    const service = build(fx);
    await service.completeStepAndAdvance(
      fx.manager as unknown as EntityManager,
      fx.state.steps[0] as unknown as McStep,
      { from: McStepStatus.INGESTING, outputAssetId: 'asset-x', consumeOnSuccess: false },
    );
    expect(
      transitions.casTransition.mock.calls.some(
        ([, entity, , , to]) => entity === McScene && to === McSceneStatus.READY,
      ),
    ).toBe(false);
  });

  it('falha TRANSIENTE na execução 1 → failed→queued + republish com backoff (retry via fila)', async () => {
    const fx = fixture({
      project: project(),
      scenes: [spokenScene()],
      steps: [step(McStepType.KEYFRAME, McStepStatus.RUNNING, { attempts: 1 })],
    });
    const service = build(fx);
    await service.failStep(
      fx.state.steps[0] as unknown as McStep,
      McStepStatus.RUNNING,
      new TransientProviderError('HTTP 503'),
    );

    // CAS running→failed e depois failed→queued
    const casCalls = transitions.casTransition.mock.calls.filter(([, e]) => e === McStep);
    expect(casCalls[0].slice(3, 5)).toEqual([McStepStatus.RUNNING, McStepStatus.FAILED]);
    expect(casCalls[1].slice(3, 5)).toEqual([McStepStatus.FAILED, McStepStatus.QUEUED]);
    const republish = queue.publish.mock.calls[0];
    expect(republish[0]).toBe(QUEUES.MC_IMAGE);
    expect(republish[2]).toMatchObject({ startAfterSeconds: 15 });
    // retry NÃO estorna nem falha cena/projeto
    expect(credits.refundUnconsumed).not.toHaveBeenCalled();
    expect(
      transitions.casTransition.mock.calls.some(([, e]) => e === McScene || e === McProject),
    ).toBe(false);
  });

  it('transiente com retries esgotados (execução 4) → terminal: cena failed + needs_attention', async () => {
    const fx = fixture({
      project: project(),
      scenes: [spokenScene()],
      steps: [step(McStepType.KEYFRAME, McStepStatus.RUNNING, { attempts: 4 })],
    });
    const service = build(fx);
    await service.failStep(
      fx.state.steps[0] as unknown as McStep,
      McStepStatus.RUNNING,
      new TransientProviderError('HTTP 503'),
    );
    expect(queue.publish).not.toHaveBeenCalled(); // sem retry
    expect(transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McScene,
      'sc1',
      McSceneStatus.RUNNING,
      McSceneStatus.FAILED,
      expect.anything(),
    );
    expect(transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McProject,
      'p1',
      McProjectStatus.GENERATING,
      McProjectStatus.NEEDS_ATTENTION,
      expect.objectContaining({ errorCode: 'provider_transient' }),
    );
  });

  describe('e-mail de conclusão (plano §10 v1) — nunca bloqueia o pipeline', () => {
    function failedKeyframe(fx: ReturnType<typeof fixture>): Promise<void> {
      return build(fx).failStep(
        fx.state.steps[0] as unknown as McStep,
        McStepStatus.RUNNING,
        new TransientProviderError('HTTP 503'),
      );
    }

    it('projeto que entra em needs_attention dispara o e-mail com o link do projeto', async () => {
      const fx = fixture({
        project: project(),
        scenes: [spokenScene()],
        steps: [step(McStepType.KEYFRAME, McStepStatus.RUNNING, { attempts: 4 })],
      });
      await failedKeyframe(fx);
      expect(email.sendCommercialFinished).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'dono@loja.com',
          projectId: 'p1',
          status: McProjectStatus.NEEDS_ATTENTION,
        }),
      );
    });

    it('SMTP fora NÃO derruba a falha do step (a transição já aconteceu)', async () => {
      email.sendCommercialFinished.mockRejectedValue(new Error('SMTP recusou'));
      const fx = fixture({
        project: project(),
        scenes: [spokenScene()],
        steps: [step(McStepType.KEYFRAME, McStepStatus.RUNNING, { attempts: 4 })],
      });
      await expect(failedKeyframe(fx)).resolves.toBeUndefined();
      expect(transitions.casTransition).toHaveBeenCalledWith(
        expect.anything(),
        McProject,
        'p1',
        McProjectStatus.GENERATING,
        McProjectStatus.NEEDS_ATTENTION,
        expect.anything(),
      );
    });

    it('quem PERDE o CAS de needs_attention não manda e-mail duplicado', async () => {
      const fx = fixture({
        project: project(),
        scenes: [spokenScene()],
        steps: [step(McStepType.KEYFRAME, McStepStatus.RUNNING, { attempts: 4 })],
      });
      // último CAS (projeto → needs_attention) perdido por outro caminho
      transitions.casTransition.mockResolvedValue(true);
      transitions.casTransition.mockResolvedValueOnce(true); // step → failed
      transitions.casTransition.mockResolvedValueOnce(true); // cena pending→running
      transitions.casTransition.mockResolvedValueOnce(true); // cena running→failed
      transitions.casTransition.mockResolvedValueOnce(false); // projeto: outro venceu
      await failedKeyframe(fx);
      expect(email.sendCommercialFinished).not.toHaveBeenCalled();
    });

    it('usuário sem e-mail no banco → nada é enviado (e nada quebra)', async () => {
      const fx = fixture({ project: project(McProjectStatus.SUCCEEDED) });
      fx.dataSource.query.mockResolvedValue([]);
      await expect(
        build(fx).sendCompletionEmail('p1', McProjectStatus.SUCCEEDED),
      ).resolves.toBeUndefined();
      expect(email.sendCommercialFinished).not.toHaveBeenCalled();
    });
  });

  it('content_policy em lipsync JÁ CONSUMIDO (providerJobId) → estorno idempotente pelo stepId', async () => {
    const fx = fixture({
      project: project(),
      scenes: [spokenScene()],
      steps: [
        step(McStepType.LIPSYNC, McStepStatus.PROVIDER_WAIT, {
          attempts: 1,
          providerJobId: 'job-1', // consumiu no submit
        }),
      ],
    });
    const service = build(fx);
    await service.failStep(
      fx.state.steps[0] as unknown as McStep,
      McStepStatus.PROVIDER_WAIT,
      new TerminalProviderError('conteúdo bloqueado', 'content_policy'),
    );
    // estorno do step: ledger com ref = step.id e valor = custo do step
    expect(credits.refundUnconsumed).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      'st-lipsync',
      56,
      0,
    );
    expect(transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McProject,
      'p1',
      McProjectStatus.GENERATING,
      McProjectStatus.NEEDS_ATTENTION,
      expect.objectContaining({ errorCode: 'content_policy' }),
    );
  });

  it('content_policy em keyframe (síncrono, NADA consumido) → sem estorno de step', async () => {
    const fx = fixture({
      project: project(),
      scenes: [spokenScene()],
      steps: [step(McStepType.KEYFRAME, McStepStatus.RUNNING, { attempts: 1 })],
    });
    const service = build(fx);
    await service.failStep(
      fx.state.steps[0] as unknown as McStep,
      McStepStatus.RUNNING,
      new TerminalProviderError('bloqueado', 'content_policy'),
    );
    expect(credits.refundUnconsumed).not.toHaveBeenCalled();
  });

  it('quota → terminal + evento admin_alert (SEM ligar mc_paused automático)', async () => {
    const fx = fixture({
      project: project(),
      scenes: [spokenScene()],
      steps: [step(McStepType.LIPSYNC, McStepStatus.RUNNING, { attempts: 1 })],
    });
    const service = build(fx);
    await service.failStep(
      fx.state.steps[0] as unknown as McStep,
      McStepStatus.RUNNING,
      new TerminalProviderError('HTTP 402', 'quota'),
    );
    expect(
      commercials.appendEvent.mock.calls.some(
        ([, e]) => (e as { kind: string }).kind === 'admin_alert',
      ),
    ).toBe(true);
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it('internal na execução 1 → 1 retry; na execução 2 → terminal SEM estorno automático', async () => {
    const fx1 = fixture({
      project: project(),
      scenes: [spokenScene()],
      steps: [step(McStepType.KEYFRAME, McStepStatus.RUNNING, { attempts: 1 })],
    });
    await build(fx1).failStep(
      fx1.state.steps[0] as unknown as McStep,
      McStepStatus.RUNNING,
      new Error('boom'),
    );
    expect(queue.publish).toHaveBeenCalledTimes(1); // retry

    queue.publish.mockClear();
    credits.refundUnconsumed.mockClear();
    const fx2 = fixture({
      project: project(),
      scenes: [spokenScene()],
      steps: [
        step(McStepType.LIPSYNC, McStepStatus.RUNNING, { attempts: 2, providerJobId: 'job-1' }),
      ],
    });
    await build(fx2).failStep(
      fx2.state.steps[0] as unknown as McStep,
      McStepStatus.RUNNING,
      new Error('boom'),
    );
    expect(queue.publish).not.toHaveBeenCalled();
    expect(credits.refundUnconsumed).not.toHaveBeenCalled(); // internal: reconciliação admin (§6.4)
  });

  it('falha terminal do ASSEMBLY → projeto assembling→failed + estorno do não consumido do projeto', async () => {
    const fx = fixture({
      project: project(McProjectStatus.ASSEMBLING),
      scenes: [spokenScene(McSceneStatus.READY)],
      steps: [step(McStepType.ASSEMBLY, McStepStatus.RUNNING, { attempts: 2, costCredits: 0 })],
    });
    const service = build(fx);
    await service.failStep(
      fx.state.steps[0] as unknown as McStep,
      McStepStatus.RUNNING,
      new Error('ffmpeg saiu com código 1'),
    );
    expect(transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McProject,
      'p1',
      McProjectStatus.ASSEMBLING,
      McProjectStatus.FAILED,
      expect.anything(),
    );
    // estorno em nível de PROJETO (usuário não recebeu nada)
    expect(credits.refundUnconsumed).toHaveBeenCalledWith(expect.anything(), userId, 'p1', 160, 5);
  });

  it('succeedProject: assembling→succeeded consumindo a reserva integral (entrega = preço fechado)', async () => {
    const fx = fixture({ project: project(McProjectStatus.ASSEMBLING) });
    const service = build(fx);
    const won = await service.succeedProject(
      fx.manager as unknown as EntityManager,
      'p1',
      'asset-final',
    );
    expect(won).toBe(true);
    expect(transitions.casTransition).toHaveBeenCalledWith(
      expect.anything(),
      McProject,
      'p1',
      McProjectStatus.ASSEMBLING,
      McProjectStatus.SUCCEEDED,
      expect.objectContaining({ finalAssetId: 'asset-final', consumedCredits: 160 }),
    );
  });
});
