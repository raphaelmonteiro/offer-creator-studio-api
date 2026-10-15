import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { ModerationProvider } from '../../../shared/providers/moderation.provider';
import { SystemSettingsService } from '../../../shared/settings/system-settings.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { Product } from '../../products/entities/product.entity';
import { CommercialsService } from '../commercials.service';
import { fixtureCarouselScript } from '../domain/__fixtures__/mc-offer-carousel.fixtures';
import { fixtureTalkTileScript } from '../domain/__fixtures__/mc-script-v2.fixtures';
import { syntheticAlignment } from '../domain/mc-captions';
import { MC_MUSIC_CREDITS } from '../domain/mc-pricing.config';
import { MC_PIPELINE_V2, McQualityState, resolveQuality } from '../domain/mc-quality';
import { McProjectStatus, McSceneStatus } from '../domain/mc-state-machines';
import { McScript, McStepType } from '../domain/mc-types';
import { UpdateScriptV2Dto } from '../dto/quality-v2.dto';
import { McCharacterKit, McKitStatus } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McMaterializerService } from './mc-materializer.service';
import { McOfferCarouselService } from './mc-offer-carousel.service';
import { McPipelineService } from './mc-pipeline.service';
import { McQualityService } from './mc-quality.service';
import { McTranslationService } from './mc-translation.service';

type Row = Record<string, unknown> & { id: string };

const userId = 'u1';
const DELIVERY_TIMELINE = {
  revision: 1,
  version: 1,
  totalS: 20,
  scenes: [],
  endcard: null,
  captionsRequested: true,
  captionsMissingSceneIds: [],
  seals: [],
  renderedAt: 'now',
};

/**
 * Harness do McQualityService (mesmo desenho de mc-quality.service.spec):
 * projeto/cenas/assets em memória, CAS de status+revisão no QueryBuilder,
 * materializer e pipeline mockados.
 */
/** Janela F1 no aspecto do tile 3:4 (324×432 px em 1080×1920), dentro da área segura. */
const F1_WINDOW = { x: 0.6, y: 0.4, w: 0.3, h: 0.225 };
const f1Script = (opts: Parameters<typeof fixtureTalkTileScript>[0] = {}): McScript => ({
  ...fixtureTalkTileScript(opts),
  window: { ...F1_WINDOW },
});

