import { EntityManager } from 'typeorm';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { CommercialsService } from '../commercials.service';
import { fixtureCarouselScript } from '../domain/__fixtures__/mc-offer-carousel.fixtures';
import { fixtureTalkTileScript } from '../domain/__fixtures__/mc-script-v2.fixtures';
import { rewriteSpokenOfferLines } from '../domain/mc-director';
import { KLING_AVATAR_MODEL, mcUsdPerSecondForModel } from '../domain/mc-pipeline.config';
import { MC_PIPELINE_V2 } from '../domain/mc-quality';
import { normalizeOfferCarouselScript } from '../domain/mc-script-v2';
import { McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McScript, McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McMaterializerService } from './mc-materializer.service';

/** Manager em memória (igualdade rasa do `where`, In() do TypeORM; cache por hash real). */
function fakeManager(assets: Array<Record<string, unknown>>) {
  let seq = 0;
  const rows = new Map<unknown, Array<Record<string, unknown>>>();
  const table = (entity: unknown) => {
    if (!rows.has(entity)) rows.set(entity, []);
    return rows.get(entity)!;
  };
  rows.set(AnimationAsset, assets);
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && '_type' in (v as object)) {
        return ((v as { _value: unknown[] })._value ?? []).includes(row[k]);
      }
      return row[k] === v;
    });
  // findCachedOutput: step succeeded mais recente com o MESMO tipo e hash
  let cacheQuery: { type?: string; inputHash?: string } = {};
  const qb = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn((sql: string, params: Record<string, string>) => {
      if (params?.type) cacheQuery.type = params.type;
      if (params?.inputHash) cacheQuery.inputHash = params.inputHash;
      return qb;
    }),
    orderBy: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getOne: jest.fn(() => {
      const hit = table(McStep).find(
        (s) =>
          s.type === cacheQuery.type &&
          s.inputHash === cacheQuery.inputHash &&
          s.status === McStepStatus.SUCCEEDED &&
          s.outputAssetId,
      );
      cacheQuery = {};
      return Promise.resolve(hit ? { id: hit.id, outputAssetId: hit.outputAssetId } : null);
    }),
  };
  const manager = {
    create: jest.fn((_e: unknown, obj: Record<string, unknown>) => ({ ...obj })),
    save: jest.fn((obj: Record<string, unknown> & { id?: string }) => {
      if (!obj.id) obj.id = `id-${++seq}`;
      const entity = 'inputHash' in obj ? McStep : McScene;
      const list = table(entity);
      const i = list.findIndex((r) => r.id === obj.id);
      if (i >= 0) list[i] = obj;
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
    find: jest.fn((entity: unknown, options: { where: Record<string, unknown> }) =>
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
  };
  return manager as unknown as EntityManager & typeof manager;
}

const kit = {
  id: 'kit-1',
  userId: 'u1',
  version: 1,
  voiceId: 'voice-1',
  referenceAssetIds: [],
  cutoutAssetId: null,
  tileAssetId: 'tile-1',
  tileBackgroundColor: '#FFE082',
  identityMode: 'generated',
  source: 'mascot',
  style: '3d_render',
} as unknown as McCharacterKit;

function f2Project(script: McScript, over: Partial<McProject> = {}): McProject {
  return {
    id: 'proj-f2',
    userId: 'u1',
    kitId: 'kit-1',
    aspectRatio: '9:16',
    pipelineVersion: MC_PIPELINE_V2,
    revision: 1,
    tier: 'economico',
    format: 'offer_carousel',
    channel: 'instagram',
    layoutPreset: 'character_left',
    script,
    options: { musicEnabled: true, captionsEnabled: true, products: [] },
    ...over,
  } as unknown as McProject;
}

/** Áudio medido por fala: 3,5 s a 4,5 s (TTS com timestamps). */
const audioMs = (i: number) => 3500 + (i % 3) * 500;

describe('McMaterializerService — F2 ofertas em sequência (tarefas 6.5/6.7/6.8)', () => {
  const originalEco = process.env.MC_TALK_ENGINE_ECONOMICO;
  let service: McMaterializerService;

  beforeEach(() => {
    delete process.env.MC_TALK_ENGINE_ECONOMICO;
    service = new McMaterializerService({
      appendEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as CommercialsService);
  });
  afterEach(() => {
    if (originalEco === undefined) delete process.env.MC_TALK_ENGINE_ECONOMICO;
    else process.env.MC_TALK_ENGINE_ECONOMICO = originalEco;
  });

  async function produced(script: McScript) {
    const assets = [
      { id: 'tile-1', fileUrl: '/uploads/tile.png', width: 720, height: 960 },
      ...script.scenes.map((s, i) => ({
        id: `au-${i}`,
        fileUrl: `/uploads/au-${i}.mp3`,
        durationMs: audioMs(i),
      })),
    ];
    const manager = fakeManager(assets);
    manager.seed(McCharacterKit, [{ ...kit }]);
    const project = f2Project(script);
    const scenes = await service.syncScenesV2(manager, project, script, { rearm: true });
    scenes.forEach((scene, i) => Object.assign(scene, { audioAssetId: `au-${i}` }));
    return { manager, project, scenes, assets };
  }

  it('6 ofertas → 8 clipes `talk` (um por fala) e custo = tarifa do motor × segundos totais das falas', async () => {
    const script = fixtureCarouselScript(6);
    const { manager, project, scenes, assets } = await produced(script);
    const preparation = await service.materializePreparationV2(
      manager,
      project,
      kit,
      script,
      scenes,
    );
    expect(preparation.steps.map((s) => s.type)).toEqual(Array(8).fill(McStepType.TTS));
    const { steps } = await service.materializeProductionV2(manager, project, script, scenes);
    expect(steps.map((s) => s.type)).toEqual(Array(8).fill(McStepType.TALK));
    expect(new Set(steps.map((s) => s.sceneId)).size).toBe(8);
    // custo de fornecedor: o motor econômico cobra por SEGUNDO de saída (o clipe é
    // conformado ao áudio — D7), então a soma é a tarifa × os segundos das falas,
    // independente do número de ofertas.
    const tariff = mcUsdPerSecondForModel(KLING_AVATAR_MODEL) as number;
    const costs = steps.map((step) => {
      const snapshot = step.inputSnapshot as {
        engine: { model: string; usdPerSecond: number };
        audioAssetId: string;
      };
      expect(snapshot.engine.model).toBe(KLING_AVATAR_MODEL);
      const audio = assets.find((a) => a.id === snapshot.audioAssetId) as { durationMs: number };
      return (mcUsdPerSecondForModel(snapshot.engine.model) as number) * (audio.durationMs / 1000);
    });
    const totalSeconds = scenes.reduce((sum, _s, i) => sum + audioMs(i) / 1000, 0);
    expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(tariff * totalSeconds, 6);
    expect(tariff).toBe(0.0562);
  });

  it('ensureAssemblyStepV2 no F2: render_remotion → finalize (sceneId null, fase assembly, mesmo attempt) — nunca assembly/compose', async () => {
    const script = fixtureCarouselScript(4);
    const { manager, project, scenes } = await produced(script);
    scenes.forEach((s, i) =>
      Object.assign(s, { status: McSceneStatus.READY, finalAssetId: `clip-${i}` }),
    );
    const first = await service.ensureAssemblyStepV2(manager, project, script, scenes);
    expect(first.type).toBe(McStepType.RENDER_REMOTION);
    const chain = manager.steps().filter((s) => s.sceneId === null);
    expect(chain.map((s) => [s.type, s.status, s.phase, s.attempt])).toEqual([
      [McStepType.RENDER_REMOTION, McStepStatus.PENDING, 'assembly', 1],
      [McStepType.FINALIZE, McStepStatus.PENDING, 'assembly', 1],
    ]);
    expect(
      manager
        .steps()
        .some((s) => s.type === McStepType.ASSEMBLY || s.type === McStepType.COMPOSE_FFMPEG),
    ).toBe(false);
  });

  /** Hashes da cadeia de projeto + TTS base de cada fala, para comparar cenários de correção. */
  async function hashesFor(script: McScript, projectOver: Partial<McProject> = {}) {
    const { manager, scenes } = await produced(script);
    scenes.forEach((s) =>
      Object.assign(s, { status: McSceneStatus.READY, finalAssetId: `clip-${s.scriptSceneId}` }),
    );
    const project = f2Project(script, projectOver);
    await service.ensureAssemblyStepV2(manager, project, script, scenes);
    const chain = manager.steps().filter((s) => s.sceneId === null);
    const prep = await service.materializePreparationV2(manager, project, kit, script, scenes);
    return {
      render: chain.find((s) => s.type === McStepType.RENDER_REMOTION)!.inputHash,
      finalize: chain.find((s) => s.type === McStepType.FINALIZE)!.inputHash,
      tts: Object.fromEntries(
        prep.steps.map((s) => [
          scenes.find((sc) => sc.id === s.sceneId)!.scriptSceneId,
          (s.inputSnapshot as { baseHash: string }).baseHash,
        ]),
      ),
    };
  }

  it('trocar a FOTO (ou badge/unidade/preço anterior): só o render e o finalize mudam — nenhum TTS/clipe', async () => {
    const before = fixtureCarouselScript(4);
    const photo = normalizeOfferCarouselScript({
      ...before,
      offers: before.offers?.map((o, i) =>
        i === 2 ? { ...o, imageUrl: '/uploads/products/oleo-nova.png', badge: 'NOVO' } : o,
      ),
    });
    const a = await hashesFor(before);
    const b = await hashesFor(photo);
    expect(b.render).not.toBe(a.render);
    expect(b.finalize).not.toBe(a.finalize);
    expect(b.tts).toEqual(a.tts);
  });

  it('corrigir o PREÇO da oferta 3: a fala dela é reescrita e só o TTS dela muda de hash (as outras reaproveitam)', async () => {
    const before = fixtureCarouselScript(4);
    const priced = rewriteSpokenOfferLines(
      before,
      normalizeOfferCarouselScript({
        ...before,
        offers: before.offers?.map((o, i) => (i === 2 ? { ...o, price: '6,49' } : o)),
      }),
    );
    expect(priced.rewritten.map((r) => r.offerId)).toEqual(['of-oleo']);
    const a = await hashesFor(before);
    const b = await hashesFor(priced.script);
    const changed = Object.keys(a.tts).filter((id) => a.tts[id] !== b.tts[id]);
    expect(changed).toEqual([before.scenes[3].sceneId]);
    expect(b.render).not.toBe(a.render);
  });

  it('corrigir o PREÇO depois da entrega, ponta a ponta: na revisão nova só UM TTS e UM talk rodam; os demais vêm do cache', async () => {
    const before = fixtureCarouselScript(4);
    const { manager, project, scenes } = await produced(before);
    // entrega 1: TTS e talk concluídos para todas as falas
    const prep1 = await service.materializePreparationV2(manager, project, kit, before, scenes);
    prep1.steps.forEach((step, i) =>
      Object.assign(step, { status: McStepStatus.SUCCEEDED, outputAssetId: `au-${i}` }),
    );
    const prod1 = await service.materializeProductionV2(manager, project, before, scenes);
    prod1.steps.forEach((step, i) =>
      Object.assign(step, { status: McStepStatus.SUCCEEDED, outputAssetId: `clip-${i}` }),
    );

    // revisão 2: preço da oferta 3 corrigido → fala reescrita
    const priced = rewriteSpokenOfferLines(
      before,
      normalizeOfferCarouselScript({
        ...before,
        offers: before.offers?.map((o, i) => (i === 2 ? { ...o, price: '6,49' } : o)),
      }),
    ).script;
    const rev2 = f2Project(priced, { revision: 2 });
    const live = await service.syncScenesV2(manager, rev2, priced, { rearm: true });
    const prep2 = await service.materializePreparationV2(manager, rev2, kit, priced, live);
    const pendingTts = prep2.steps.filter((s) => s.status === McStepStatus.PENDING);
    expect(pendingTts).toHaveLength(1);
    expect(live.find((s) => s.id === pendingTts[0].sceneId)!.scriptSceneId).toBe(
      before.scenes[3].sceneId,
    );
    expect(prep2.steps.filter((s) => s.status === McStepStatus.SKIPPED_CACHED)).toHaveLength(5);
    // o TTS novo da fala 3 termina → produção
    const changed = live.find((s) => s.id === pendingTts[0].sceneId)!;
    changed.audioAssetId = 'au-novo';
    const prod2 = await service.materializeProductionV2(manager, rev2, priced, live);
    expect(
      prod2.steps.filter((s) => s.status === McStepStatus.PENDING).map((s) => s.sceneId),
    ).toEqual([changed.id]);
    expect(prod2.steps.filter((s) => s.status === McStepStatus.SKIPPED_CACHED)).toHaveLength(5);
  });

  it('BUG B — F1 entregue, editar UMA fala: na revisão nova só o TTS e o talk dela rodam (os demais vêm do cache)', async () => {
    const before = fixtureTalkTileScript();
    const assets = [
      { id: 'tile-1', fileUrl: '/uploads/tile.png', width: 720, height: 960 },
      ...before.scenes.map((_s, i) => ({
        id: `au-${i}`,
        fileUrl: `/uploads/au-${i}.mp3`,
        durationMs: 4000,
      })),
    ];
    const manager = fakeManager(assets);
    manager.seed(McCharacterKit, [{ ...kit }]);
    const project = f2Project(before, { format: 'talking_art' } as Partial<McProject>);
    const scenes = await service.syncScenesV2(manager, project, before, { rearm: true });
    scenes.forEach((scene, i) => Object.assign(scene, { audioAssetId: `au-${i}` }));
    const prep1 = await service.materializePreparationV2(manager, project, kit, before, scenes);
    prep1.steps.forEach((step, i) =>
      Object.assign(step, { status: McStepStatus.SUCCEEDED, outputAssetId: `au-${i}` }),
    );
    const prod1 = await service.materializeProductionV2(manager, project, before, scenes);
    prod1.steps.forEach((step, i) =>
      Object.assign(step, { status: McStepStatus.SUCCEEDED, outputAssetId: `clip-${i}` }),
    );
    const edited: McScript = {
      ...before,
      scenes: before.scenes.map((s, i) =>
        i === 1 ? { ...s, dialogue: 'Arroz em oferta hoje!' } : s,
      ),
    };
    const rev2 = { ...project, revision: 2, script: edited } as McProject;
    const live = await service.syncScenesV2(manager, rev2, edited, { rearm: true });
    const prep2 = await service.materializePreparationV2(manager, rev2, kit, edited, live);
    expect(prep2.steps.map((s) => s.status)).toEqual([
      McStepStatus.SKIPPED_CACHED,
      McStepStatus.PENDING,
      McStepStatus.SKIPPED_CACHED,
    ]);
    live[1].audioAssetId = 'au-novo';
    const prod2 = await service.materializeProductionV2(manager, rev2, edited, live);
    expect(prod2.steps.map((s) => s.status)).toEqual([
      McStepStatus.SKIPPED_CACHED,
      McStepStatus.PENDING,
      McStepStatus.SKIPPED_CACHED,
    ]);
  });

  it('REORDENAR ofertas: nenhum TTS muda (o mesmo áudio e clipe por fala) e o render é refeito na nova ordem', async () => {
    const before = fixtureCarouselScript(4);
    const [opening, a1, a2, a3, a4, closing] = before.scenes;
    const reordered = normalizeOfferCarouselScript({
      ...before,
      scenes: [opening, a3, a1, a2, a4, closing].map((s, idx) => ({ ...s, idx })),
    });
    const a = await hashesFor(before);
    const b = await hashesFor(reordered);
    expect(b.tts).toEqual(a.tts);
    expect(b.render).not.toBe(a.render);
  });

  it('trocar só a TRILHA refaz o finalize e reaproveita o render; preset de layout refaz o render', async () => {
    const script = fixtureCarouselScript(3);
    const base = await hashesFor(script);
    const noMusic = await hashesFor(script, {
      options: { musicEnabled: false, captionsEnabled: true, products: [] },
    } as Partial<McProject>);
    expect(noMusic.render).toBe(base.render);
    expect(noMusic.finalize).not.toBe(base.finalize);
    const bottom = await hashesFor({ ...script, layoutPreset: 'character_bottom' });
    expect(bottom.render).not.toBe(base.render);
  });
});
