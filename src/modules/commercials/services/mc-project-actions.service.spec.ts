import { HttpException, UnprocessableEntityException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CreditsService, InsufficientCreditsError } from '../../../shared/credits/credits.service';
import { ModerationProvider } from '../../../shared/providers/moderation.provider';
import { SystemSettingsService } from '../../../shared/settings/system-settings.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import { custoDaCena, custoDoProjeto } from '../domain/mc-pricing.config';
import { McProjectStatus, McSceneStatus } from '../domain/mc-state-machines';
import { McKitStatus } from '../entities/mc-character-kit.entity';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McMaterializerService } from './mc-materializer.service';
import { McPipelineService } from './mc-pipeline.service';
import { McProjectActionsService } from './mc-project-actions.service';

type Row = Record<string, unknown> & { id: string };

const SCRIPT = {
  version: 1,
  scenes: [{ idx: 0, actionPrompt: 'Mascote acena', dialogue: 'Olá!', durationS: 10 }],
  seal: null,
};

describe('McProjectActionsService — approve / re-roll / fala / cancel', () => {
  const userId = 'u1';
  const originalMc = process.env.MC_CREDITS_ENABLED;

  let project: Row;
  let scene: Row;
  let kit: Row;
  let manager: {
    findOneByOrFail: jest.Mock;
    update: jest.Mock;
    increment: jest.Mock;
    find: jest.Mock;
  };
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let settings: { get: jest.Mock };
  let credits: { reserve: jest.Mock; refundUnconsumed: jest.Mock };
  let moderation: { moderate: jest.Mock };
  let commercials: { appendEvent: jest.Mock };
  let materializer: {
    materializeApproval: jest.Mock;
    createSceneSteps: jest.Mock;
    ensureAssemblyStep: jest.Mock;
  };
  let pipeline: {
    enqueueReadySteps: jest.Mock;
    cancelIdleSteps: jest.Mock;
    appendProjectTransition: jest.Mock;
  };
  let service: McProjectActionsService;

  beforeEach(() => {
    project = {
      id: 'p1',
      userId,
      kitId: 'kit-1',
      status: McProjectStatus.STORYBOARD_REVIEW,
      script: JSON.parse(JSON.stringify(SCRIPT)) as unknown,
      aspectRatio: '9:16',
      reservedCredits: 10,
      consumedCredits: 0,
    };
    scene = {
      id: 'sc1',
      projectId: 'p1',
      idx: 0,
      generation: 1,
      rerollCount: 0,
      status: McSceneStatus.READY,
      actionPrompt: 'Mascote acena',
      dialogue: 'Olá!',
      durationS: 10,
      keyframeAssetId: 'a-kf',
      audioAssetId: 'a-tts',
      videoAssetId: null,
      finalAssetId: 'a-final',
    };
    kit = { id: 'kit-1', userId, status: McKitStatus.APPROVED, version: 1, voiceId: 'v1' };

    manager = {
      findOneByOrFail: jest.fn((entity: unknown, where: { id: string }) => {
        if (entity === McProject) return Promise.resolve(project);
        if (entity === McScene) return Promise.resolve(scene);
        return Promise.reject(new Error(`sem fixture para ${String(where.id)}`));
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      increment: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue([]),
    };
    dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn(() => {
          if (entity === McProject) return Promise.resolve(project);
          if (entity === McScene) return Promise.resolve(scene);
          if (entity === McCharacterKit) return Promise.resolve(kit);
          return Promise.resolve(null);
        }),
        findOneByOrFail: jest.fn().mockResolvedValue(project),
      })),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb(manager as unknown as EntityManager),
      ),
    };
    transitions = {
      casTransition: jest.fn().mockResolvedValue(true),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    settings = { get: jest.fn().mockResolvedValue(null) };
    credits = {
      reserve: jest.fn().mockResolvedValue(undefined),
      refundUnconsumed: jest.fn().mockResolvedValue(0),
    };
    moderation = { moderate: jest.fn().mockResolvedValue({ flagged: false, categories: [] }) };
    commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    materializer = {
      materializeApproval: jest.fn().mockResolvedValue([]),
      createSceneSteps: jest.fn().mockResolvedValue([]),
      ensureAssemblyStep: jest.fn().mockResolvedValue({ id: 'asm' }),
    };
    pipeline = {
      enqueueReadySteps: jest.fn().mockResolvedValue([]),
      cancelIdleSteps: jest.fn().mockResolvedValue(0),
      appendProjectTransition: jest.fn().mockResolvedValue(undefined),
    };
    service = new McProjectActionsService(
      dataSource as unknown as DataSource,
      transitions as unknown as TaskTransitionService,
      settings as unknown as SystemSettingsService,
      credits as unknown as CreditsService,
      moderation as unknown as ModerationProvider,
      commercials as unknown as CommercialsService,
      materializer as unknown as McMaterializerService,
      pipeline as unknown as McPipelineService,
    );
  });

  afterEach(() => {
    if (originalMc === undefined) delete process.env.MC_CREDITS_ENABLED;
    else process.env.MC_CREDITS_ENABLED = originalMc;
  });

  describe('approve — GATE do storyboard (plano §6.7/§7.2)', () => {
    it('caminho feliz: modera o roteiro, RESERVA custoDoProjeto, CAS→generating, materializa e enfileira NA MESMA transação', async () => {
      process.env.MC_CREDITS_ENABLED = 'true';
      await service.approve(userId, 'p1');

      expect(moderation.moderate).toHaveBeenCalledWith({
        text: expect.stringContaining('Olá!'),
      });
      const expected = custoDoProjeto(SCRIPT); // 150 (1 cena falada)
      expect(credits.reserve).toHaveBeenCalledWith(manager, userId, 'p1', expected);
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McProject,
        'p1',
        McProjectStatus.STORYBOARD_REVIEW,
        McProjectStatus.GENERATING,
        expect.objectContaining({ reservedCredits: 10 + expected }),
      );
      expect(materializer.materializeApproval).toHaveBeenCalledTimes(1);
      expect(pipeline.enqueueReadySteps).toHaveBeenCalledWith(manager, 'p1');
      // ordem: reserva ANTES do CAS/materialização (402 aborta tudo)
      const reserveOrder = credits.reserve.mock.invocationCallOrder[0];
      const materializeOrder = materializer.materializeApproval.mock.invocationCallOrder[0];
      expect(reserveOrder).toBeLessThan(materializeOrder);
    });

    it('cobrança DESLIGADA (default): reserva 0 e segue', async () => {
      delete process.env.MC_CREDITS_ENABLED;
      await service.approve(userId, 'p1');
      expect(credits.reserve).toHaveBeenCalledWith(manager, userId, 'p1', 0);
      expect(materializer.materializeApproval).toHaveBeenCalledTimes(1);
    });

    it('402 na reserva → transação aborta: NADA materializado nem enfileirado', async () => {
      process.env.MC_CREDITS_ENABLED = 'true';
      credits.reserve.mockRejectedValue(new InsufficientCreditsError(3, 150));
      await expect(service.approve(userId, 'p1')).rejects.toThrow(InsufficientCreditsError);
      expect(materializer.materializeApproval).not.toHaveBeenCalled();
      expect(pipeline.enqueueReadySteps).not.toHaveBeenCalled();
    });

    it('roteiro flagged → 422 SCRIPT_MODERATION_BLOCKED, sem reserva e sem materialização', async () => {
      moderation.moderate.mockResolvedValue({ flagged: true, categories: ['violence'] });
      const promise = service.approve(userId, 'p1');
      await expect(promise).rejects.toThrow(UnprocessableEntityException);
      await promise.catch((err: UnprocessableEntityException) => {
        expect(err.getResponse()).toMatchObject({ code: 'SCRIPT_MODERATION_BLOCKED' });
      });
      expect(credits.reserve).not.toHaveBeenCalled();
      expect(materializer.materializeApproval).not.toHaveBeenCalled();
      // resultado auditado no jsonb mesmo bloqueando (plano §6.8)
      expect(manager.update).toHaveBeenCalledWith(
        McProject,
        { id: 'p1' },
        expect.objectContaining({ moderation: expect.objectContaining({ flagged: true }) }),
      );
    });

    it('mc_paused=true → 503 MC_PAUSED antes de qualquer coisa', async () => {
      settings.get.mockResolvedValue(true);
      const promise = service.approve(userId, 'p1');
      await expect(promise).rejects.toThrow(HttpException);
      await promise.catch((err: HttpException) => expect(err.getStatus()).toBe(503));
      expect(moderation.moderate).not.toHaveBeenCalled();
    });

    it('projeto fora de storyboard_review → 422', async () => {
      project.status = McProjectStatus.GENERATING;
      await expect(service.approve(userId, 'p1')).rejects.toThrow(UnprocessableEntityException);
    });

    it('kit não aprovado → 422 KIT_NOT_APPROVED', async () => {
      kit.status = McKitStatus.ARCHIVED;
      const promise = service.approve(userId, 'p1');
      await expect(promise).rejects.toThrow(UnprocessableEntityException);
      await promise.catch((err: UnprocessableEntityException) => {
        expect(err.getResponse()).toMatchObject({ code: 'KIT_NOT_APPROVED' });
      });
    });
  });

  describe('reroll — "veio errado" (plano §6.3/§8)', () => {
    beforeEach(() => {
      project.status = McProjectStatus.NEEDS_ATTENTION;
    });

    it('1º re-roll é GRÁTIS: sem reserva; generation++ e rerollCount++ no CAS da cena', async () => {
      process.env.MC_CREDITS_ENABLED = 'true';
      await service.rerollScene(userId, 'p1', 0);
      expect(credits.reserve).not.toHaveBeenCalled();
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McScene,
        'sc1',
        McSceneStatus.READY,
        McSceneStatus.PENDING,
        expect.objectContaining({ generation: 2, rerollCount: 1, finalAssetId: null }),
      );
      expect(materializer.createSceneSteps).toHaveBeenCalledTimes(1);
      expect(pipeline.enqueueReadySteps).toHaveBeenCalledWith(manager, 'p1');
      // projeto voltou a generating
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McProject,
        'p1',
        McProjectStatus.NEEDS_ATTENTION,
        McProjectStatus.GENERATING,
        expect.anything(),
      );
    });

    it('2º re-roll com cobrança ligada: mini-reserva de custoDaCena', async () => {
      process.env.MC_CREDITS_ENABLED = 'true';
      scene.rerollCount = 1;
      await service.rerollScene(userId, 'p1', 0);
      expect(credits.reserve).toHaveBeenCalledWith(
        manager,
        userId,
        'p1',
        custoDaCena({ dialogue: 'Olá!' }), // 150
      );
      expect(manager.increment).toHaveBeenCalledWith(
        McProject,
        { id: 'p1' },
        'reservedCredits',
        custoDaCena({ dialogue: 'Olá!' }),
      );
    });

    it('re-roll pós-entrega (succeeded) é permitido e volta o projeto a generating', async () => {
      project.status = McProjectStatus.SUCCEEDED;
      await service.rerollScene(userId, 'p1', 0);
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McProject,
        'p1',
        McProjectStatus.SUCCEEDED,
        McProjectStatus.GENERATING,
        expect.anything(),
      );
    });

    it('MULTI-CENA: projeto em generating aceita re-roll de cena JÁ FALHADA (falha em massa do provider)', async () => {
      // Cenário real: 3 cenas falharam juntas (provider fora do ar). O 1º
      // re-roll devolve o projeto a `generating`; sem isto as demais ficariam
      // presas esperando minutos, uma de cada vez.
      project.status = McProjectStatus.GENERATING;
      scene.status = McSceneStatus.FAILED;
      await service.rerollScene(userId, 'p1', 0);
      expect(materializer.createSceneSteps).toHaveBeenCalledTimes(1);
      expect(pipeline.enqueueReadySteps).toHaveBeenCalledWith(manager, 'p1');
    });

    it('projeto em generating com a cena AINDA em produção → 422 SCENE_NOT_REROLLABLE', async () => {
      project.status = McProjectStatus.GENERATING;
      scene.status = McSceneStatus.RUNNING;
      const promise = service.rerollScene(userId, 'p1', 0);
      await expect(promise).rejects.toThrow(UnprocessableEntityException);
      await promise.catch((err: UnprocessableEntityException) => {
        expect(err.getResponse()).toMatchObject({ code: 'SCENE_NOT_REROLLABLE' });
      });
    });

    it('cancela steps ociosos da geração antiga da cena ao re-armar', async () => {
      await service.rerollScene(userId, 'p1', 0);
      expect(pipeline.cancelIdleSteps).toHaveBeenCalledWith(manager, 'p1', 'sc1');
    });
  });

  describe('regravar fala (plano §6.3: invalida SÓ tts+lipsync)', () => {
    it('em storyboard_review edita apenas o roteiro — sem cenas/steps/reserva', async () => {
      project.status = McProjectStatus.STORYBOARD_REVIEW;
      await service.updateDialogue(userId, 'p1', 0, 'Nova fala!');
      expect(manager.update).toHaveBeenCalledWith(
        McProject,
        { id: 'p1' },
        expect.objectContaining({
          script: expect.objectContaining({
            scenes: [expect.objectContaining({ dialogue: 'Nova fala!' })],
          }),
        }),
      );
      expect(materializer.createSceneSteps).not.toHaveBeenCalled();
      expect(transitions.casTransition).not.toHaveBeenCalled();
    });

    it('pós-materialização: modera, generation++ SEM rerollCount, steps novos e projeto→generating', async () => {
      project.status = McProjectStatus.SUCCEEDED;
      await service.updateDialogue(userId, 'p1', 0, 'Fala nova!');
      expect(moderation.moderate).toHaveBeenCalledWith({ text: 'Fala nova!' });
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McScene,
        'sc1',
        McSceneStatus.READY,
        McSceneStatus.PENDING,
        expect.not.objectContaining({ rerollCount: expect.anything() }),
      );
      expect(materializer.createSceneSteps).toHaveBeenCalledTimes(1);
      // a fala editada chega ao materializer via cena atualizada (hash novo de tts)
      const [, , , sceneArg] = materializer.createSceneSteps.mock.calls[0] as [
        unknown,
        unknown,
        unknown,
        McScene,
      ];
      expect(sceneArg.dialogue).toBe('Fala nova!');
      expect(pipeline.enqueueReadySteps).toHaveBeenCalled();
    });

    it('cena muda → 422 SCENE_NOT_SPOKEN (v0 só regrava cenas faladas)', async () => {
      project.status = McProjectStatus.NEEDS_ATTENTION;
      scene.dialogue = null;
      const promise = service.updateDialogue(userId, 'p1', 0, 'Oi');
      await expect(promise).rejects.toThrow(UnprocessableEntityException);
      await promise.catch((err: UnprocessableEntityException) => {
        expect(err.getResponse()).toMatchObject({ code: 'SCENE_NOT_SPOKEN' });
      });
    });

    it('fala flagged → 422 e nada muda', async () => {
      project.status = McProjectStatus.NEEDS_ATTENTION;
      moderation.moderate.mockResolvedValue({ flagged: true, categories: ['hate'] });
      await expect(service.updateDialogue(userId, 'p1', 0, 'xxx')).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(materializer.createSceneSteps).not.toHaveBeenCalled();
    });
  });

  describe('cancel (plano §6.7)', () => {
    it('generating → canceled: cancela steps/cenas e estorna o NÃO consumido', async () => {
      project.status = McProjectStatus.GENERATING;
      project.reservedCredits = 160;
      project.consumedCredits = 61;
      await service.cancelProject(userId, 'p1');
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McProject,
        'p1',
        McProjectStatus.GENERATING,
        McProjectStatus.CANCELED,
        expect.anything(),
      );
      expect(pipeline.cancelIdleSteps).toHaveBeenCalledWith(manager, 'p1');
      expect(manager.update).toHaveBeenCalledWith(
        McScene,
        expect.objectContaining({ projectId: 'p1' }),
        { status: McSceneStatus.CANCELED },
      );
      expect(credits.refundUnconsumed).toHaveBeenCalledWith(manager, userId, 'p1', 160, 61);
    });

    it('needs_attention também cancela; succeeded/storyboard_review → 422', async () => {
      project.status = McProjectStatus.NEEDS_ATTENTION;
      await service.cancelProject(userId, 'p1');
      expect(credits.refundUnconsumed).toHaveBeenCalled();

      project.status = McProjectStatus.SUCCEEDED;
      await expect(service.cancelProject(userId, 'p1')).rejects.toThrow(
        UnprocessableEntityException,
      );
      project.status = McProjectStatus.STORYBOARD_REVIEW;
      await expect(service.cancelProject(userId, 'p1')).rejects.toThrow(
        UnprocessableEntityException,
      );
    });
  });
});