function harness(format: 'talking_art' | 'offer_carousel', script: McScript) {
  const project: Row = {
    id: 'p1',
    userId,
    kitId: 'k1',
    status: McProjectStatus.VISUAL_REVIEW,
    pipelineVersion: MC_PIPELINE_V2,
    revision: 1,
    format,
    tier: 'economico',
    channel: 'instagram',
    layoutPreset: format === 'offer_carousel' ? 'character_left' : null,
    quality: resolveQuality({
      preparation: {
        revision: 1,
        kitId: 'k1',
        kitVersion: 1,
        aspectRatio: '9:16',
        scenes: [],
        startedAt: 'now',
        completedAt: 'now',
        hash: 'manifest-f2',
      },
    }),
    script,
    aspectRatio: '9:16',
    options: { musicEnabled: true, captionsEnabled: true, products: [] },
    reservedCredits: 0,
    consumedCredits: 0,
    finalAssetId: null,
  };
  const kit: Row = {
    id: 'k1',
    userId,
    status: McKitStatus.APPROVED,
    version: 1,
    voiceId: 'v1',
    referenceAssetIds: [],
    tileAssetId: 'tile-1',
    identityMode: 'generated',
  };
  const scenes: Row[] = script.scenes.map((s, idx) => ({
    id: `row-${idx}`,
    projectId: 'p1',
    idx,
    scriptSceneId: s.sceneId,
    sceneType: 'talk_tile',
    generation: 1,
    status: McSceneStatus.PENDING,
    dialogue: s.dialogue,
    durationS: s.durationS,
    keyframeAssetId: null,
    audioAssetId: `au-${idx}`,
    videoAssetId: null,
    finalAssetId: null,
    rerollCount: 0,
  }));
  const assets: Row[] = script.scenes.map((s, idx) => ({
    id: `au-${idx}`,
    userId,
    fileUrl: `/uploads/au-${idx}.mp3`,
    durationMs: 3500,
    metadata: { alignment: syntheticAlignment(s.dialogue as string, 3.5) },
  }));
  assets.push({ id: 'tile-1', userId, fileUrl: '/uploads/tile.png', width: 720, height: 960 });
  const products: Row[] = [];
  const updates: Array<{ where: unknown; set: unknown }> = [];
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
  const manager = {
    createQueryBuilder: jest.fn(() => qb),
    findOneByOrFail: jest.fn((entity: unknown) =>
      entity === McProject ? Promise.resolve(project) : Promise.resolve(kit),
    ),
    find: jest.fn((entity: unknown) => {
      if (entity === McScene) return Promise.resolve(scenes);
      if (entity === McStep) return Promise.resolve([]);
      if (entity === AnimationAsset) return Promise.resolve(assets);
      return Promise.resolve([]);
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const dataSource = {
    getRepository: jest.fn((entity: unknown) => ({
      findOneBy: jest.fn((where: Record<string, unknown>) => {
        if (entity === McProject) return Promise.resolve(project);
        if (entity === McCharacterKit) return Promise.resolve(kit);
        if (entity === McScene)
          return Promise.resolve(
            scenes.find((s) => s.scriptSceneId === where.scriptSceneId) ?? null,
          );
        if (entity === AnimationAsset)
          return Promise.resolve(assets.find((a) => a.id === where.id) ?? null);
        return Promise.resolve(null);
      }),
      findOne: jest.fn((opts: { where: { id: string } }) =>
        Promise.resolve(
          entity === Product ? (products.find((p) => p.id === opts.where.id) ?? null) : null,
        ),
      ),
      findOneByOrFail: jest.fn(() => Promise.resolve(project)),
      find: jest.fn((opts: { where: Record<string, unknown> }) => {
        if (entity === McScene) return Promise.resolve(scenes);
        const ids = (opts.where.id as { _value?: string[] })?._value ?? [];
        if (entity === AnimationAsset)
          return Promise.resolve(assets.filter((a) => ids.includes(a.id)));
        if (entity === Product) return Promise.resolve(products.filter((p) => ids.includes(p.id)));
        return Promise.resolve([]);
      }),
    })),
    transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager as unknown as EntityManager),
    ),
  };
  const credits = {
    reserve: jest.fn().mockResolvedValue(undefined),
    refundUnconsumed: jest.fn().mockResolvedValue(0),
  };
  const materializer = {
    syncScenesV2: jest.fn().mockImplementation(() => Promise.resolve(scenes)),
    materializePreparationV2: jest.fn().mockResolvedValue({ steps: [], items: [] }),
    materializeProductionV2: jest.fn().mockResolvedValue({
      steps: [],
      items: scenes.map((s) => ({
        sceneId: s.scriptSceneId,
        stepType: McStepType.TALK,
        attempt: 1,
        credits: 56,
        cached: false,
      })),
    }),
    ensureAssemblyStepV2: jest.fn().mockResolvedValue({ id: 'render' }),
    buildPreparationManifest: jest.fn(),
  };
  const pipeline = {
    enqueueReadySteps: jest.fn().mockResolvedValue([]),
    appendProjectTransition: jest.fn().mockResolvedValue(undefined),
    cancelIdleSteps: jest.fn().mockResolvedValue(0),
  };
  const moderate = jest.fn().mockResolvedValue({ flagged: false, categories: [] });
  const service = new McQualityService(
    dataSource as unknown as DataSource,
    {
      casTransition: jest.fn().mockResolvedValue(true),
      notify: jest.fn().mockResolvedValue(undefined),
    } as unknown as TaskTransitionService,
    { get: jest.fn().mockResolvedValue(null) } as unknown as SystemSettingsService,
    credits as unknown as CreditsService,
    { moderate } as unknown as ModerationProvider,
    { appendEvent: jest.fn().mockResolvedValue(undefined) } as unknown as CommercialsService,
    materializer as unknown as McMaterializerService,
    pipeline as unknown as McPipelineService,
    {
      deriveScript: jest.fn((s: McScript) => Promise.resolve({ script: s, translated: 0 })),
    } as unknown as McTranslationService,
  );
  const offers = new McOfferCarouselService(dataSource as unknown as DataSource, service);
  const deliver = () => {
    project.status = McProjectStatus.SUCCEEDED;
    project.finalAssetId = 'final-v1';
    project.quality = resolveQuality({ timeline: DELIVERY_TIMELINE });
    scenes.forEach((s, i) =>
      Object.assign(s, { status: McSceneStatus.READY, finalAssetId: `clip-${i}` }),
    );
  };
  return {
    project,
    kit,
    scenes,
    assets,
    products,
    updates,
    credits,
    materializer,
    moderate,
    service,
    offers,
    deliver,
  };
}

const dtoFrom = (script: McScript, expectedRevision: number): UpdateScriptV2Dto => ({
  expectedRevision,
  scenes: script.scenes.map((s) => ({
    sceneId: s.sceneId,
    sceneType: s.sceneType!,
    actionPrompt: s.actionPrompt,
    dialogue: s.dialogue,
    durationS: s.durationS,
    productRef: s.productRef ?? null,
  })),
});

describe('F2 — bloqueios da revisão visual (tarefa 6.7)', () => {
  const approve = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) =>
    h.service.approveProduction(userId, 'p1', {
      expectedRevision: 1,
      manifestHash: 'manifest-f2',
      ...extra,
    });

  it('6 ofertas, 8 falas com timestamps somando 28 s → aprova; cotação = 8 talk + render_remotion + finalize', async () => {
    const h = harness('offer_carousel', fixtureCarouselScript(6));
    await approve(h);
    expect(h.project.status).toBe(McProjectStatus.GENERATING);
    const budget = (h.project.quality as McQualityState).budgets.find(
      (b) => b.phase === 'production',
    );
    expect(budget?.items.filter((i) => i.stepType === McStepType.TALK)).toHaveLength(8);
    expect(budget?.items.filter((i) => i.sceneId === null).map((i) => i.stepType)).toEqual([
      McStepType.RENDER_REMOTION,
      McStepType.FINALIZE,
    ]);
    expect(h.materializer.ensureAssemblyStepV2).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ format: 'offer_carousel' }),
      expect.anything(),
      expect.anything(),
    );
  });

  describe('trilha escolhida na aprovação (achado 5 da 3.7)', () => {
    const finalizeCredits = (h: ReturnType<typeof harness>) =>
      (h.project.quality as McQualityState).budgets
        .find((b) => b.phase === 'production')
        ?.items.find((i) => i.stepType === McStepType.FINALIZE)?.credits;

    it.each([
      ['offer_carousel', () => fixtureCarouselScript(4)],
      ['talking_art', () => f1Script()],
    ] as const)(
      '%s: musicEnabled=false grava a opção antes de materializar e tira a trilha da cotação',
      async (format, script) => {
        const h = harness(format, script());
        await approve(h, { musicEnabled: false, acceptSpeechDuration: true });
        expect(h.project.status).toBe(McProjectStatus.GENERATING);
        expect((h.project.options as { musicEnabled: boolean }).musicEnabled).toBe(false);
        expect(finalizeCredits(h)).toBe(0);
        expect(h.materializer.ensureAssemblyStepV2).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ options: expect.objectContaining({ musicEnabled: false }) }),
          expect.anything(),
          expect.anything(),
        );
      },
    );

    it('musicEnabled=true soma a trilha no finalize; omitido mantém a opção do projeto', async () => {
      const on = harness('offer_carousel', fixtureCarouselScript(4));
      on.project.options = { musicEnabled: false, captionsEnabled: true, products: [] };
      await approve(on, { musicEnabled: true });
      expect((on.project.options as { musicEnabled: boolean }).musicEnabled).toBe(true);
      expect(finalizeCredits(on)).toBe(MC_MUSIC_CREDITS);

      const kept = harness('offer_carousel', fixtureCarouselScript(4));
      kept.project.options = { musicEnabled: false, captionsEnabled: true, products: [] };
      await approve(kept);
      expect((kept.project.options as { musicEnabled: boolean }).musicEnabled).toBe(false);
      expect(finalizeCredits(kept)).toBe(0);
    });
  });

  it('falas somando 34 s → 422 SPEECH_OVER_LENGTH com a duração por fala; NÃO há aceite (nem acceptSpeechDuration)', async () => {
    const h = harness('offer_carousel', fixtureCarouselScript(6));
    h.assets.filter((a) => a.id.startsWith('au-')).forEach((a) => (a.durationMs = 4250)); // 8 × 4,25 = 34 s
    const err = await approve(h, { acceptSpeechDuration: true, acceptMissingCaptions: true }).catch(
      (e) => e,
    );
    expect(err.status).toBe(422);
    expect(err.response).toMatchObject({
      code: 'SPEECH_OVER_LENGTH',
      details: {
        totalS: 34,
        maxS: 30,
        actions: ['shorten_speech', 'remove_offer'],
        scenes: expect.arrayContaining([expect.objectContaining({ measuredS: 4.25 })]),
      },
    });
    expect(err.response.details.scenes).toHaveLength(8);
    expect(h.project.status).toBe(McProjectStatus.VISUAL_REVIEW);
    expect(h.credits.reserve).not.toHaveBeenCalled();
    expect((h.project.quality as McQualityState).speechDurationAccepted).toBe(false);
  });

  it('fala sem timestamps → 422 SPEECH_ALIGNMENT_MISSING (única ação: refazer o TTS); aceite de legendas NÃO libera', async () => {
    const h = harness('offer_carousel', fixtureCarouselScript(4));
    h.assets[2].metadata = {}; // TTS sem alinhamento na fala da oferta 2
    const err = await approve(h, { acceptMissingCaptions: true }).catch((e) => e);
    expect(err.response).toMatchObject({
      code: 'SPEECH_ALIGNMENT_MISSING',
      details: { sceneId: h.scenes[2].scriptSceneId, actions: ['regenerate_tts'] },
    });
    expect(err.response.issues.map((i: { code: string }) => i.code)).not.toContain(
      'CAPTIONS_ALIGNMENT_MISSING',
    );
    expect(h.project.status).toBe(McProjectStatus.VISUAL_REVIEW);
    // alinhamento vazio (sem palavras) também bloqueia
    h.assets[2].metadata = {
      alignment: {
        characters: [],
        character_start_times_seconds: [],
        character_end_times_seconds: [],
      },
    };
    await expect(approve(h)).rejects.toMatchObject({
      response: { code: 'SPEECH_ALIGNMENT_MISSING' },
    });
  });

  it('fala acima do limite do motor (18 s/15 s) continua bloqueando com SPEECH_SENTENCE_TOO_LONG', async () => {
    const h = harness('offer_carousel', fixtureCarouselScript(3));
    h.assets[1].durationMs = 18_000;
    await expect(approve(h)).rejects.toMatchObject({
      response: { code: 'SPEECH_SENTENCE_TOO_LONG' },
    });
  });
});

