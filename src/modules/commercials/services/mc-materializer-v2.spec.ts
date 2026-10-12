import { EntityManager } from 'typeorm';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { CommercialsService } from '../commercials.service';
import { fixtureTalkTileScript } from '../domain/__fixtures__/mc-script-v2.fixtures';
import {
  KLING_AVATAR_MODEL,
  KLING_AVATAR_PRO_MODEL,
  MINIMAX_H3_LIPSYNC_MODEL,
} from '../domain/mc-pipeline.config';
import { MC_PIPELINE_V2, MC_SCRIPT_SCHEMA_V2 } from '../domain/mc-quality';
import { sceneSourceHash } from '../domain/mc-script-v2';
import { McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { computeTtsHashV2 } from '../domain/mc-step-hashes';
import { kitVoiceDelivery } from '../domain/mc-voice-delivery';
import { McScript, McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McMaterializerService } from './mc-materializer.service';

/**
 * Manager fake em memória: `saved` guarda entidades; find/findOne filtram por
 * igualdade rasa das chaves do `where`; o QueryBuilder do cache é
 * configurável. Suficiente para provar a materialização v2 sem banco.
 */
function fakeManager(
  opts: {
    cache?: Array<{ id: string; outputAssetId: string } | null>;
    assets?: Partial<AnimationAsset>[];
  } = {},
) {
  let seq = 0;
  const rows = new Map<unknown, Array<Record<string, unknown>>>();
  const table = (entity: unknown) => {
    if (!rows.has(entity)) rows.set(entity, []);
    return rows.get(entity)!;
  };
  if (opts.assets) rows.set(AnimationAsset, opts.assets as Array<Record<string, unknown>>);
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const value = row[k];
      if (v && typeof v === 'object' && '_type' in (v as object)) {
        // TypeORM In(): { _type: 'in', _value: [...] }
        return ((v as { _value: unknown[] })._value ?? []).includes(value);
      }
      return value === v;
    });
  const cacheResults = [...(opts.cache ?? [])];
  const qb = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getOne: jest.fn(() => Promise.resolve(cacheResults.shift() ?? null)),
  };
  const manager = {
    rows,
    create: jest.fn((_e: unknown, obj: Record<string, unknown>) => ({ ...obj })),
    save: jest.fn((obj: Record<string, unknown> & { id?: string }) => {
      if (!obj.id) obj.id = `id-${++seq}`;
      const entity =
        'inputHash' in obj
          ? McStep
          : 'scriptSceneId' in obj || 'rerollCount' in obj
            ? McScene
            : McProject;
      const list = table(entity);
      const existing = list.findIndex((r) => r.id === obj.id);
      if (existing >= 0) list[existing] = obj;
      else list.push(obj);
      return Promise.resolve(obj);
    }),
    update: jest.fn(
      (entity: unknown, where: Record<string, unknown>, patch: Record<string, unknown>) => {
        let affected = 0;
        for (const row of table(entity)) {
          if (matches(row, where)) {
            Object.assign(row, patch);
            affected += 1;
          }
        }
        return Promise.resolve({ affected });
      },
    ),
    find: jest.fn((entity: unknown, options: { where: Record<string, unknown>; order?: unknown }) =>
      Promise.resolve(table(entity).filter((r) => matches(r, options.where ?? {}))),
    ),
    findOne: jest.fn((entity: unknown, options: { where: Record<string, unknown> }) =>
      Promise.resolve(table(entity).find((r) => matches(r, options.where ?? {})) ?? null),
    ),
    createQueryBuilder: jest.fn(() => qb),
    seed(entity: unknown, list: Array<Record<string, unknown>>) {
      rows.set(entity, list);
    },
    steps: () => table(McStep) as unknown as McStep[],
    scenes: () => table(McScene) as unknown as McScene[],
  };
  return manager as unknown as EntityManager & typeof manager;
}

const kit = {
  id: 'kit-1',
  userId: 'u1',
  version: 1,
  voiceId: 'voice-1',
  referenceAssetIds: ['r0', 'r1', 'r2', 'r3'],
  cutoutAssetId: null,
} as unknown as McCharacterKit;

const kitAssets = [
  { id: 'r0', fileUrl: '/uploads/r0.png', metadata: { slot: 0 } },
  { id: 'r1', fileUrl: '/uploads/r1.png', metadata: { slot: 1 } },
  { id: 'r2', fileUrl: '/uploads/r2.png', metadata: { slot: 2 } },
  { id: 'r3', fileUrl: '/uploads/r3.png', metadata: { slot: 3 } },
];

