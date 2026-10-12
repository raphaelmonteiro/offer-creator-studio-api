import { ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { ModerationProvider } from '../../../shared/providers/moderation.provider';
import { SystemSettingsService } from '../../../shared/settings/system-settings.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import {
  MC_PIPELINE_V2,
  MC_SCRIPT_SCHEMA_V2,
  McQualityState,
  resolveQuality,
} from '../domain/mc-quality';
import { sceneSourceHash } from '../domain/mc-script-v2';
import { McProjectStatus, McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McScript, McStepType } from '../domain/mc-types';
import { fixtureTalkTileScript } from '../domain/__fixtures__/mc-script-v2.fixtures';
import { McCharacterKit, McKitStatus } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McMaterializerService } from './mc-materializer.service';
import { McPipelineService } from './mc-pipeline.service';
import { McQualityService } from './mc-quality.service';
import { McTranslationService } from './mc-translation.service';

type Row = Record<string, unknown> & { id: string };

function derivedFor(scene: { initialFrame?: string; actionPrompt: string }, en: string) {
  return {
    sourceHash: sceneSourceHash(scene),
    initialFrameEn: null,
    actionPromptEn: en,
    lang: 'en' as const,
    provider: 't',
    at: 'now',
  };
}

function scriptV2(): McScript {
  const s1 = { initialFrame: 'frente', actionPrompt: 'acena' };
  const s2 = { initialFrame: 'caixa', actionPrompt: 'pega a caixa' };
  return {
    version: 1,
    schemaVersion: MC_SCRIPT_SCHEMA_V2,
    products: [{ id: 'p1', name: 'Arroz', price: '24,90', unit: null, catalogId: null }],
    environments: [],
    scenes: [
      {
        idx: 0,
        sceneId: 'aaaaaaaa-0000-4000-8000-000000000001',
        sceneType: 'presenter',
        ...s1,
        dialogue: 'Oi!',
        durationS: 6,
        productRef: null,
        sealCue: { startS: 3, endS: 6 },
        safeArea: 'lower_third',
        derived: derivedFor(s1, 'waves'),
      },
      {
        idx: 1,
        sceneId: 'aaaaaaaa-0000-4000-8000-000000000002',
        sceneType: 'action_voiceover',
        ...s2,
        dialogue: 'Leve por vinte e quatro e noventa',
        durationS: 5,
        productRef: 'p1',
        sealCue: { startS: 2.5, endS: 5 },
        safeArea: 'lower_third',
        derived: derivedFor(s2, 'picks the box'),
      },
    ],
    seal: null,
    endcard: null,
  };
}
const S1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const S2 = 'aaaaaaaa-0000-4000-8000-000000000002';