describe('BUG A — PATCH composition format-aware', () => {
  it('F1 entregue: janela, legendas e cartela são composição (assembly_only: compose + finalize); a cor do fundo do tile não', async () => {
    const h = harness('talking_art', f1Script());
    h.deliver();
    await h.service.updateComposition(userId, 'p1', {
      expectedRevision: 1,
      window: { x: 0.55, y: 0.4, w: 0.3, h: 0.225 },
      captionsEnabled: false,
      endcard: { storeName: 'Loja Nova' },
    });
    expect(h.project.status).toBe(McProjectStatus.VISUAL_REVIEW);
    expect(h.project.revision).toBe(2);
    expect((h.project.quality as McQualityState).pendingScope).toBe('assembly_only');
    expect(h.project.script).toMatchObject({
      format: 'talking_art',
      window: { x: 0.55, y: 0.4, w: 0.3, h: 0.225 },
      endcard: { storeName: 'Loja Nova' },
    });
    expect((h.project.options as { captionsEnabled: boolean }).captionsEnabled).toBe(false);
    // a aprovação de montagem refaz só a cadeia do formato
    await h.service.approveAssembly(userId, 'p1', 2);
    expect(h.project.status).toBe(McProjectStatus.ASSEMBLING);
    expect(h.materializer.materializeProductionV2).not.toHaveBeenCalled();
    expect(h.materializer.materializePreparationV2).not.toHaveBeenCalled();
  });

  it('F1 entregue: trocar a cor do fundo do tile só remontando é recusado (a cor está gravada nos clipes)', async () => {
    const h = harness('talking_art', f1Script());
    h.deliver();
    await expect(
      h.service.updateComposition(userId, 'p1', {
        expectedRevision: 1,
        talkBackgroundColor: '#ABCDEF',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'COMPOSITION_FIELD_NOT_SUPPORTED',
        details: { fields: ['talkBackgroundColor'] },
      },
    });
  });

  it('F1: janela fora da área segura → 422 SCRIPT_INVALID apontando a janela; campos de outro formato → 422 COMPOSITION_FIELD_NOT_SUPPORTED', async () => {
    const h = harness('talking_art', f1Script());
    h.deliver();
    await expect(
      h.service.updateComposition(userId, 'p1', {
        expectedRevision: 1,
        window: { x: 0.6, y: 0.6, w: 0.3, h: 0.225 }, // fundo em 1584 px > 1248
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'SCRIPT_INVALID',
        issues: expect.arrayContaining([expect.objectContaining({ element: 'character_window' })]),
      },
    });
    await expect(
      h.service.updateComposition(userId, 'p1', {
        expectedRevision: 1,
        layoutPreset: 'character_left',
        products: [{ name: 'x', price: '1,00' }],
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'COMPOSITION_FIELD_NOT_SUPPORTED',
        details: { format: 'talking_art', fields: ['products', 'layoutPreset'] },
      },
    });
  });

  it('F2 entregue: preset de layout, legendas e foto/badge/unidade/preço anterior → assembly_only (render + finalize)', async () => {
    const h = harness('offer_carousel', fixtureCarouselScript(4));
    h.deliver();
    await h.service.updateComposition(userId, 'p1', {
      expectedRevision: 1,
      layoutPreset: 'character_bottom',
      captionsEnabled: false,
      offers: [
        {
          id: 'of-cafe',
          imageUrl: '/uploads/products/cafe-novo.png',
          badge: null,
          originalPrice: '19,99',
        },
        { id: 'of-oleo', unit: 'cx', name: 'Óleo de Soja 900 ml', price: '7,99' }, // nome/preço iguais: ok
      ],
    });
    const script = h.project.script as McScript;
    expect((h.project.quality as McQualityState).pendingScope).toBe('assembly_only');
    expect(h.project.layoutPreset).toBe('character_bottom');
    expect(script.layoutPreset).toBe('character_bottom');
    expect(script.captions).toBe(false);
    expect(script.offers?.find((o) => o.id === 'of-cafe')).toMatchObject({
      imageUrl: '/uploads/products/cafe-novo.png',
      badge: null,
      originalPrice: '19,99',
      catalogId: '6f1c2a3e-8b4d-4c5e-9f60-1a2b3c4d5e6f', // preservado
    });
    expect(script.offers?.find((o) => o.id === 'of-oleo')?.unit).toBe('cx');
    expect(script.products).toEqual(script.offers);
    // falas intactas
    expect(script.scenes.map((s) => s.dialogue)).toEqual(
      fixtureCarouselScript(4).scenes.map((s) => s.dialogue),
    );
  });

  it('F2: nome ou preço ATUAL na composição → 422 OFFER_SPOKEN_FIELDS_CHANGED (ação update_offer); oferta desconhecida → 422', async () => {
    const h = harness('offer_carousel', fixtureCarouselScript(4));
    h.deliver();
    await expect(
      h.service.updateComposition(userId, 'p1', {
        expectedRevision: 1,
        offers: [{ id: 'of-arroz', price: '21,90' }],
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'OFFER_SPOKEN_FIELDS_CHANGED',
        details: { offerId: 'of-arroz', fields: ['price'], actions: ['update_offer'] },
      },
    });
    await expect(
      h.service.updateComposition(userId, 'p1', { expectedRevision: 1, offers: [{ id: 'nope' }] }),
    ).rejects.toMatchObject({ response: { code: 'OFFER_NOT_FOUND' } });
    await expect(
      h.service.updateComposition(userId, 'p1', {
        expectedRevision: 1,
        window: { x: 0, y: 0, w: 0.1, h: 0.1 },
      }),
    ).rejects.toMatchObject({ response: { code: 'COMPOSITION_FIELD_NOT_SUPPORTED' } });
  });

  it('F2: reordenar ofertas (offerOrder) reordena falas e ofertas sem TTS/clipe novos; ordem inválida → 422 ORDER_INVALID', async () => {
    const original = fixtureCarouselScript(4);
    const h = harness('offer_carousel', original);
    h.deliver();
    await expect(
      h.service.updateComposition(userId, 'p1', {
        expectedRevision: 1,
        offerOrder: ['of-oleo', 'of-arroz'],
      }),
    ).rejects.toMatchObject({ response: { code: 'ORDER_INVALID' } });
    await h.service.updateComposition(userId, 'p1', {
      expectedRevision: 1,
      offerOrder: ['of-oleo', 'of-arroz', 'of-cafe', 'of-leite'],
    });
    const script = h.project.script as McScript;
    expect(script.offers?.map((o) => o.id)).toEqual(['of-oleo', 'of-arroz', 'of-cafe', 'of-leite']);
    expect(script.lines?.map((l) => l.offerRef)).toEqual([
      null,
      'of-oleo',
      'of-arroz',
      'of-cafe',
      'of-leite',
      null,
    ]);
    expect(script.scenes[1].sceneId).toBe(original.scenes[3].sceneId);
    expect(script.scenes[1].dialogue).toBe(original.scenes[3].dialogue);
    expect((h.project.quality as McQualityState).pendingScope).toBe('assembly_only');
    await h.service.approveAssembly(userId, 'p1', 2);
    expect(h.materializer.materializePreparationV2).not.toHaveBeenCalled();
    expect(h.materializer.materializeProductionV2).not.toHaveBeenCalled();
  });
});