function derived(scene: { initialFrame?: string; actionPrompt: string }, en: string) {
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
  const s3 = { initialFrame: 'corpo inteiro', actionPrompt: 'joinha' };
  return {
    version: 1,
    schemaVersion: MC_SCRIPT_SCHEMA_V2,
    products: [{ id: 'p1', name: 'Arroz', price: '24,90' }],
    environments: [],
    scenes: [
      {
        idx: 0,
        sceneId: 's1',
        sceneType: 'presenter',
        ...s1,
        dialogue: 'Oi!',
        durationS: 6,
        productRef: null,
        derived: derived(s1, 'waves'),
      },
      {
        idx: 1,
        sceneId: 's2',
        sceneType: 'action_voiceover',
        ...s2,
        dialogue: 'Leve por nove e noventa',
        durationS: 5,
        productRef: 'p1',
        derived: derived(s2, 'picks the box'),
      },
      {
        idx: 2,
        sceneId: 's3',
        sceneType: 'action',
        ...s3,
        dialogue: null,
        durationS: 4,
        productRef: null,
        derived: derived(s3, 'thumbs up'),
      },
    ],
    seal: null,
    endcard: null,
  };
}

function projectV2(script: McScript, revision = 1): McProject {
  return {
    id: 'proj-1',
    userId: 'u1',
    kitId: 'kit-1',
    aspectRatio: '9:16',
    pipelineVersion: MC_PIPELINE_V2,
    revision,
    script,
    options: null,
  } as unknown as McProject;
}