describe('McQualityService — orquestração do pipeline v2 (ADR §3.3/§4)', () => {
  const userId = 'u1';
  let project: Row;
  let kit: Row;
  let scenes: Row[];
  let steps: Row[];
  let assets: Row[];
  let updates: Array<{ where: unknown; set: unknown }>;
  let manager: Record<string, jest.Mock>;
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let credits: { reserve: jest.Mock; refundUnconsumed: jest.Mock };
  let materializer: Record<string, jest.Mock>;
  let pipeline: Record<string, jest.Mock>;
  let translation: { deriveScript: jest.Mock };
  let service: McQualityService;

  beforeEach(() => {
    process.env.MC_CREDITS_ENABLED = 'true';
    project = {
      id: 'p1',
      userId,
      kitId: 'k1',
      status: McProjectStatus.STORYBOARD_REVIEW,
      pipelineVersion: MC_PIPELINE_V2,
      revision: 1,
      quality: resolveQuality(null),
      script: scriptV2(),
      aspectRatio: '9:16',
      options: { musicEnabled: true, captionsEnabled: true, products: [] },
      reservedCredits: 0,
      consumedCredits: 0,
      finalAssetId: null,
    };
    kit = {
      id: 'k1',
      userId,
      status: McKitStatus.APPROVED,
      version: 1,
      voiceId: 'v1',
      referenceAssetIds: [],
    };
    scenes = [
      {
        id: 'row-1',
        projectId: 'p1',
        idx: 0,
        scriptSceneId: S1,
        sceneType: 'presenter',
        generation: 1,
        status: McSceneStatus.PENDING,
        dialogue: 'Oi!',
        durationS: 6,
        keyframeAssetId: 'kf1',
        audioAssetId: 'au1',
        videoAssetId: null,
        finalAssetId: null,
        rerollCount: 0,
      },
      {
        id: 'row-2',
        projectId: 'p1',
        idx: 1,
        scriptSceneId: S2,
        sceneType: 'action_voiceover',
        generation: 1,
        status: McSceneStatus.PENDING,
        dialogue: 'Leve por vinte e quatro e noventa',
        durationS: 5,
        keyframeAssetId: 'kf2',
        audioAssetId: 'au2',
        videoAssetId: null,
        finalAssetId: null,
        rerollCount: 0,
      },
    ];
    steps = [];
    assets = [
      { id: 'kf1', userId, fileUrl: '/uploads/kf1.png', durationMs: null, metadata: {} },
      {
        id: 'au1',
        userId,
        fileUrl: '/uploads/au1.mp3',
        durationMs: 4200,
        metadata: { alignment: { characters: ['a'] } },
      },
      { id: 'kf2', userId, fileUrl: '/uploads/kf2.png', durationMs: null, metadata: {} },
      {
        id: 'au2',
        userId,
        fileUrl: '/uploads/au2.mp3',
        durationMs: 4800,
        metadata: { alignment: { characters: ['a'] } },
      },
    ];
    updates = [];
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn((patch: unknown) => {
        qb._set = patch;
        return qb;
      }),
      where: jest.fn((_sql: string, params: unknown) => {
        qb._where = params;
        return qb;
      }),
      execute: jest.fn(() => {
        const w = qb._where as { from: string; revision: number };
        const ok = w.from === project.status && w.revision === project.revision;
        updates.push({ where: qb._where, set: qb._set });
        if (ok) Object.assign(project, qb._set as Record<string, unknown>);
        return Promise.resolve({ affected: ok ? 1 : 0 });
      }),
      _set: null as unknown,
      _where: null as unknown,
    };
    manager = {
      createQueryBuilder: jest.fn(() => qb),
      findOneByOrFail: jest.fn((entity: unknown) => {
        if (entity === McProject) return Promise.resolve(project);
        if (entity === McCharacterKit) return Promise.resolve(kit);
        return Promise.reject(new Error('sem fixture'));
      }),
      find: jest.fn((entity: unknown) => {
        if (entity === McScene) return Promise.resolve(scenes);
        if (entity === McStep) return Promise.resolve(steps);
        if (entity === AnimationAsset) return Promise.resolve(assets);
        return Promise.resolve([]);
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn((where: Record<string, unknown>) => {
          if (entity === McProject) return Promise.resolve(project);
          if (entity === McCharacterKit) return Promise.resolve(kit);
          if (entity === McScene)
            return Promise.resolve(
              scenes.find((s) => s.scriptSceneId === where.scriptSceneId) ?? null,
            );
          if (entity === McStep)
            return Promise.resolve(steps.find((s) => s.id === where.id) ?? null);
          if (entity === AnimationAsset)
            return Promise.resolve(assets.find((a) => a.id === where.id) ?? null);
          return Promise.resolve(null);
        }),
        findOneByOrFail: jest.fn().mockImplementation(() => Promise.resolve(project)),
        find: jest.fn((opts: { where: Record<string, unknown> }) => {
          if (entity === McScene) return Promise.resolve(scenes);
          if (entity === AnimationAsset) {
            const ids = (opts.where.id as { _value?: string[] })?._value ?? [];
            return Promise.resolve(assets.filter((a) => ids.includes(a.id)));
          }
          return Promise.resolve([]);
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
    credits = {
      reserve: jest.fn().mockResolvedValue(undefined),
      refundUnconsumed: jest.fn().mockResolvedValue(0),
    };
    materializer = {
      syncScenesV2: jest.fn().mockImplementation(() => Promise.resolve(scenes)),
      materializePreparationV2: jest.fn().mockResolvedValue({
        steps: [{ id: 'st-kf', status: McStepStatus.PENDING }],
        items: [
          { sceneId: S1, stepType: McStepType.KEYFRAME, attempt: 1, credits: 1, cached: false },
          { sceneId: S1, stepType: McStepType.TTS, attempt: 1, credits: 4, cached: false },
        ],
      }),
      materializeProductionV2: jest.fn().mockResolvedValue({
        steps: [],
        items: [
          { sceneId: S1, stepType: McStepType.LIPSYNC, attempt: 1, credits: 56, cached: false },
          { sceneId: S2, stepType: McStepType.VIDEO, attempt: 1, credits: 89, cached: false },
          {
            sceneId: S2,
            stepType: McStepType.SCENE_COMPOSE,
            attempt: 1,
            credits: 0,
            cached: false,
          },
        ],
      }),
      createPreviewAttemptV2: jest
        .fn()
        .mockResolvedValue({ id: 'st-new', attempt: 2, status: McStepStatus.PENDING }),
      ensureAssemblyStepV2: jest.fn().mockResolvedValue({ id: 'asm' }),
      buildPreparationManifest: jest
        .fn()
        .mockImplementation(
          (
            _m: unknown,
            p: Row,
            _k: unknown,
            _s: unknown,
            _sc: unknown,
            opts: { completed: boolean },
          ) =>
            Promise.resolve({
              revision: p.revision,
              kitId: 'k1',
              kitVersion: 1,
              aspectRatio: '9:16',
              scenes: [],
              startedAt: 'now',
              completedAt: opts.completed ? 'now' : null,
              hash: opts.completed ? 'manifest-1' : null,
            }),
        ),
    };
    pipeline = {
      enqueueReadySteps: jest.fn().mockResolvedValue(['st-kf']),
      completePreparationIfReady: jest.fn().mockResolvedValue(true),
      appendProjectTransition: jest.fn().mockResolvedValue(undefined),
      cancelIdleSteps: jest.fn().mockResolvedValue(0),
    };
    translation = {
      deriveScript: jest
        .fn()
        .mockImplementation((script: McScript) => Promise.resolve({ script, translated: 0 })),
    };
    service = new McQualityService(
      dataSource as unknown as DataSource,
      transitions as unknown as TaskTransitionService,
      { get: jest.fn().mockResolvedValue(null) } as unknown as SystemSettingsService,
      credits as unknown as CreditsService,
      {
        moderate: jest.fn().mockResolvedValue({ flagged: false, categories: [] }),
      } as unknown as ModerationProvider,
      { appendEvent: jest.fn().mockResolvedValue(undefined) } as unknown as CommercialsService,
      materializer as unknown as McMaterializerService,
      pipeline as unknown as McPipelineService,
      translation as unknown as McTranslationService,
    );
  });

  afterEach(() => {
    delete process.env.MC_CREDITS_ENABLED;
  });

  describe('updateScript (P1) — identidade, derivação e revisão', () => {
    const dtoFrom = (script: McScript, expectedRevision: number) => ({
      expectedRevision,
      scenes: script.scenes.map((s) => ({
        sceneId: s.sceneId,
        sceneType: s.sceneType!,
        initialFrame: s.initialFrame,
        actionPrompt: s.actionPrompt,
        dialogue: s.dialogue,
        durationS: s.durationS,
        productRef: s.productRef,
        sealCue: s.sealCue ?? null,
        safeArea: s.safeArea ?? null,
      })),
      products: script.products,
    });

    it('revisão esperada diferente ⇒ 409 REVISION_CONFLICT sem escrever', async () => {
      await expect(
        service.updateScript(userId, 'p1', dtoFrom(scriptV2(), 0)),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(updates).toHaveLength(0);
    });

    it('editar a intenção pt invalida a derivação EN da cena; reordenar mantém fala/produto por sceneId; revisão++', async () => {
      const edited = scriptV2();
      edited.scenes[1].actionPrompt = 'larga a caixa';
      const dto = dtoFrom(edited, 1);
      dto.scenes = [dto.scenes[1], dto.scenes[0]]; // reordena
      await service.updateScript(userId, 'p1', dto);
      const saved = project.script as McScript;
      expect(project.revision).toBe(2);
      expect(project.status).toBe(McProjectStatus.STORYBOARD_REVIEW);
      expect(saved.scenes.map((s) => s.sceneId)).toEqual([S2, S1]);
      expect(saved.scenes[0].dialogue).toBe('Leve por vinte e quatro e noventa');
      expect(saved.scenes[0].productRef).toBe('p1');
      // derivação antiga fica gravada mas NÃO é válida para a nova intenção
      expect(saved.scenes[0].derived?.sourceHash).not.toBe(sceneSourceHash(saved.scenes[0]));
      // a cena não editada mantém a derivação válida
      expect(saved.scenes[1].derived?.sourceHash).toBe(sceneSourceHash(saved.scenes[1]));
      expect((project.quality as McQualityState).approval).toBeNull();
    });

    it('productRef inexistente e action com fala ⇒ 422 SCRIPT_INVALID com issues por cena', async () => {
      const bad = scriptV2();
      bad.scenes[1].productRef = 'nope';
      await expect(service.updateScript(userId, 'p1', dtoFrom(bad, 1))).rejects.toMatchObject({
        response: { code: 'SCRIPT_INVALID' },
      });
      const bad2 = scriptV2();
      bad2.scenes[1].sceneType = 'action';
      await expect(service.updateScript(userId, 'p1', dtoFrom(bad2, 1))).rejects.toMatchObject({
        response: { code: 'SCRIPT_INVALID' },
      });
    });

    it('após a entrega, mudar só o selo abre revisão assembly_only (visual_review) preservando a entrega', async () => {
      project.status = McProjectStatus.SUCCEEDED;
      project.finalAssetId = 'final-v1';
      project.quality = resolveQuality({
        timeline: {
          revision: 1,
          version: 1,
          totalS: 11,
          scenes: [],
          endcard: null,
          captionsRequested: true,
          captionsMissingSceneIds: [],
          seals: [],
          renderedAt: 'now',
        },
      });
      const sealOnly = scriptV2();
      sealOnly.scenes[0].productRef = 'p1';
      await service.updateScript(userId, 'p1', dtoFrom(sealOnly, 1));
      expect(project.status).toBe(McProjectStatus.VISUAL_REVIEW);
      const quality = project.quality as McQualityState;
      expect(quality.pendingScope).toBe('assembly_only');
      expect(quality.lastDelivery?.finalAssetId).toBe('final-v1');
      expect(project.finalAssetId).toBe('final-v1');
    });

    it('após a entrega, mudar a fala volta ao roteiro (não é assembly_only)', async () => {
      project.status = McProjectStatus.SUCCEEDED;
      project.finalAssetId = 'final-v1';
      const spoken = scriptV2();
      spoken.scenes[0].dialogue = 'Olá de novo!';
      await service.updateScript(userId, 'p1', dtoFrom(spoken, 1));
      expect(project.status).toBe(McProjectStatus.STORYBOARD_REVIEW);
      expect((project.quality as McQualityState).pendingScope).toBeNull();
    });
  });

  describe('prepare (P3) — só prévias, reserva por fase, cache integral', () => {
    it('storyboard_review → preparing: traduz pendentes, reserva a cotação da fase e enfileira só prévias', async () => {
      await service.prepare(userId, 'p1', 1);
      expect(translation.deriveScript).toHaveBeenCalled();
      expect(materializer.materializePreparationV2).toHaveBeenCalled();
      expect(materializer.materializeProductionV2).not.toHaveBeenCalled();
      expect(credits.reserve).toHaveBeenCalledWith(
        expect.anything(),
        userId,
        'p1:preparation:r1',
        5,
      );
      expect(project.status).toBe(McProjectStatus.PREPARING);
      const quality = project.quality as McQualityState;
      expect(quality.budgets[0]).toMatchObject({
        phase: 'preparation',
        revision: 1,
        quotedCredits: 5,
        reservedCredits: 5,
      });
      expect(quality.preparation?.completedAt).toBeNull();
      expect(pipeline.enqueueReadySteps).toHaveBeenCalled();
      expect(pipeline.completePreparationIfReady).not.toHaveBeenCalled();
    });

    it('cache integral (nada a enfileirar) ⇒ chega à revisão visual na mesma transação, sem esperar callback', async () => {
      pipeline.enqueueReadySteps.mockResolvedValue([]);
      materializer.materializePreparationV2.mockResolvedValue({
        steps: [],
        items: [
          { sceneId: S1, stepType: McStepType.KEYFRAME, attempt: 1, credits: 0, cached: true },
        ],
      });
      await service.prepare(userId, 'p1', 1);
      expect(credits.reserve).not.toHaveBeenCalled(); // cotação 0: nada a reservar
      expect(pipeline.completePreparationIfReady).toHaveBeenCalled();
    });

    it('fora de storyboard_review (ex.: generating) ⇒ 422; needs_attention com resumePhase=preparation retoma', async () => {
      project.status = McProjectStatus.GENERATING;
      await expect(service.prepare(userId, 'p1', 1)).rejects.toMatchObject({
        response: { code: 'PROJECT_NOT_PREPARABLE' },
      });
      project.status = McProjectStatus.NEEDS_ATTENTION;
      project.quality = resolveQuality({
        resumePhase: 'preparation',
        budgets: [
          {
            phase: 'preparation',
            revision: 1,
            quotedCredits: 5,
            reservedCredits: 5,
            consumedCredits: 0,
            refundedCredits: 0,
            ledgerKey: 'p1:preparation:r1',
            settledAt: null,
            items: [],
          },
        ],
      });
      await service.prepare(userId, 'p1', 1);
      expect(project.status).toBe(McProjectStatus.PREPARING);
      // repetir a mesma fase/revisão NÃO reserva de novo (idempotente por fase)
      expect(credits.reserve).not.toHaveBeenCalled();
    });

    it('402 na reserva aborta tudo (nada materializado persiste, status intacto)', async () => {
      credits.reserve.mockRejectedValue(new Error('INSUFFICIENT_CREDITS'));
      await expect(service.prepare(userId, 'p1', 1)).rejects.toThrow('INSUFFICIENT_CREDITS');
      expect(project.status).toBe(McProjectStatus.STORYBOARD_REVIEW);
      expect(pipeline.enqueueReadySteps).not.toHaveBeenCalled();
    });
  });

  describe('revisão visual — regenerar, selecionar, ajustar fala', () => {
    beforeEach(() => {
      project.status = McProjectStatus.VISUAL_REVIEW;
      project.quality = resolveQuality({
        preparation: {
          revision: 1,
          kitId: 'k1',
          kitVersion: 1,
          aspectRatio: '9:16',
          scenes: [],
          startedAt: 'now',
          completedAt: 'now',
          hash: 'manifest-1',
        },
        budgets: [
          {
            phase: 'preparation',
            revision: 1,
            quotedCredits: 5,
            reservedCredits: 5,
            consumedCredits: 5,
            refundedCredits: 0,
            ledgerKey: 'p1:preparation:r1',
            settledAt: 'now',
            items: [],
          },
        ],
      });
    });

    it('regenerar imagem: tentativa nova orçada à parte, aprovação zerada, visual_review → preparing', async () => {
      await service.regeneratePreview(userId, 'p1', S1, { expectedRevision: 1, kind: 'image' });
      expect(materializer.createPreviewAttemptV2).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ id: 'row-1' }),
        McStepType.KEYFRAME,
      );
      expect(credits.reserve).toHaveBeenCalledWith(
        expect.anything(),
        userId,
        'p1:preparation:r1:regen:st-new',
        1,
      );
      expect(project.status).toBe(McProjectStatus.PREPARING);
      expect((project.quality as McQualityState).budgets[0]).toMatchObject({
        quotedCredits: 6,
        reservedCredits: 6,
      });
    });

    it('regenerar voz de cena sem fala ⇒ 422', async () => {
      (project.script as McScript).scenes[0].sceneType = 'action';
      (project.script as McScript).scenes[0].dialogue = null;
      await expect(
        service.regeneratePreview(userId, 'p1', S1, { expectedRevision: 1, kind: 'voice' }),
      ).rejects.toMatchObject({ response: { code: 'SCENE_NOT_SPOKEN' } });
    });

    it('selecionar prévia: só step da própria cena, pronto e com asset do usuário; manifesto re-assinado', async () => {
      steps = [
        {
          id: 'st-a',
          projectId: 'p1',
          sceneId: 'row-1',
          type: McStepType.KEYFRAME,
          status: McStepStatus.SUCCEEDED,
          outputAssetId: 'kf1b',
          attempt: 2,
        },
        {
          id: 'st-other',
          projectId: 'p1',
          sceneId: 'row-2',
          type: McStepType.KEYFRAME,
          status: McStepStatus.SUCCEEDED,
          outputAssetId: 'kf2',
          attempt: 1,
        },
        {
          id: 'st-pending',
          projectId: 'p1',
          sceneId: 'row-1',
          type: McStepType.KEYFRAME,
          status: McStepStatus.RUNNING,
          outputAssetId: null,
          attempt: 3,
        },
      ];
      assets.push({ id: 'kf1b', userId, fileUrl: '/uploads/kf1b.png', metadata: {} });
      await expect(
        service.selectPreview(userId, 'p1', S1, { expectedRevision: 1, stepId: 'st-other' }),
      ).rejects.toMatchObject({ response: { code: 'PREVIEW_NOT_FOUND' } });
      await expect(
        service.selectPreview(userId, 'p1', S1, { expectedRevision: 1, stepId: 'st-pending' }),
      ).rejects.toMatchObject({ response: { code: 'PREVIEW_NOT_READY' } });
      await service.selectPreview(userId, 'p1', S1, { expectedRevision: 1, stepId: 'st-a' });
      expect(manager.update).toHaveBeenCalledWith(
        McScene,
        { id: 'row-1' },
        { keyframeAssetId: 'kf1b' },
      );
      expect(materializer.buildPreparationManifest).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ completed: true }),
      );
      expect((project.quality as McQualityState).approval).toBeNull();
    });

    it('asset de outro usuário não pode ser selecionado', async () => {
      steps = [
        {
          id: 'st-x',
          projectId: 'p1',
          sceneId: 'row-1',
          type: McStepType.KEYFRAME,
          status: McStepStatus.SUCCEEDED,
          outputAssetId: 'foreign',
          attempt: 2,
        },
      ];
      assets.push({
        id: 'foreign',
        userId: 'someone-else',
        fileUrl: '/uploads/x.png',
        metadata: {},
      });
      await expect(
        service.selectPreview(userId, 'p1', S1, { expectedRevision: 1, stepId: 'st-x' }),
      ).rejects.toMatchObject({ response: { code: 'ASSET_UNAVAILABLE' } });
    });

    it('retomar needs_attention regenerando a imagem de cena `failed`: cena volta a pending (failed → pending), não fica presa', async () => {
      // bug real: keyframe falhou → cena `failed`; a regeneração só limpava o
      // erro e a cena atravessava revisão visual + produção ainda `failed`.
      project.status = McProjectStatus.NEEDS_ATTENTION;
      project.quality = resolveQuality({
        ...(project.quality as McQualityState),
        resumePhase: 'preparation',
      });
      scenes[0].status = McSceneStatus.FAILED;
      scenes[0].errorCode = 'keyframe_failed';
      await service.regeneratePreview(userId, 'p1', S1, { expectedRevision: 1, kind: 'image' });
      expect(project.status).toBe(McProjectStatus.PREPARING);
      expect(manager.update).toHaveBeenCalledWith(
        McScene,
        { id: 'row-1' },
        expect.objectContaining({
          status: McSceneStatus.PENDING,
          finalAssetId: null,
          errorCode: null,
          errorMessage: null,
        }),
      );
      expect(scenes[0].status).toBe(McSceneStatus.PENDING);
    });

    it('regenerar em cena pending (revisão visual normal) não mexe no status da cena', async () => {
      await service.regeneratePreview(userId, 'p1', S1, { expectedRevision: 1, kind: 'image' });
      expect(manager.update).not.toHaveBeenCalledWith(
        McScene,
        { id: 'row-1' },
        expect.objectContaining({ status: expect.anything() }),
      );
    });
  });

  describe('approveProduction — o gate de vídeo (P3)', () => {
    beforeEach(() => {
      project.status = McProjectStatus.VISUAL_REVIEW;
      project.quality = resolveQuality({
        preparation: {
          revision: 1,
          kitId: 'k1',
          kitVersion: 1,
          aspectRatio: '9:16',
          scenes: [],
          startedAt: 'now',
          completedAt: 'now',
          hash: 'manifest-1',
        },
      });
    });

    it('aprova: cotação da produção (sem Avatar no voiceover), reserva, manifesto imutável, generating + enqueue', async () => {
      await service.approveProduction(userId, 'p1', {
        expectedRevision: 1,
        manifestHash: 'manifest-1',
      });
      expect(materializer.materializeProductionV2).toHaveBeenCalled();
      expect(credits.reserve).toHaveBeenCalledWith(
        expect.anything(),
        userId,
        'p1:production:r1',
        145,
      );
      expect(project.status).toBe(McProjectStatus.GENERATING);
      const quality = project.quality as McQualityState;
      expect(quality.approval).toMatchObject({
        scope: 'production',
        revision: 1,
        manifestHash: 'manifest-1',
        budgetCredits: 145,
      });
      expect(materializer.ensureAssemblyStepV2).toHaveBeenCalled();
      expect(pipeline.enqueueReadySteps).toHaveBeenCalled();
    });

    it('manifesto diferente do atual ⇒ 409 MANIFEST_CONFLICT sem reservar/enfileirar', async () => {
      await expect(
        service.approveProduction(userId, 'p1', { expectedRevision: 1, manifestHash: 'stale' }),
      ).rejects.toMatchObject({ response: { code: 'MANIFEST_CONFLICT' } });
      expect(credits.reserve).not.toHaveBeenCalled();
      expect(pipeline.enqueueReadySteps).not.toHaveBeenCalled();
    });

    it('aprovação dupla: a segunda perde o CAS (409) — uma única operação lógica e uma reserva', async () => {
      await service.approveProduction(userId, 'p1', {
        expectedRevision: 1,
        manifestHash: 'manifest-1',
      });
      // segunda aba tenta aprovar a mesma revisão/manifesto: o status já não é visual_review
      await expect(
        service.approveProduction(userId, 'p1', {
          expectedRevision: 1,
          manifestHash: 'manifest-1',
        }),
      ).rejects.toMatchObject({ response: { code: 'PROJECT_STATE_INVALID' } });
      expect(credits.reserve).toHaveBeenCalledTimes(1);
      expect(pipeline.enqueueReadySteps).toHaveBeenCalledTimes(1);
    });

    it('locução de voiceover maior que o clipe do provider ⇒ 422 AUDIO_EXCEEDS_CLIP antes de qualquer gasto', async () => {
      assets.find((a) => a.id === 'au2')!.durationMs = 6300; // clipe de 5s
      await expect(
        service.approveProduction(userId, 'p1', {
          expectedRevision: 1,
          manifestHash: 'manifest-1',
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'AUDIO_EXCEEDS_CLIP',
          issues: [
            expect.objectContaining({ sceneId: S2, detail: expect.objectContaining({ clipS: 5 }) }),
          ],
        },
      });
      expect(credits.reserve).not.toHaveBeenCalled();
    });

    it('legenda solicitada sem alinhamento ⇒ 422 CAPTIONS_ALIGNMENT_MISSING; aceite explícito libera e fica registrado', async () => {
      assets.find((a) => a.id === 'au1')!.metadata = {};
      await expect(
        service.approveProduction(userId, 'p1', {
          expectedRevision: 1,
          manifestHash: 'manifest-1',
        }),
      ).rejects.toMatchObject({ response: { code: 'CAPTIONS_ALIGNMENT_MISSING' } });
      await service.approveProduction(userId, 'p1', {
        expectedRevision: 1,
        manifestHash: 'manifest-1',
        acceptMissingCaptions: true,
      });
      expect((project.quality as McQualityState).captionsMissingAccepted).toBe(true);
    });

    it('asset selecionado apagado/expirado ⇒ 422 sem produção paga automática', async () => {
      assets.find((a) => a.id === 'kf2')!.fileUrl = null;
      await expect(
        service.approveProduction(userId, 'p1', {
          expectedRevision: 1,
          manifestHash: 'manifest-1',
        }),
      ).rejects.toMatchObject({ response: { code: 'KEYFRAME_MISSING' } });
      expect(materializer.materializeProductionV2).not.toHaveBeenCalled();
    });

    it('orçamento aceito abaixo da cotação ⇒ 422 BUDGET_EXCEEDED', async () => {
      await expect(
        service.approveProduction(userId, 'p1', {
          expectedRevision: 1,
          manifestHash: 'manifest-1',
          budgetCredits: 10,
        }),
      ).rejects.toMatchObject({ response: { code: 'BUDGET_EXCEEDED' } });
      expect(credits.reserve).not.toHaveBeenCalled();
    });

    it('revisão assembly_only não aceita aprovação de produção', async () => {
      project.quality = resolveQuality({
        ...(project.quality as McQualityState),
        pendingScope: 'assembly_only',
      });
      await expect(
        service.approveProduction(userId, 'p1', {
          expectedRevision: 1,
          manifestHash: 'manifest-1',
        }),
      ).rejects.toMatchObject({ response: { code: 'SCOPE_ASSEMBLY_ONLY' } });
    });

    it('cena presa em `failed` é re-armada (failed → pending) antes de materializar a produção', async () => {
      scenes[1].status = McSceneStatus.FAILED;
      scenes[1].errorCode = 'keyframe_failed';
      await service.approveProduction(userId, 'p1', {
        expectedRevision: 1,
        manifestHash: 'manifest-1',
      });
      expect(manager.update).toHaveBeenCalledWith(
        McScene,
        { id: 'row-2' },
        expect.objectContaining({ status: McSceneStatus.PENDING, finalAssetId: null }),
      );
      // a materialização recebe a cena já re-armada
      const passed = materializer.materializeProductionV2.mock.calls[0][3] as Row[];
      expect(passed.find((s) => s.id === 'row-2')?.status).toBe(McSceneStatus.PENDING);
      expect(manager.update).not.toHaveBeenCalledWith(
        McScene,
        { id: 'row-1' },
        expect.objectContaining({ status: expect.anything() }),
      );
    });
  });

  describe('refazer vídeo, composição pós-entrega e cancelamento', () => {
    it('rerollScene v2 exige aprovação da revisão; 1º grátis; 2º cobra produção da cena; nova tentativa', async () => {
      project.status = McProjectStatus.SUCCEEDED;
      project.quality = resolveQuality({
        approval: {
          scope: 'production',
          revision: 1,
          manifestHash: 'm',
          approvedAt: 'now',
          userId,
          budgetCredits: 145,
        },
      });
      scenes[1].status = McSceneStatus.READY;
      scenes[1].finalAssetId = 'final-2';
      await service.rerollScene(userId, 'p1', S2, 1);
      expect(credits.reserve).not.toHaveBeenCalled();
      expect(materializer.materializeProductionV2).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        [expect.objectContaining({ id: 'row-2' })],
        { forceNewAttempt: true },
      );
      expect(project.status).toBe(McProjectStatus.GENERATING);
      // 2ª vez (rerollCount 1 → paga custo de produção do voiceover: 89)
      project.status = McProjectStatus.SUCCEEDED;
      scenes[1].status = McSceneStatus.READY;
      scenes[1].rerollCount = 1;
      await service.rerollScene(userId, 'p1', S2, 1);
      expect(credits.reserve).toHaveBeenCalledWith(
        expect.anything(),
        userId,
        expect.stringContaining('reroll:row-2:2'),
        89,
      );
    });

    it('rerollScene após remontagem assembly_only continua autorizado (prévias inalteradas)', async () => {
      project.status = McProjectStatus.SUCCEEDED;
      project.revision = 2;
      project.quality = resolveQuality({
        approval: {
          scope: 'assembly_only',
          revision: 2,
          manifestHash: 'm',
          approvedAt: 'now',
          userId,
          budgetCredits: 0,
        },
        productionApproval: {
          scope: 'production',
          revision: 1,
          manifestHash: 'm',
          approvedAt: 'now',
          userId,
          budgetCredits: 145,
        },
      });
      scenes[1].status = McSceneStatus.READY;
      scenes[1].finalAssetId = 'final-2';
      await service.rerollScene(userId, 'p1', S2, 2);
      expect(project.status).toBe(McProjectStatus.GENERATING);
      expect(materializer.materializeProductionV2).toHaveBeenCalled();
    });

    it('rerollScene sem aprovação da revisão ⇒ 422 APPROVAL_MISSING', async () => {
      project.status = McProjectStatus.SUCCEEDED;
      await expect(service.rerollScene(userId, 'p1', S2, 1)).rejects.toMatchObject({
        response: { code: 'APPROVAL_MISSING' },
      });
    });

    it('updateComposition: preço também falado ⇒ 422; só selo/cartela ⇒ visual_review assembly_only + revisão++', async () => {
      project.status = McProjectStatus.SUCCEEDED;
      await expect(
        service.updateComposition(userId, 'p1', {
          expectedRevision: 1,
          products: [{ id: 'p1', name: 'Arroz', price: '19,90' }],
        }),
      ).rejects.toMatchObject({ response: { code: 'PRICE_SPOKEN_IN_DIALOGUE' } });
      await service.updateComposition(userId, 'p1', {
        expectedRevision: 1,
        endcard: { storeName: 'Loja Nova' },
      });
      expect(project.status).toBe(McProjectStatus.VISUAL_REVIEW);
      expect(project.revision).toBe(2);
      expect((project.quality as McQualityState).pendingScope).toBe('assembly_only');
      expect((project.script as McScript).endcard?.storeName).toBe('Loja Nova');
    });

    it('approveAssembly: só com clipes prontos; remonta sem preparação nem vídeo', async () => {
      project.status = McProjectStatus.VISUAL_REVIEW;
      project.quality = resolveQuality({ pendingScope: 'assembly_only' });
      await expect(service.approveAssembly(userId, 'p1', 1)).rejects.toMatchObject({
        response: { code: 'SCENES_NOT_READY' },
      });
      for (const s of scenes) {
        s.status = McSceneStatus.READY;
        s.finalAssetId = `final-${s.id}`;
      }
      await service.approveAssembly(userId, 'p1', 1);
      expect(project.status).toBe(McProjectStatus.ASSEMBLING);
      expect(materializer.materializePreparationV2).not.toHaveBeenCalled();
      expect(materializer.materializeProductionV2).not.toHaveBeenCalled();
      expect(materializer.ensureAssemblyStepV2).toHaveBeenCalled();
      expect((project.quality as McQualityState).approval).toMatchObject({
        scope: 'assembly_only',
        revision: 1,
      });
    });

    it('cancel: estorna o não consumido POR FASE (idempotente por chave) e preserva a última entrega', async () => {
      project.status = McProjectStatus.GENERATING;
      project.quality = resolveQuality({
        budgets: [
          {
            phase: 'preparation',
            revision: 1,
            quotedCredits: 5,
            reservedCredits: 5,
            consumedCredits: 5,
            refundedCredits: 0,
            ledgerKey: 'p1:preparation:r1',
            settledAt: 'done',
            items: [],
          },
          {
            phase: 'production',
            revision: 1,
            quotedCredits: 145,
            reservedCredits: 145,
            consumedCredits: 56,
            refundedCredits: 0,
            ledgerKey: 'p1:production:r1',
            settledAt: null,
            items: [],
          },
        ],
      });
      credits.refundUnconsumed.mockResolvedValue(89);
      await service.cancel(userId, 'p1');
      expect(credits.refundUnconsumed).toHaveBeenCalledTimes(1);
      expect(credits.refundUnconsumed).toHaveBeenCalledWith(
        expect.anything(),
        userId,
        'p1:production:r1',
        145,
        56,
      );
      expect(pipeline.cancelIdleSteps).toHaveBeenCalled();
    });

    it('projeto legado nas rotas v2 ⇒ 422 PIPELINE_VERSION', async () => {
      project.pipelineVersion = 1;
      await expect(service.prepare(userId, 'p1', 0)).rejects.toMatchObject({
        response: { code: 'PIPELINE_VERSION' },
      });
    });
  });

  describe('convertToV2 — conversão explícita do legado', () => {
    it('converte de succeeded preservando a entrega e marcando associação inferida', async () => {
      project.pipelineVersion = 1;
      project.status = McProjectStatus.SUCCEEDED;
      project.finalAssetId = 'legacy-final';
      project.quality = null;
      project.script = {
        version: 2,
        scenes: [
          { idx: 0, actionPrompt: 'acena', actionPromptEn: 'waves', dialogue: 'Oi', durationS: 6 },
        ],
        seal: { products: [{ name: 'Arroz', price: '24,90' }] },
      };
      await service.convertToV2(userId, 'p1');
      expect(transitions.casTransition).toHaveBeenCalledWith(
        expect.anything(),
        McProject,
        'p1',
        McProjectStatus.SUCCEEDED,
        McProjectStatus.STORYBOARD_REVIEW,
        expect.objectContaining({
          pipelineVersion: 2,
          revision: 2,
          script: expect.objectContaining({ schemaVersion: 2 }),
        }),
      );
      await expect(service.convertToV2(userId, 'p1')).resolves.toBeDefined(); // idempotente quando já é v2 (fixture continua v1 aqui; só valida que não lança)
    });
  });

  describe('approveProduction — cenas talk_tile (change video-formatos-personagem, D7, tarefa 3.6)', () => {
    const TALK_1 = 'fx-talk-1';
    const TALK_2 = 'fx-talk-2';
    const TALK_3 = 'fx-talk-3';
    const originalLogoEngine = process.env.MC_TALK_ENGINE_LOGO;

    beforeEach(() => {
      project.status = McProjectStatus.VISUAL_REVIEW;
      project.format = 'talking_art';
      project.script = fixtureTalkTileScript();
      project.tier = 'economico';
      project.quality = resolveQuality({
        preparation: {
          revision: 1,
          kitId: 'k1',
          kitVersion: 1,
          aspectRatio: '9:16',
          scenes: [],
          startedAt: 'now',
          completedAt: 'now',
          hash: 'manifest-talk',
        },
      });
      kit.tileAssetId = 'tile-1';
      kit.identityMode = 'generated';
      scenes = [TALK_1, TALK_2, TALK_3].map((sceneId, idx) => ({
        id: `talk-row-${idx + 1}`,
        projectId: 'p1',
        idx,
        scriptSceneId: sceneId,
        sceneType: 'talk_tile',
        generation: 1,
        status: McSceneStatus.PENDING,
        dialogue: 'fala',
        durationS: 6,
        keyframeAssetId: null, // talk_tile NÃO tem keyframe
        audioAssetId: `talk-au-${idx + 1}`,
        videoAssetId: null,
        finalAssetId: null,
        rerollCount: 0,
      }));
      assets = [1, 2, 3].map((n) => ({
        id: `talk-au-${n}`,
        userId,
        fileUrl: `/uploads/talk-au-${n}.mp3`,
        durationMs: 6000,
        metadata: { alignment: { characters: ['a'] } },
      }));
      delete process.env.MC_TALK_ENGINE_LOGO;
    });

    afterEach(() => {
      if (originalLogoEngine === undefined) delete process.env.MC_TALK_ENGINE_LOGO;
      else process.env.MC_TALK_ENGINE_LOGO = originalLogoEngine;
    });

    const approve = () =>
      service.approveProduction(userId, 'p1', {
        expectedRevision: 1,
        manifestHash: 'manifest-talk',
      });

    it('fala de 12 s com motor de 15 s/chamada → aprova sem exigir keyframe (um único clipe por fala)', async () => {
      assets[1].durationMs = 12000;
      await approve();
      expect(project.status).toBe(McProjectStatus.GENERATING);
      expect(materializer.materializeProductionV2).toHaveBeenCalled();
    });

    it('fala de 18 s com motor de 15 s/chamada → 422 SPEECH_SENTENCE_TOO_LONG com {sceneId, measuredS, limitS}, nada reservado', async () => {
      assets[0].durationMs = 3000; // soma 24 s: dentro de 6–25 (só a fala longa bloqueia)
      assets[2].durationMs = 3000;
      assets[1].durationMs = 18000;
      await expect(approve()).rejects.toMatchObject({
        status: 422,
        response: {
          code: 'SPEECH_SENTENCE_TOO_LONG',
          details: { sceneId: TALK_2, measuredS: 18, limitS: 15 },
          issues: [
            expect.objectContaining({
              code: 'SPEECH_SENTENCE_TOO_LONG',
              sceneId: TALK_2,
              message: expect.stringMatching(/18\.0s.*15s.*Divida a fala/),
            }),
          ],
        },
      });
      expect(credits.reserve).not.toHaveBeenCalled();
      expect(materializer.materializeProductionV2).not.toHaveBeenCalled();
      expect(project.status).toBe(McProjectStatus.VISUAL_REVIEW);
    });

    it('o limite vem do motor efetivo: logo_as_is em premium usa o motor de LOGO (maxChunkS próprio)', async () => {
      process.env.MC_TALK_ENGINE_LOGO = 'minimax/h3-max/lip-sync/image-to-video|0.08|10';
      project.tier = 'premium';
      kit.identityMode = 'logo_as_is';
      assets[0].durationMs = 12000; // cabe nos 15 s do premium, não nos 10 s do motor de logo
      await expect(approve()).rejects.toMatchObject({
        response: {
          code: 'SPEECH_SENTENCE_TOO_LONG',
          details: expect.objectContaining({ sceneId: TALK_1, measuredS: 12, limitS: 10 }),
        },
      });
    });

    it('kit sem tile de fala → 422 KIT_TILE_MISSING (a imagem do clipe é o tile, não um keyframe)', async () => {
      kit.tileAssetId = null;
      await expect(approve()).rejects.toMatchObject({ response: { code: 'KIT_TILE_MISSING' } });
      expect(credits.reserve).not.toHaveBeenCalled();
    });

    it('voz selecionada indisponível continua bloqueando (AUDIO_MISSING)', async () => {
      assets[2].fileUrl = null;
      await expect(approve()).rejects.toMatchObject({ response: { code: 'AUDIO_MISSING' } });
    });

    // ── tarefa 4.3 + revisão: limite com fallback, ações, duração total, steps de projeto ──

    it('SPEECH_SENTENCE_TOO_LONG carrega actions e os dois motores; o limite é o MENOR entre o escolhido e o fallback', async () => {
      assets[0].durationMs = 3000;
      assets[2].durationMs = 3000;
      assets[1].durationMs = 18000;
      await expect(approve()).rejects.toMatchObject({
        response: {
          details: {
            sceneId: TALK_2,
            limitS: 15,
            engine: expect.any(String),
            fallbackEngine: null, // kit gerado: sem fallback
            actions: ['split_speech', 'shorten_speech'],
          },
        },
      });
      // logo_as_is: motor de logo aceita 20 s, mas o fallback (motor do tier, 15 s) limita
      process.env.MC_TALK_ENGINE_LOGO = 'minimax/h3-max/lip-sync/image-to-video|0.08|20';
      kit.identityMode = 'logo_as_is';
      assets[1].durationMs = 16000;
      await expect(approve()).rejects.toMatchObject({
        response: {
          code: 'SPEECH_SENTENCE_TOO_LONG',
          details: expect.objectContaining({
            limitS: 15,
            engine: 'minimax/h3-max/lip-sync/image-to-video',
            fallbackEngine: expect.stringContaining('kling'),
          }),
        },
      });
    });

    it('KIT_TILE_MISSING: kit aprovado é imutável — a saída é criar um kit novo (actions: create_kit)', async () => {
      kit.tileAssetId = null;
      await expect(approve()).rejects.toMatchObject({
        response: {
          code: 'KIT_TILE_MISSING',
          message: expect.stringMatching(
            /crie um novo kit \(ou escolha um kit aprovado depois da atualização\)/,
          ),
          details: { kitId: 'k1', actions: ['create_kit'] },
        },
      });
    });

    it('soma das falas fora de 6–25 s ⇒ 422 SPEECH_DURATION_OUT_OF_RANGE com actions; aceite explícito libera e fica persistido', async () => {
      assets.forEach((a) => (a.durationMs = 1500)); // 4,5 s no total
      await expect(approve()).rejects.toMatchObject({
        status: 422,
        response: {
          code: 'SPEECH_DURATION_OUT_OF_RANGE',
          message: expect.stringMatching(/4\.5s.*6 a 25s.*Acrescente o convite/),
          details: { totalS: 4.5, minS: 6, maxS: 25, actions: ['adjust_text', 'accept_duration'] },
        },
      });
      expect(credits.reserve).not.toHaveBeenCalled();
      // 32 s também bloqueia (mensagem de reduzir)
      assets.forEach((a) => (a.durationMs = 12000));
      assets[2].durationMs = 8000;
      await expect(approve()).rejects.toMatchObject({
        response: {
          code: 'SPEECH_DURATION_OUT_OF_RANGE',
          message: expect.stringMatching(/32\.0s.*Reduza o texto/),
        },
      });
      // aceite explícito: aprova e grava speechDurationAccepted
      await service.approveProduction(userId, 'p1', {
        expectedRevision: 1,
        manifestHash: 'manifest-talk',
        acceptSpeechDuration: true,
      });
      expect(project.status).toBe(McProjectStatus.GENERATING);
      expect((project.quality as McQualityState).speechDurationAccepted).toBe(true);
    });

    it('aceite persistido numa aprovação anterior dispensa o novo aceite; 14 s não exige nada', async () => {
      project.quality = resolveQuality({
        ...(project.quality as McQualityState),
        speechDurationAccepted: true,
      });
      assets.forEach((a) => (a.durationMs = 1000));
      await approve();
      expect(project.status).toBe(McProjectStatus.GENERATING);
      project.status = McProjectStatus.VISUAL_REVIEW;
      project.quality = resolveQuality({ ...(project.quality as McQualityState), approval: null });
      assets.forEach((a) => (a.durationMs = 4667));
      await approve();
      expect(project.status).toBe(McProjectStatus.GENERATING);
    });

    it('a cotação da produção F1 fecha com compose_ffmpeg + finalize (nunca assembly) e a cadeia de projeto é materializada', async () => {
      await approve();
      const budget = (project.quality as McQualityState).budgets.find(
        (b) => b.phase === 'production',
      );
      const projectSteps = (budget?.items ?? [])
        .filter((i) => i.sceneId === null)
        .map((i) => i.stepType);
      expect(projectSteps).toEqual([McStepType.COMPOSE_FFMPEG, McStepType.FINALIZE]);
      expect(materializer.ensureAssemblyStepV2).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ format: 'talking_art' }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('assembly_only no F1: approveAssembly com os clipes prontos refaz só a cadeia compose → finalize', async () => {
      project.quality = resolveQuality({
        ...(project.quality as McQualityState),
        pendingScope: 'assembly_only',
      });
      scenes.forEach((s, i) => {
        s.status = McSceneStatus.READY;
        s.finalAssetId = `talk-final-${i}`;
      });
      await service.approveAssembly(userId, 'p1', 1);
      expect(project.status).toBe(McProjectStatus.ASSEMBLING);
      const budget = (project.quality as McQualityState).budgets.find(
        (b) => b.phase === 'assembly',
      );
      expect(budget?.items.map((i) => i.stepType)).toEqual([
        McStepType.COMPOSE_FFMPEG,
        McStepType.FINALIZE,
      ]);
      expect(materializer.ensureAssemblyStepV2).toHaveBeenCalled();
      expect(materializer.materializeProductionV2).not.toHaveBeenCalled();
    });

    it('validação FORMAT-AWARE no service: cena gerada num projeto F1 e fala do tile num projeto scenes ⇒ 422 SCENE_TYPE_NOT_ALLOWED_FOR_FORMAT', async () => {
      project.status = McProjectStatus.STORYBOARD_REVIEW;
      await expect(
        service.updateScript(userId, 'p1', {
          expectedRevision: 1,
          scenes: [
            {
              sceneType: 'presenter',
              initialFrame: 'frente',
              actionPrompt: 'acena para a câmera',
              dialogue: 'Oi!',
              durationS: 5,
              productRef: null,
            },
          ],
        }),
      ).rejects.toMatchObject({
        status: 422,
        response: {
          code: 'SCRIPT_INVALID',
          issues: expect.arrayContaining([
            expect.objectContaining({ code: 'SCENE_TYPE_NOT_ALLOWED_FOR_FORMAT' }),
          ]),
        },
      });
      project.format = 'scenes';
      project.script = scriptV2();
      await expect(
        service.updateScript(userId, 'p1', {
          expectedRevision: 1,
          scenes: [{ sceneType: 'talk_tile', dialogue: 'Oi!', durationS: 5, productRef: null }],
        }),
      ).rejects.toMatchObject({
        response: {
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: 'SCENE_TYPE_NOT_ALLOWED_FOR_FORMAT',
              message:
                'Cena 1: o tipo "fala do tile" só existe nos formatos arte que fala e ofertas em sequência.',
            }),
          ]),
        },
      });
    });

    it('updateScript preserva narração/janela/ofertas citadas do roteiro F1 quando o DTO as omite, e aceita as enviadas', async () => {
      project.status = McProjectStatus.STORYBOARD_REVIEW;
      const previous = project.script as McScript;
      await service.updateScript(userId, 'p1', {
        expectedRevision: 1,
        scenes: previous.scenes.map((s) => ({
          sceneId: s.sceneId,
          sceneType: 'talk_tile',
          dialogue: s.dialogue,
          durationS: s.durationS,
          productRef: null,
        })),
      });
      const kept = project.script as McScript;
      expect(kept).toMatchObject({
        format: 'talking_art',
        narration: previous.narration,
        window: previous.window,
        logoFace: false,
        citedOfferIds: [],
      });
      project.status = McProjectStatus.STORYBOARD_REVIEW;
      await service.updateScript(userId, 'p1', {
        expectedRevision: 2,
        scenes: kept.scenes.map((s) => ({
          sceneId: s.sceneId,
          sceneType: 'talk_tile',
          dialogue: s.dialogue,
          durationS: s.durationS,
          productRef: null,
        })),
        window: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 },
        logoFace: true,
        talkBackgroundColor: '#ABCDEF',
      });
      expect(project.script).toMatchObject({
        window: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 },
        logoFace: true,
        talkBackgroundColor: '#ABCDEF',
      });
    });
  });
});