describe('BUG B — updateScript preserva os campos do produto e "salvar sem mudança" é no-op', () => {
  function f1WithOffers(): McScript {
    return f1Script({
      products: [
        {
          id: 'prod-arroz',
          catalogId: '0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d',
          name: 'Arroz integral 5 kg',
          price: '24,90',
          originalPrice: '29,90',
          unit: 'un',
          badge: 'OFERTA',
          imageUrl: '/uploads/products/arroz.png',
        },
      ],
    });
  }

  it('F1 entregue, salvar o MESMO roteiro (DTO sem originalPrice/badge/catálogo) → no-op: sem revisão nova, sem CAS, sem moderação', async () => {
    const script = f1WithOffers();
    const h = harness('talking_art', script);
    h.deliver();
    const dto = {
      ...dtoFrom(script, 1),
      products: [{ id: 'prod-arroz', name: 'Arroz integral 5 kg', price: '24,90' }],
    };
    const result = await h.service.updateScript(userId, 'p1', dto);
    expect(result).toBe(h.project);
    expect(h.project.revision).toBe(1);
    expect(h.project.status).toBe(McProjectStatus.SUCCEEDED);
    expect(h.updates).toHaveLength(0);
    expect(h.moderate).not.toHaveBeenCalled();
  });

  it('F1 entregue, editar SÓ uma fala → storyboard_review (não assembly_only), produto com todos os campos e falas do tile sem selo', async () => {
    const script = f1WithOffers();
    const h = harness('talking_art', script);
    h.deliver();
    const edited = {
      ...script,
      scenes: script.scenes.map((s, i) =>
        i === 2 ? { ...s, dialogue: 'Vem pra cá agora mesmo!' } : s,
      ),
    };
    await h.service.updateScript(userId, 'p1', {
      ...dtoFrom(edited, 1),
      products: [{ id: 'prod-arroz', name: 'Arroz integral 5 kg', price: '24,90' }],
    });
    expect(h.project.status).toBe(McProjectStatus.STORYBOARD_REVIEW);
    expect(h.project.revision).toBe(2);
    expect((h.project.quality as McQualityState).pendingScope).toBeNull();
    const saved = h.project.script as McScript;
    expect(saved.products?.[0]).toEqual({
      id: 'prod-arroz',
      catalogId: '0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d',
      name: 'Arroz integral 5 kg',
      price: '24,90',
      originalPrice: '29,90',
      unit: 'un',
      badge: 'OFERTA',
      imageUrl: '/uploads/products/arroz.png',
    });
    expect(saved.scenes.every((s) => s.sealCue === null && s.safeArea === null)).toBe(true);
    // só a fala 3 mudou: as outras mantêm o texto (TTS/clipe reaproveitados por hash na preparação)
    expect(saved.scenes.map((s) => s.dialogue)).toEqual(edited.scenes.map((s) => s.dialogue));
  });

  it('F2 antes da entrega: mudar o preço pelo roteiro sem mexer na fala → a fala da oferta é reescrita (proposta) e volta ao roteiro', async () => {
    const script = fixtureCarouselScript(3);
    const h = harness('offer_carousel', script);
    h.project.status = McProjectStatus.STORYBOARD_REVIEW;
    await h.service.updateScript(userId, 'p1', {
      ...dtoFrom(script, 1),
      offers: (script.offers ?? []).map((o) => (o.id === 'of-cafe' ? { ...o, price: '13,99' } : o)),
    });
    const saved = h.project.script as McScript;
    expect(saved.scenes[2].dialogue).toBe(
      'Café Torrado e Moído por treze reais e noventa e nove centavos!',
    );
    expect(saved.scenes.filter((s, i) => s.dialogue !== script.scenes[i].dialogue)).toHaveLength(1);
    expect(saved.offers?.find((o) => o.id === 'of-cafe')).toMatchObject({
      price: '13,99',
      badge: '-18%',
    });
  });
});