describe('McMaterializerService — pipeline v2 (ADR §3.3/§4.2)', () => {
  let service: McMaterializerService;
  beforeEach(() => {
    service = new McMaterializerService({
      appendEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as CommercialsService);
  });

  it('syncScenesV2 cria linhas por IDENTIDADE e reordena sem perder fala/tipo', async () => {
    const manager = fakeManager({ assets: kitAssets });
    const script = scriptV2();
    const project = projectV2(script);
    const created = await service.syncScenesV2(manager, project, script, { rearm: true });
    expect(created.map((s) => [s.idx, s.scriptSceneId, s.sceneType])).toEqual([
      [0, 's1', 'presenter'],
      [1, 's2', 'action_voiceover'],
      [2, 's3', 'action'],
    ]);
    // reordena: s3, s1, s2 — a fala e o tipo seguem a identidade
    const reordered: McScript = {
      ...script,
      scenes: [
        { ...script.scenes[2], idx: 0 },
        { ...script.scenes[0], idx: 1 },
        { ...script.scenes[1], idx: 2 },
      ],
    };
    const after = await service.syncScenesV2(manager, project, reordered, { rearm: true });
    expect(after.map((s) => [s.idx, s.scriptSceneId, s.dialogue])).toEqual([
      [0, 's3', null],
      [1, 's1', 'Oi!'],
      [2, 's2', 'Leve por nove e noventa'],
    ]);
    expect(manager.scenes()).toHaveLength(3); // nenhuma linha duplicada
    // remove s2: linha cancelada, idx negativo (libera o espaço), steps ociosos cancelados
    manager.seed(McStep, [
      { id: 'st', sceneId: after[2].id, status: McStepStatus.PENDING, type: McStepType.KEYFRAME },
    ]);
    const removed: McScript = { ...reordered, scenes: reordered.scenes.slice(0, 2) };
    const live = await service.syncScenesV2(manager, project, removed, { rearm: true });
    expect(live.map((s) => s.scriptSceneId)).toEqual(['s3', 's1']);
    const s2Row = manager.scenes().find((s) => s.scriptSceneId === 's2')!;
    expect(s2Row.status).toBe(McSceneStatus.CANCELED);
    expect(s2Row.idx).toBeLessThan(0);
    expect(manager.steps()[0].status).toBe(McStepStatus.CANCELED);
  });

  it('materializePreparationV2: steps de preparação por TIPO (action sem TTS), com snapshot, fase e revisão', async () => {
    const manager = fakeManager({ assets: kitAssets });
    const script = scriptV2();
    const project = projectV2(script);
    const scenes = await service.syncScenesV2(manager, project, script, { rearm: true });
    const { steps, items } = await service.materializePreparationV2(
      manager,
      project,
      kit,
      script,
      scenes,
    );
    const byScene = (id: string) =>
      steps
        .filter((s) => s.sceneId === scenes.find((x) => x.scriptSceneId === id)!.id)
        .map((s) => s.type)
        .sort();
    expect(byScene('s1')).toEqual([McStepType.KEYFRAME, McStepType.TTS]);
    expect(byScene('s2')).toEqual([McStepType.KEYFRAME, McStepType.TTS]);
    expect(byScene('s3')).toEqual([McStepType.KEYFRAME]);
    expect(
      steps.every((s) => s.phase === 'preparation' && s.projectRevision === 1 && s.attempt === 1),
    ).toBe(true);
    expect(steps.every((s) => s.status === McStepStatus.PENDING)).toBe(true);
    // cotação: 3 keyframes + 2 tts
    expect(items.reduce((sum, i) => sum + i.credits, 0)).toBe(3 * 1 + 2 * 4);
    // snapshot do keyframe: prompt efetivo EN, idioma, referências por função (cena com produto leva o slot 3)
    const kf2 = steps.find((s) => s.type === McStepType.KEYFRAME && s.sceneId === scenes[1].id)!;
    const snap = kf2.inputSnapshot as {
      prompt: string;
      motion: string;
      lang: string;
      references: Array<{ slot: number | null; role: string }>;
    };
    expect(snap.lang).toBe('en');
    expect(snap.motion).toBe('picks the box');
    expect(snap.references.map((r) => r.slot)).toEqual([0, 3, 1]);
    expect(snap.references[1].role).toBe('interaction');
    // presenter leva a expressão de fala
    const kf1 = steps.find((s) => s.type === McStepType.KEYFRAME && s.sceneId === scenes[0].id)!;
    expect(
      (kf1.inputSnapshot as { references: Array<{ slot: number | null }> }).references.map(
        (r) => r.slot,
      ),
    ).toEqual([0, 2, 1]);
  });

  it('preparação pendente de derivação lança (PT editado não usa EN antiga)', async () => {
    const manager = fakeManager({ assets: kitAssets });
    const script = scriptV2();
    script.scenes[1].actionPrompt = 'larga a caixa'; // derived ficou de outra intenção
    const project = projectV2(script);
    const scenes = await service.syncScenesV2(manager, project, script, { rearm: true });
    await expect(
      service.materializePreparationV2(manager, project, kit, script, scenes),
    ).rejects.toThrow(/derivação pendente/);
  });

  it('reuso seletivo: asset SELECIONADO com o mesmo baseHash nasce skipped_cached; intenção editada gera tentativa nova', async () => {
    const manager = fakeManager({ assets: kitAssets });
    const script = scriptV2();
    const project = projectV2(script, 1);
    const scenes = await service.syncScenesV2(manager, project, script, { rearm: true });
    const first = await service.materializePreparationV2(manager, project, kit, script, scenes);
    // simula conclusão: keyframe/tts de s1 produziram assets e a cena os selecionou
    const s1 = scenes[0];
    const kf = first.steps.find((s) => s.sceneId === s1.id && s.type === McStepType.KEYFRAME)!;
    const tts = first.steps.find((s) => s.sceneId === s1.id && s.type === McStepType.TTS)!;
    await manager.update(
      McStep,
      { id: kf.id },
      { status: McStepStatus.SUCCEEDED, outputAssetId: 'a-kf' },
    );
    await manager.update(
      McStep,
      { id: tts.id },
      { status: McStepStatus.SUCCEEDED, outputAssetId: 'a-tts' },
    );
    await manager.update(
      McScene,
      { id: s1.id },
      { keyframeAssetId: 'a-kf', audioAssetId: 'a-tts' },
    );

    // nova revisão: fala de s1 mudou (TTS refeito), imagem igual (reaproveitada)
    const next = scriptV2();
    next.scenes[0].dialogue = 'Olá de novo!';
    const project2 = projectV2(next, 2);
    const scenes2 = await service.syncScenesV2(manager, project2, next, { rearm: true });
    const second = await service.materializePreparationV2(manager, project2, kit, next, scenes2);
    const kf2 = second.steps.find(
      (s) => s.sceneId === scenes2[0].id && s.type === McStepType.KEYFRAME,
    )!;
    const tts2 = second.steps.find(
      (s) => s.sceneId === scenes2[0].id && s.type === McStepType.TTS,
    )!;
    expect(kf2.status).toBe(McStepStatus.SKIPPED_CACHED);
    expect(kf2.outputAssetId).toBe('a-kf');
    expect(kf2.projectRevision).toBe(2);
    expect(tts2.status).toBe(McStepStatus.PENDING);
    expect(tts2.attempt).toBe(2); // nova tentativa lógica
    const item = second.items.find(
      (i) => i.sceneId === 's1' && i.stepType === McStepType.KEYFRAME,
    )!;
    expect(item).toMatchObject({ cached: true, credits: 0 });
  });

  it('createPreviewAttemptV2: regenerar imagem é tentativa nova (attempt+1) e NUNCA consulta o cache', async () => {
    const manager = fakeManager({
      assets: kitAssets,
      cache: [{ id: 'old', outputAssetId: 'rejected' }],
    });
    const script = scriptV2();
    const project = projectV2(script);
    const scenes = await service.syncScenesV2(manager, project, script, { rearm: true });
    await service.materializePreparationV2(manager, project, kit, script, scenes);
    const step = await service.createPreviewAttemptV2(
      manager,
      project,
      kit,
      script,
      scenes[0],
      McStepType.KEYFRAME,
    );
    expect(step.attempt).toBe(2);
    expect(step.status).toBe(McStepStatus.PENDING);
    expect(step.outputAssetId).toBeNull();
    const firstHash = manager
      .steps()
      .find(
        (s) => s.sceneId === scenes[0].id && s.type === McStepType.KEYFRAME && s.attempt === 1,
      )!.inputHash;
    expect(step.inputHash).not.toBe(firstHash);
  });

  it('materializeProductionV2: grafo por tipo — presenter=lipsync, action=video, voiceover=video+scene_compose (nunca lipsync)', async () => {
    const manager = fakeManager({ assets: kitAssets });
    const script = scriptV2();
    const project = projectV2(script);
    const scenes = await service.syncScenesV2(manager, project, script, { rearm: true });
    for (const scene of scenes) {
      await manager.update(
        McScene,
        { id: scene.id },
        {
          keyframeAssetId: `kf-${scene.scriptSceneId}`,
          audioAssetId: scene.sceneType === 'action' ? null : `au-${scene.scriptSceneId}`,
        },
      );
      Object.assign(scene, {
        keyframeAssetId: `kf-${scene.scriptSceneId}`,
        audioAssetId: scene.sceneType === 'action' ? null : `au-${scene.scriptSceneId}`,
      });
    }
    const { steps, items } = await service.materializeProductionV2(
      manager,
      project,
      script,
      scenes,
    );
    const types = (id: string) =>
      steps
        .filter((s) => s.sceneId === scenes.find((x) => x.scriptSceneId === id)!.id)
        .map((s) => s.type);
    expect(types('s1')).toEqual([McStepType.LIPSYNC]);
    expect(types('s2')).toEqual([McStepType.VIDEO, McStepType.SCENE_COMPOSE]);
    expect(types('s3')).toEqual([McStepType.VIDEO]);
    expect(steps.some((s) => s.type === McStepType.LIPSYNC && s.sceneId === scenes[1].id)).toBe(
      false,
    );
    expect(steps.every((s) => s.phase === 'production' && s.projectRevision === 1)).toBe(true);
    // presenter: o movimento (EN efetivo) viaja no snapshot do lipsync → prompt do Avatar
    const lipsync = steps.find((s) => s.type === McStepType.LIPSYNC)!;
    expect(lipsync.inputSnapshot).toMatchObject({
      motion: expect.any(String),
      lang: expect.stringMatching(/^(en|pt)$/),
    });
    // estimativa/reserva sem Avatar no voiceover: 56 + 89 + 0 + 89
    expect(items.reduce((sum, i) => sum + i.credits, 0)).toBe(56 + 89 + 89);
    // snapshot de vídeo carrega o keyframe selecionado e o movimento efetivo
    const video2 = steps.find((s) => s.type === McStepType.VIDEO && s.sceneId === scenes[1].id)!;
    expect(video2.inputSnapshot).toMatchObject({
      keyframeAssetId: 'kf-s2',
      motion: 'picks the box',
      providerDuration: '5',
    });
  });

  it('regravar locução de voiceover PRESERVA o vídeo (cache por hash do keyframe+movimento) e refaz só o scene_compose', async () => {
    const manager = fakeManager({
      assets: kitAssets,
      cache: [{ id: 'old-video', outputAssetId: 'vid-s2' }],
    });
    const script = scriptV2();
    const project = projectV2(script, 2);
    const scenes = await service.syncScenesV2(manager, project, script, { rearm: true });
    const s2 = scenes[1];
    await manager.update(
      McScene,
      { id: s2.id },
      { keyframeAssetId: 'kf-s2', audioAssetId: 'au-s2-v2' },
    );
    Object.assign(s2, { keyframeAssetId: 'kf-s2', audioAssetId: 'au-s2-v2' });
    const { steps } = await service.materializeProductionV2(manager, project, script, [s2]);
    const video = steps.find((s) => s.type === McStepType.VIDEO)!;
    const compose = steps.find((s) => s.type === McStepType.SCENE_COMPOSE)!;
    expect(video.status).toBe(McStepStatus.SKIPPED_CACHED);
    expect(video.outputAssetId).toBe('vid-s2');
    expect(compose.status).toBe(McStepStatus.PENDING);
    expect(compose.inputSnapshot).toMatchObject({
      videoAssetId: 'vid-s2',
      audioAssetId: 'au-s2-v2',
    });
    // o atalho da cena aponta o vídeo reaproveitado
    expect(manager.scenes().find((s) => s.id === s2.id)!.videoAssetId).toBe('vid-s2');
  });

  it('final em cache ⇒ cena pronta sem job (produção idêntica reaproveitada)', async () => {
    const manager = fakeManager({
      assets: kitAssets,
      cache: [{ id: 'old-lipsync', outputAssetId: 'final-s1' }],
    });
    const script = scriptV2();
    const project = projectV2(script, 2);
    const scenes = await service.syncScenesV2(manager, project, script, { rearm: true });
    const s1 = scenes[0];
    Object.assign(s1, { keyframeAssetId: 'kf', audioAssetId: 'au' });
    const { steps } = await service.materializeProductionV2(manager, project, script, [s1]);
    expect(steps[0].status).toBe(McStepStatus.SKIPPED_CACHED);
    const row = manager.scenes().find((s) => s.id === s1.id)!;
    expect(row.status).toBe(McSceneStatus.READY);
    expect(row.finalAssetId).toBe('final-s1');
  });

  it('manifesto de preparação: assets selecionados, duração medida, referências e hash assinável', async () => {
    const manager = fakeManager({
      assets: [...kitAssets, { id: 'au-s1', durationMs: 4200, metadata: {} }],
    });
    const script = scriptV2();
    const project = projectV2(script);
    const scenes = await service.syncScenesV2(manager, project, script, { rearm: true });
    const { steps } = await service.materializePreparationV2(manager, project, kit, script, scenes);
    const kf = steps.find((s) => s.sceneId === scenes[0].id && s.type === McStepType.KEYFRAME)!;
    const tts = steps.find((s) => s.sceneId === scenes[0].id && s.type === McStepType.TTS)!;
    await manager.update(
      McStep,
      { id: kf.id },
      { status: McStepStatus.SUCCEEDED, outputAssetId: 'kf-s1' },
    );
    await manager.update(
      McStep,
      { id: tts.id },
      { status: McStepStatus.SUCCEEDED, outputAssetId: 'au-s1' },
    );
    Object.assign(scenes[0], { keyframeAssetId: 'kf-s1', audioAssetId: 'au-s1' });
    const manifest = await service.buildPreparationManifest(manager, project, kit, script, scenes, {
      completed: true,
    });
    expect(manifest.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.scenes[0]).toMatchObject({
      sceneId: 's1',
      keyframeAssetId: 'kf-s1',
      audioAssetId: 'au-s1',
      audioDurationMs: 4200,
      promptLang: 'en',
      keyframeHash: kf.inputHash,
    });
    expect(manifest.scenes[0].references.map((r) => r.slot)).toEqual([0, 2, 1]);
    expect(manifest.scenes[1].productRef).toBe('p1');
    // selecionar outro asset muda o hash (a aprovação assina exatamente o que foi visto)
    Object.assign(scenes[0], { keyframeAssetId: 'kf-other' });
    const other = await service.buildPreparationManifest(manager, project, kit, script, scenes, {
      completed: true,
    });
    expect(other.hash).not.toBe(manifest.hash);
  });
});

/**
 * Cenas talk_tile (change video-formatos-personagem, D1/D2/D6/D7): preparação só
 * TTS (sem keyframe, sem derivação obrigatória), produção só `talk` com o tile,
 * a cor da janela e o motor do tier/identidade no hash e no snapshot.
 */
describe('McMaterializerService — cenas talk_tile (tarefas 3.3/3.4/3.8)', () => {
  const talkKit = {
    id: 'kit-1',
    userId: 'u1',
    version: 1,
    voiceId: 'voice-1',
    referenceAssetIds: [],
    cutoutAssetId: null,
    tileAssetId: 'tile-1',
    tileBackgroundColor: '#112233',
    identityMode: 'generated',
    source: 'mascot',
    style: '3d_render',
  } as unknown as McCharacterKit;
  const tileAsset = { id: 'tile-1', fileUrl: '/uploads/tile.png', width: 720, height: 960 };
  const originalEngines = {
    eco: process.env.MC_TALK_ENGINE_ECONOMICO,
    pre: process.env.MC_TALK_ENGINE_PREMIUM,
    logo: process.env.MC_TALK_ENGINE_LOGO,
  };
  let service: McMaterializerService;

  function talkProject(script: McScript, tier: 'economico' | 'premium' = 'economico'): McProject {
    return {
      id: 'proj-talk',
      userId: 'u1',
      kitId: 'kit-1',
      aspectRatio: '9:16',
      pipelineVersion: MC_PIPELINE_V2,
      revision: 1,
      tier,
      format: 'talking_art',
      script,
      options: null,
    } as unknown as McProject;
  }

  beforeEach(() => {
    delete process.env.MC_TALK_ENGINE_ECONOMICO;
    delete process.env.MC_TALK_ENGINE_PREMIUM;
    delete process.env.MC_TALK_ENGINE_LOGO;
    service = new McMaterializerService({
      appendEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as CommercialsService);
  });

  afterEach(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('MC_TALK_ENGINE_ECONOMICO', originalEngines.eco);
    restore('MC_TALK_ENGINE_PREMIUM', originalEngines.pre);
    restore('MC_TALK_ENGINE_LOGO', originalEngines.logo);
  });

  async function prepared(script: McScript, tier: 'economico' | 'premium' = 'economico') {
    const manager = fakeManager({ assets: [tileAsset] });
    manager.seed(McCharacterKit, [{ ...talkKit }]);
    const project = talkProject(script, tier);
    const scenes = await service.syncScenesV2(manager, project, script, { rearm: true });
    const preparation = await service.materializePreparationV2(
      manager,
      project,
      talkKit,
      script,
      scenes,
    );
    return { manager, project, scenes, preparation };
  }

  it('preparação: só TTS por fala (nunca keyframe), sem exigir derivação; cotação 3 × 4 cr', async () => {
    const script = fixtureTalkTileScript();
    const { preparation, scenes } = await prepared(script);
    expect(preparation.steps.map((s) => s.type)).toEqual([
      McStepType.TTS,
      McStepType.TTS,
      McStepType.TTS,
    ]);
    expect(preparation.steps.every((s) => s.phase === 'preparation' && s.attempt === 1)).toBe(true);
    expect(preparation.items.reduce((sum, i) => sum + i.credits, 0)).toBe(12);
    const tts2 = preparation.steps.find((s) => s.sceneId === scenes[1].id)!;
    expect(tts2.inputSnapshot).toMatchObject({
      dialogue: script.scenes[1].dialogue,
      voiceId: 'voice-1',
      plannedDurationS: 7,
    });
  });

  it('produção: um `talk` por fala com tile, áudio, cor da janela e motor do tier no snapshot; hash muda com a cor e com o tier', async () => {
    const script = fixtureTalkTileScript({ backgroundColor: '#ff8800' });
    const { manager, project, scenes } = await prepared(script);
    for (const scene of scenes) {
      await manager.update(
        McScene,
        { id: scene.id },
        { audioAssetId: `au-${scene.scriptSceneId}` },
      );
      Object.assign(scene, { audioAssetId: `au-${scene.scriptSceneId}` });
    }
    const { steps, items } = await service.materializeProductionV2(
      manager,
      project,
      script,
      scenes,
    );
    expect(steps.map((s) => s.type)).toEqual([McStepType.TALK, McStepType.TALK, McStepType.TALK]);
    expect(steps.every((s) => s.status === McStepStatus.PENDING && s.phase === 'production')).toBe(
      true,
    );
    expect(items.reduce((sum, i) => sum + i.credits, 0)).toBe(3 * 56);
    const talk1 = steps[0];
    expect(talk1.inputSnapshot).toMatchObject({
      tileAssetId: 'tile-1',
      tileWidth: 720,
      tileHeight: 960,
      audioAssetId: 'au-fx-talk-1',
      backgroundColor: '#FF8800', // cor da janela do roteiro, normalizada
      motion: 'Waves at the start.',
      lang: 'en',
      engine: expect.objectContaining({ key: 'economico', model: KLING_AVATAR_MODEL }),
      tier: 'economico',
      identityMode: 'generated',
      sceneType: 'talk_tile',
    });
    expect((talk1.inputSnapshot as { prompt: string }).prompt).toContain('neutral, front-facing');
    // sem gesto: prompt só com o sufixo fixo, motion vazio em pt
    expect(steps[1].inputSnapshot).toMatchObject({ motion: '', lang: 'pt' });
    // nunca há arte de fundo no snapshot do talk
    expect(Object.keys(talk1.inputSnapshot as object)).not.toEqual(
      expect.arrayContaining(['backgroundArtAssetId', 'keyframeAssetId']),
    );

    // cor diferente → hash diferente (clipe regerado; o TTS é outro step)
    const recolored = fixtureTalkTileScript({ backgroundColor: '#00ff00' });
    const other = await service.materializeProductionV2(
      manager,
      { ...project, revision: 2, script: recolored } as McProject,
      recolored,
      scenes,
      { forceNewAttempt: false },
    );
    expect(other.steps[0].inputHash).not.toBe(talk1.inputHash);
    // mesma cor em caixa diferente → mesma requisição
    const same = fixtureTalkTileScript({ backgroundColor: '#FF8800' });
    const again = await service.materializeProductionV2(
      manager,
      { ...project, revision: 3, script: same } as McProject,
      same,
      scenes,
    );
    expect(again.steps[0].inputHash).toBe(talk1.inputHash);
  });

  it('cor da janela ausente cai no tileBackgroundColor do kit; tier premium troca o motor (e o hash)', async () => {
    const script = fixtureTalkTileScript();
    const { manager, scenes } = await prepared(script, 'premium');
    for (const scene of scenes) Object.assign(scene, { audioAssetId: 'au' });
    const premium = await service.materializeProductionV2(
      manager,
      talkProject(script, 'premium'),
      script,
      [scenes[0]],
    );
    expect(premium.steps[0].inputSnapshot).toMatchObject({
      backgroundColor: '#112233',
      tier: 'premium',
      engine: expect.objectContaining({ key: 'premium', model: KLING_AVATAR_PRO_MODEL }),
    });
    const economico = await service.materializeProductionV2(
      manager,
      { ...talkProject(script, 'economico'), revision: 2 } as McProject,
      script,
      [scenes[0]],
    );
    expect(economico.steps[0].inputHash).not.toBe(premium.steps[0].inputHash);
  });

  it('rosto do logo: sem cor no roteiro, a janela usa a cor AMOSTRADA da arte em volta da caixa (talk e hash do compose); a cor do roteiro ainda vence', async () => {
    const base = fixtureTalkTileScript();
    const script = { ...base, talkBackgroundColor: null, logoFace: true } as McScript;
    const manager = fakeManager({ assets: [tileAsset] });
    manager.seed(McCharacterKit, [{ ...talkKit, identityMode: 'logo_as_is', source: 'logo' }]);
    const box = {
      x: 0.04,
      y: 0.01,
      w: 0.12,
      h: 0.16,
      logoBoxSource: 'layout',
      logoBoxConfidence: null,
      logoBoxConfirmed: true,
    };
    const project = {
      ...talkProject(script),
      logoBox: { ...box, surroundColor: '#c62828' },
    } as unknown as McProject;
    const scenes = await service.syncScenesV2(manager, project, script, { rearm: true });
    for (const scene of scenes) Object.assign(scene, { audioAssetId: 'au' });
    const sampled = await service.materializeProductionV2(manager, project, script, [scenes[0]]);
    expect(sampled.steps[0].inputSnapshot).toMatchObject({
      backgroundColor: '#C62828',
      identityMode: 'logo_as_is',
    });

    // caixa antiga (sem amostra) → fundo do kit; hash diferente (o clipe muda de cor)
    const legacy = await service.materializeProductionV2(
      manager,
      { ...project, revision: 2, logoBox: box } as unknown as McProject,
      script,
      [scenes[0]],
    );
    expect(legacy.steps[0].inputSnapshot).toMatchObject({ backgroundColor: '#112233' });
    expect(legacy.steps[0].inputHash).not.toBe(sampled.steps[0].inputHash);

    // a cor escolhida no roteiro vence a amostrada
    const chosen = { ...script, talkBackgroundColor: '#F5F5F5' } as McScript;
    const picked = await service.materializeProductionV2(
      manager,
      { ...project, revision: 3, script: chosen } as unknown as McProject,
      chosen,
      [scenes[0]],
    );
    expect(picked.steps[0].inputSnapshot).toMatchObject({ backgroundColor: '#F5F5F5' });

    // compose: a mesma cor amostrada entra no hash (mudar a amostra refaz a composição)
    const composeA = await service.ensureAssemblyStepV2(manager, project, script, scenes);
    const hashA = composeA.inputHash;
    const composeB = await service.ensureAssemblyStepV2(
      manager,
      { ...project, logoBox: { ...box, surroundColor: '#1565C0' } } as unknown as McProject,
      script,
      scenes,
    );
    expect(composeB.inputHash).not.toBe(hashA);
  });

  it('logo_as_is usa o motor de logo em premium', async () => {
    const script = fixtureTalkTileScript();
    const manager = fakeManager({ assets: [tileAsset] });
    manager.seed(McCharacterKit, [{ ...talkKit, identityMode: 'logo_as_is', source: 'logo' }]);
    const project = talkProject(script, 'premium');
    const scenes = await service.syncScenesV2(manager, project, script, { rearm: true });
    for (const scene of scenes) Object.assign(scene, { audioAssetId: 'au' });
    const { steps } = await service.materializeProductionV2(manager, project, script, [scenes[0]]);
    expect(steps[0].inputSnapshot).toMatchObject({
      identityMode: 'logo_as_is',
      engine: expect.objectContaining({ key: 'logo', model: MINIMAX_H3_LIPSYNC_MODEL }),
    });
  });

  it('kit sem tile → erro de pré-condição antes de criar o step', async () => {
    const script = fixtureTalkTileScript();
    const manager = fakeManager({ assets: [] });
    manager.seed(McCharacterKit, [{ ...talkKit, tileAssetId: null }]);
    const project = talkProject(script);
    const scenes = await service.syncScenesV2(manager, project, script, { rearm: true });
    for (const scene of scenes) Object.assign(scene, { audioAssetId: 'au' });
    await expect(
      service.materializeProductionV2(manager, project, script, [scenes[0]]),
    ).rejects.toThrow(/sem tile de fala/);
    expect(manager.steps()).toHaveLength(0);
  });

  it('ensureAssemblyStepV2 no F1: cria a cadeia compose_ffmpeg → finalize (sceneId null, fase assembly, mesmo attempt); repetir só atualiza o hash; nova entrega abre attempt 2', async () => {
    const script = fixtureTalkTileScript({ backgroundColor: '#ABCDEF' });
    const { manager, project, scenes } = await prepared(script);
    scenes.forEach((s, i) => {
      s.status = McSceneStatus.READY;
      s.finalAssetId = `clip-${i}`;
    });
    const first = await service.ensureAssemblyStepV2(manager, project, script, scenes);
    const chain = () =>
      manager
        .steps()
        .filter((s) => s.sceneId === null)
        .map((s) => ({
          type: s.type,
          status: s.status,
          phase: s.phase,
          attempt: s.attempt,
          hash: s.inputHash,
          rev: s.projectRevision,
        }));
    expect(first.type).toBe(McStepType.COMPOSE_FFMPEG);
    expect(chain()).toEqual([
      expect.objectContaining({
        type: McStepType.COMPOSE_FFMPEG,
        status: McStepStatus.PENDING,
        phase: 'assembly',
        attempt: 1,
        rev: 1,
      }),
      expect.objectContaining({
        type: McStepType.FINALIZE,
        status: McStepStatus.PENDING,
        phase: 'assembly',
        attempt: 1,
        rev: 1,
      }),
    ]);
    expect(manager.steps().some((s) => s.type === McStepType.ASSEMBLY)).toBe(false);
    const composeHash = chain()[0].hash;

    // mesma composição ⇒ mesmo hash, sem duplicar; cor da janela diferente ⇒ hash novo
    await service.ensureAssemblyStepV2(manager, project, script, scenes);
    expect(chain()).toHaveLength(2);
    expect(chain()[0].hash).toBe(composeHash);
    await service.ensureAssemblyStepV2(
      manager,
      project,
      { ...script, talkBackgroundColor: '#000000' },
      scenes,
    );
    expect(chain()).toHaveLength(2);
    expect(chain()[0].hash).not.toBe(composeHash);

    // cadeia entregue ⇒ a próxima remontagem nasce com attempt 2 (o scheduler liga finalize ao compose da MESMA cadeia)
    for (const s of manager.steps().filter((x) => x.sceneId === null))
      s.status = McStepStatus.SUCCEEDED;
    await service.ensureAssemblyStepV2(manager, project, script, scenes);
    const pending = chain().filter((s) => s.status === McStepStatus.PENDING);
    expect(pending.map((s) => [s.type, s.attempt])).toEqual([
      [McStepType.COMPOSE_FFMPEG, 2],
      [McStepType.FINALIZE, 2],
    ]);
  });

  it('duplicar premium → econômico: tts clonado como skipped_cached é reaproveitado (selectedAssetMatches) e SÓ os talk executam', async () => {
    const script = fixtureTalkTileScript();
    const manager = fakeManager({ assets: [tileAsset] });
    manager.seed(McCharacterKit, [{ ...talkKit }]);
    const copy = { ...talkProject(script, 'economico'), revision: 0 } as McProject;
    // cenas da cópia com o áudio selecionado + clone do tts da origem (o que duplicateProject grava)
    const baseHashFor = (dialogue: string) =>
      computeTtsHashV2({
        delivery: kitVoiceDelivery(talkKit),
        dialogue,
        voiceId: 'voice-1',
        attempt: 0,
      });
    manager.seed(
      McScene,
      script.scenes.map((s, i) => ({
        id: `copy-sc-${i}`,
        projectId: copy.id,
        idx: i,
        scriptSceneId: s.sceneId,
        sceneType: 'talk_tile',
        generation: 1,
        rerollCount: 0,
        status: McSceneStatus.PENDING,
        durationS: s.durationS,
        actionPrompt: s.actionPrompt,
        dialogue: s.dialogue,
        audioAssetId: `au-${i}`,
        keyframeAssetId: null,
      })),
    );
    manager.seed(
      McStep,
      script.scenes.map((s, i) => ({
        id: `clone-tts-${i}`,
        projectId: copy.id,
        sceneId: `copy-sc-${i}`,
        sceneGeneration: 1,
        projectRevision: 0,
        phase: 'preparation',
        attempt: 1,
        type: McStepType.TTS,
        status: McStepStatus.SKIPPED_CACHED,
        inputHash: `h-${i}`,
        outputAssetId: `au-${i}`,
        inputSnapshot: { baseHash: baseHashFor(s.dialogue as string), dialogue: s.dialogue },
      })),
    );
    const scenes = await service.syncScenesV2(manager, copy, script, { rearm: true });
    const preparation = await service.materializePreparationV2(
      manager,
      copy,
      talkKit,
      script,
      scenes,
    );
    expect(preparation.steps).toHaveLength(3);
    expect(preparation.steps.every((s) => s.status === McStepStatus.SKIPPED_CACHED)).toBe(true);
    expect(preparation.steps.map((s) => s.outputAssetId)).toEqual(['au-0', 'au-1', 'au-2']);
    expect(preparation.items.every((i) => i.cached && i.credits === 0)).toBe(true);
    // produção: um talk pendente por fala — nada mais
    const production = await service.materializeProductionV2(manager, copy, script, scenes);
    expect(production.steps.map((s) => [s.type, s.status])).toEqual([
      [McStepType.TALK, McStepStatus.PENDING],
      [McStepType.TALK, McStepStatus.PENDING],
      [McStepType.TALK, McStepStatus.PENDING],
    ]);
    expect(production.steps[0].inputSnapshot).toMatchObject({
      engine: expect.objectContaining({ key: 'economico' }),
      audioAssetId: 'au-0',
    });
  });
});