describe('correção por tipo de mudança e catálogo (tarefa 6.8)', () => {
  it('trocar a FOTO da oferta 3 depois da entrega → só composição (assembly_only); nenhuma fala muda', async () => {
    const script = fixtureCarouselScript(4);
    const h = harness('offer_carousel', script);
    h.deliver();
    const result = (await h.offers.updateOffer(userId, 'p1', 'of-oleo', {
      expectedRevision: 1,
      imageUrl: '/uploads/products/oleo-nova.png',
    })) as McProject & { offerLineProposal: { scope: string } };
    expect(result.offerLineProposal).toMatchObject({ scope: 'composition', changed: ['imageUrl'] });
    expect((h.project.quality as McQualityState).pendingScope).toBe('assembly_only');
    expect((h.project.script as McScript).scenes.map((s) => s.dialogue)).toEqual(
      script.scenes.map((s) => s.dialogue),
    );
  });

  it('corrigir o PREÇO da oferta 3 → fala reescrita mostrada para confirmação (dryRun não grava); aplicar volta ao roteiro só com a fala dela nova', async () => {
    const script = fixtureCarouselScript(4);
    const h = harness('offer_carousel', script);
    h.deliver();
    const proposal = await h.offers.updateOffer(userId, 'p1', 'of-oleo', {
      expectedRevision: 1,
      price: '6,49',
      dryRun: true,
    });
    expect(proposal).toEqual({
      offerId: 'of-oleo',
      sceneId: script.scenes[3].sceneId,
      previousDialogue: script.scenes[3].dialogue,
      proposedDialogue: 'Óleo de Soja por seis reais e quarenta e nove centavos a unidade!',
      scope: 'speech',
      changed: ['price'],
    });
    expect(h.project.revision).toBe(1);
    const applied = (await h.offers.updateOffer(userId, 'p1', 'of-oleo', {
      expectedRevision: 1,
      price: '6,49',
    })) as McProject;
    expect(applied.status).toBe(McProjectStatus.STORYBOARD_REVIEW);
    const saved = h.project.script as McScript;
    expect(saved.offers?.find((o) => o.id === 'of-oleo')?.price).toBe('6,49');
    expect(saved.scenes.map((s) => s.dialogue)).toEqual(
      script.scenes.map((s, i) =>
        i === 3 ? 'Óleo de Soja por seis reais e quarenta e nove centavos a unidade!' : s.dialogue,
      ),
    );
    // a fala confirmada/editada pelo usuário prevalece sobre a proposta
    h.project.status = McProjectStatus.STORYBOARD_REVIEW;
    await h.offers.updateOffer(userId, 'p1', 'of-oleo', {
      expectedRevision: 2,
      dialogue: 'Óleo de soja baratinho, seis e quarenta e nove!',
    });
    expect((h.project.script as McScript).scenes[3].dialogue).toBe(
      'Óleo de soja baratinho, seis e quarenta e nove!',
    );
  });

  it('nada mudou → 422 NO_OFFER_CHANGE; projeto de outro formato → 422 FORMAT_NOT_OFFER_CAROUSEL; oferta desconhecida → 404', async () => {
    const h = harness('offer_carousel', fixtureCarouselScript(3));
    await expect(
      h.offers.updateOffer(userId, 'p1', 'of-arroz', { expectedRevision: 1, price: '24,9' }),
    ).rejects.toMatchObject({ response: { code: 'NO_OFFER_CHANGE' } });
    await expect(
      h.offers.updateOffer(userId, 'p1', 'nope', { expectedRevision: 1, price: '1,00' }),
    ).rejects.toMatchObject({ status: 404 });
    const f1 = harness('talking_art', f1Script());
    await expect(
      f1.offers.updateOffer(userId, 'p1', 'x', { expectedRevision: 1, price: '1,00' }),
    ).rejects.toMatchObject({ response: { code: 'FORMAT_NOT_OFFER_CAROUSEL' } });
  });

  it('catálogo alterado: GET expõe offersCatalogChanged [{offerId, catalogPrice}] e "atualizar oferta" aplica o preço (= troca de preço)', async () => {
    const script = fixtureCarouselScript(4);
    const h = harness('offer_carousel', script);
    h.deliver();
    h.products.push(
      { id: '0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d', price: '22.90' }, // arroz mudou
      { id: '6f1c2a3e-8b4d-4c5e-9f60-1a2b3c4d5e6f', price: '15.49' }, // café igual
    );
    const changes = await h.offers.catalogChanges(h.project as unknown as McProject);
    expect(changes).toEqual([
      {
        offerId: 'of-arroz',
        catalogId: '0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d',
        frozenPrice: '24,90',
        catalogPrice: '22,90',
      },
    ]);
    // o vídeo mantém o preço congelado até a ação
    expect((h.project.script as McScript).offers?.[0].price).toBe('24,90');
    const refreshed = (await h.offers.refreshOfferFromCatalog(
      userId,
      'p1',
      'of-arroz',
      1,
    )) as McProject & {
      offerLineProposal: { proposedDialogue: string };
    };
    expect(refreshed.offerLineProposal.proposedDialogue).toBe(
      'Arroz Branco Tipo 1 por vinte e dois reais e noventa centavos!',
    );
    expect(h.project.status).toBe(McProjectStatus.STORYBOARD_REVIEW);
    expect((h.project.script as McScript).offers?.[0].price).toBe('22,90');
    // depois de atualizar, nada mais a avisar; preço igual → 422 CATALOG_PRICE_UNCHANGED
    expect(await h.offers.catalogChanges(h.project as unknown as McProject)).toEqual([]);
    h.project.status = McProjectStatus.STORYBOARD_REVIEW;
    await expect(
      h.offers.refreshOfferFromCatalog(userId, 'p1', 'of-cafe', 2),
    ).rejects.toMatchObject({
      response: { code: 'CATALOG_PRICE_UNCHANGED' },
    });
    await expect(
      h.offers.refreshOfferFromCatalog(userId, 'p1', 'of-oleo', 2),
    ).rejects.toMatchObject({
      response: { code: 'OFFER_WITHOUT_CATALOG' },
    });
  });
});
