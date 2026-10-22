import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { ModerationProvider } from '../../../shared/providers/moderation.provider';
import { SystemSettingsService } from '../../../shared/settings/system-settings.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import { fixturePieceDocument } from '../domain/__fixtures__/mc-piece.fixtures';
import { syntheticAlignment } from '../domain/mc-captions';
import { buildMockScriptPiece } from '../domain/mc-director';
import {
  McPieceDocument,
  McPieceProductsBlock,
  pieceCanonicalHash,
  pieceSpokenOffers,
} from '../domain/mc-piece';
import { MC_PIPELINE_V2, McQualityState, resolveQuality } from '../domain/mc-quality';
import { McProjectStatus, McSceneStatus } from '../domain/mc-state-machines';
import { McScript } from '../domain/mc-types';
import { McCharacterKit, McKitStatus } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McMaterializerService } from './mc-materializer.service';
import { McPieceProjectService } from './mc-piece-project.service';
import { McPiecesService } from './mc-pieces.service';
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
  captionsRequested: false,
  captionsMissingSceneIds: [],
  seals: [],
  renderedAt: 'now',
};

/** Roteiro da peça como o step `script` grava (mock determinístico, ids estáveis). */
function pieceScript(document: McPieceDocument): McScript {
  let seq = 0;
  const character = document.blocks.find((b) => b.type === 'character')!;
  return buildMockScriptPiece(
    {
      offers: pieceSpokenOffers(document),
      storeName: 'Mercado Bom Preço',
      maxChunkS: 15,
      layoutPreset: 'character_left',
      captions: false,
      window: { ...character.rect },
      logoFace: false,
      talkBackgroundColor: '#FFE082',
      closingHint: 'até 16/04',
    },
    () => `sc-${++seq}`,
  );
}

/** Harness do McQualityService para um projeto `offer_piece` (mesmo desenho do spec F2). */
function harness(document: McPieceDocument = fixturePieceDocument()) {
  const script = pieceScript(document);
  const project: Row = {
    id: 'p1',
    userId,
    kitId: 'kit-1',
    status: McProjectStatus.STORYBOARD_REVIEW,
    pipelineVersion: MC_PIPELINE_V2,
    revision: 1,
    format: 'offer_piece',
    tier: 'economico',
    channel: 'instagram',
    layoutPreset: null,
    quality: resolveQuality(null),
    script,
    aspectRatio: '9:16',
    pieceId: 'piece-1',
    pieceSnapshot: document,
    logoBox: null,
    options: {
      musicEnabled: false,
      captionsEnabled: false,
      products: pieceSpokenOffers(document),
    },
    reservedCredits: 0,
    consumedCredits: 0,
    finalAssetId: null,
  };
  const kit: Row = {
    id: 'kit-1',
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
    audioAssetId: `au-${idx}`,
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
  const updates: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
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
    // update por {id, revision} do caminho "no lugar": aplica se a revisão bate
    update: jest.fn(
      (_entity: unknown, where: Record<string, unknown>, patch: Record<string, unknown>) => {
        updates.push(patch);
        const ok = where.revision === undefined || where.revision === project.revision;
        if (ok) Object.assign(project, patch);
        return Promise.resolve({ affected: ok ? 1 : 0 });
      },
    ),
  };
  const dataSource = {
    getRepository: jest.fn((entity: unknown) => ({
      findOneBy: jest.fn(() => {
        if (entity === McProject) return Promise.resolve(project);
        if (entity === McCharacterKit) return Promise.resolve(kit);
        return Promise.resolve(null);
      }),
      findOneByOrFail: jest.fn(() => Promise.resolve(project)),
      find: jest.fn((opts: { where: Record<string, unknown> }) => {
        if (entity === McScene) return Promise.resolve(scenes);
        const ids = (opts.where.id as { _value?: string[] })?._value ?? [];
        if (entity === AnimationAsset)
          return Promise.resolve(assets.filter((a) => ids.includes(a.id)));
        return Promise.resolve([]);
      }),
    })),
    transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager as unknown as EntityManager),
    ),
  };
  const moderate = jest.fn().mockResolvedValue({ flagged: false, categories: [] });
  const service = new McQualityService(
    dataSource as unknown as DataSource,
    {
      casTransition: jest.fn().mockResolvedValue(true),
      notify: jest.fn().mockResolvedValue(undefined),
    } as unknown as TaskTransitionService,
    { get: jest.fn().mockResolvedValue(null) } as unknown as SystemSettingsService,
    {
      reserve: jest.fn().mockResolvedValue(undefined),
      refundUnconsumed: jest.fn().mockResolvedValue(0),
    } as unknown as CreditsService,
    { moderate } as unknown as ModerationProvider,
    {
      appendEvent: jest.fn((_m: unknown, event: Record<string, unknown>) => {
        events.push(event);
        return Promise.resolve(undefined);
      }),
    } as unknown as CommercialsService,
    {
      ensureAssemblyStepV2: jest.fn().mockResolvedValue({ id: 'still' }),
    } as unknown as McMaterializerService,
    {
      enqueueReadySteps: jest.fn().mockResolvedValue([]),
      appendProjectTransition: jest.fn().mockResolvedValue(undefined),
      cancelIdleSteps: jest.fn().mockResolvedValue(0),
    } as unknown as McPipelineService,
    {
      deriveScript: jest.fn((s: McScript) => Promise.resolve({ script: s, translated: 0 })),
    } as unknown as McTranslationService,
  );
  const pieces = { issuesFor: jest.fn().mockResolvedValue([]) };
  const pieceProject = new McPieceProjectService(
    dataSource as unknown as DataSource,
    pieces as unknown as McPiecesService,
    service,
  );
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
    script,
    scenes,
    updates,
    events,
    moderate,
    service,
    pieces,
    pieceProject,
    deliver,
  };
}

const products = (doc: McPieceDocument) =>
  doc.blocks.find((b) => b.type === 'products') as McPieceProductsBlock;
const character = (doc: McPieceDocument) =>
  doc.blocks.find((b) => b.type === 'character') as Extract<
    McPieceDocument['blocks'][number],
    { type: 'character' }
  >;
const dialogues = (p: Row) => (p.script as McScript).scenes.map((s) => s.dialogue);
const sceneIds = (p: Row) => (p.script as McScript).scenes.map((s) => s.sceneId);

/** Tarefa 5.4 — `PATCH projects/:id/piece`: edição da peça depois do vídeo existir. */
describe('McPieceProjectService — edição falada (fala reescrita, revisão do roteiro)', () => {
  it('preço de um item FALADO depois da entrega → só a fala dele é reescrita, as outras cenas ficam (mesmos ids); storyboard_review, revisão 2, descritor e ofertas gravados', async () => {
    const h = harness();
    h.deliver();
    const beforeIds = sceneIds(h.project);
    const beforeDialogues = dialogues(h.project);
    const edited = fixturePieceDocument();
    products(edited).items[2].price = '19,90'; // Arroz: 24,90 → 19,90 (falado)
    const result = await h.pieceProject.updatePiece(userId, 'p1', {
      document: edited,
      expectedRevision: 1,
    });
    expect(result.pieceChange).toMatchObject({ scope: 'spoken', effect: 'recording' });
    expect(result.pieceChange.rewrittenLines).toEqual([
      {
        offerId: 'it-arroz',
        sceneId: beforeIds[2],
        previousDialogue: beforeDialogues[2],
        proposedDialogue: expect.stringContaining('dezenove reais e noventa centavos'),
      },
    ]);
    expect(h.project.status).toBe(McProjectStatus.STORYBOARD_REVIEW);
    expect(h.project.revision).toBe(2);
    expect(sceneIds(h.project)).toEqual(beforeIds); // identidades preservadas
    const after = dialogues(h.project);
    expect(after[0]).toBe(beforeDialogues[0]);
    expect(after[1]).toBe(beforeDialogues[1]);
    expect(after[2]).toContain('dezenove reais e noventa centavos');
    expect(after[3]).toBe(beforeDialogues[3]);
    expect(after[4]).toBe(beforeDialogues[4]);
    expect((h.project.script as McScript).offers?.map((o) => [o.id, o.price])).toEqual([
      ['it-picanha', '59,90'],
      ['it-arroz', '19,90'],
      ['it-refri', '7,99'],
    ]);
    expect(pieceCanonicalHash(h.project.pieceSnapshot as McPieceDocument)).toBe(
      pieceCanonicalHash(edited),
    );
    expect(
      (h.project.options as { products: Array<{ id: string; price: string }> }).products,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'it-arroz', price: '19,90' })]),
    );
    expect((h.project.quality as McQualityState).pendingScope).toBeNull();
    expect(h.moderate).toHaveBeenCalled();
  });

  it('falado entra e falado sai → cena nova (sceneId null na proposta) e a cena da oferta removida vai embora; abertura e fechamento ficam', async () => {
    const h = harness();
    const beforeIds = sceneIds(h.project);
    const edited = fixturePieceDocument();
    products(edited).items[1].spoken = true; // Cerveja passa a ser falada
    products(edited).items[3].spoken = false; // Refrigerante deixa de ser falado
    const result = await h.pieceProject.updatePiece(userId, 'p1', {
      document: edited,
      expectedRevision: 1,
    });
    expect(result.pieceChange.rewrittenLines).toEqual([
      {
        offerId: 'it-cerveja',
        sceneId: null,
        previousDialogue: null,
        proposedDialogue: expect.stringContaining('três reais e quarenta e nove centavos'),
      },
    ]);
    const script = h.project.script as McScript;
    expect(script.scenes).toHaveLength(5);
    expect(script.scenes[0].sceneId).toBe(beforeIds[0]);
    expect(script.scenes[4].sceneId).toBe(beforeIds[4]);
    expect(script.scenes.map((s) => s.productRef ?? null)).toEqual([
      null,
      'it-picanha',
      'it-cerveja',
      'it-arroz',
      null,
    ]);
    expect(script.scenes[1].sceneId).toBe(beforeIds[1]); // Picanha preservada
    expect(script.scenes[3].sceneId).toBe(beforeIds[2]); // Arroz preservado
    expect(beforeIds).not.toContain(script.scenes[2].sceneId); // Cerveja: cena nova
    expect(script.lines?.map((l) => l.kind)).toEqual([
      'opening',
      'offer',
      'offer',
      'offer',
      'closing',
    ]);
  });

  it('cor do painel ou modo do personagem mudam → regrava (caminho falado) mesmo sem fala nova: cor nova no roteiro, nenhuma fala reescrita', async () => {
    const h = harness();
    h.deliver();
    const edited = fixturePieceDocument({
      character: { panel: { shape: 'card', color: '#112233' } },
    });
    const result = await h.pieceProject.updatePiece(userId, 'p1', {
      document: edited,
      expectedRevision: 1,
    });
    expect(result.pieceChange).toEqual({
      scope: 'visual',
      effect: 'recording',
      rewrittenLines: [],
    });
    expect(h.project.status).toBe(McProjectStatus.STORYBOARD_REVIEW);
    expect((h.project.script as McScript).talkBackgroundColor).toBe('#112233');
    expect(dialogues(h.project)).toEqual(dialogues({ id: 'x', script: h.script }));
  });
});

describe('McPieceProjectService — edição só visual', () => {
  it('foto de um produto depois da entrega → revisão assembly_only (quadro + compose + finalize), roteiro igual, descritor novo', async () => {
    const h = harness();
    h.deliver();
    const edited = fixturePieceDocument();
    products(edited).items[1].imageUrl = '/uploads/gallery/outra.png';
    const result = await h.pieceProject.updatePiece(userId, 'p1', {
      document: edited,
      expectedRevision: 1,
    });
    expect(result.pieceChange).toEqual({
      scope: 'visual',
      effect: 'composition',
      rewrittenLines: [],
    });
    expect(h.project.status).toBe(McProjectStatus.VISUAL_REVIEW);
    expect(h.project.revision).toBe(2);
    expect((h.project.quality as McQualityState).pendingScope).toBe('assembly_only');
    expect(dialogues(h.project)).toEqual(dialogues({ id: 'x', script: h.script }));
    expect(pieceCanonicalHash(h.project.pieceSnapshot as McPieceDocument)).toBe(
      pieceCanonicalHash(edited),
    );
    expect(h.moderate).not.toHaveBeenCalled();
    // a aprovação da remontagem refaz só a cadeia (render_still → compose → finalize)
    await h.service.approveAssembly(userId, 'p1', 2);
    expect(h.project.status).toBe(McProjectStatus.ASSEMBLING);
  });

  it('mover o personagem depois da entrega → assembly_only com a janela nova no roteiro (modo rosto do logo também grava a caixa)', async () => {
    const h = harness();
    h.deliver();
    const edited = fixturePieceDocument({
      character: { rect: { x: 0.05, y: 0.6, w: 0.37, h: 0.28 } },
    });
    await h.pieceProject.updatePiece(userId, 'p1', { document: edited, expectedRevision: 1 });
    expect(h.project.status).toBe(McProjectStatus.VISUAL_REVIEW);
    expect((h.project.script as McScript).window).toEqual({ x: 0.05, y: 0.6, w: 0.37, h: 0.28 });
    expect(h.project.logoBox).toBeNull();
  });

  it('antes da entrega (storyboard em revisão) → gravado no lugar: sem revisão nova, sem troca de status, descritor/opções/janela atualizados, evento piece_updated', async () => {
    const h = harness();
    const edited = fixturePieceDocument({
      character: { rect: { x: 0.05, y: 0.6, w: 0.37, h: 0.28 } },
    });
    products(edited).items[0].imageUrl = '/uploads/gallery/picanha-2.png';
    const result = await h.pieceProject.updatePiece(userId, 'p1', {
      document: edited,
      expectedRevision: 1,
    });
    expect(result.pieceChange.effect).toBe('composition');
    expect(h.project.status).toBe(McProjectStatus.STORYBOARD_REVIEW);
    expect(h.project.revision).toBe(1);
    expect(h.project.pieceSnapshot).toEqual(edited);
    expect((h.project.script as McScript).window).toEqual({ x: 0.05, y: 0.6, w: 0.37, h: 0.28 });
    expect((h.project.script as McScript).version).toBe(h.script.version + 1);
    expect(h.updates.at(-1)).toMatchObject({ pieceSnapshot: edited, logoBox: null });
    expect(h.events.at(-1)).toMatchObject({ kind: 'piece_updated', detail: { scope: 'visual' } });
  });
});

describe('McPieceProjectService — recusas', () => {
  const edit = (h: ReturnType<typeof harness>, doc: McPieceDocument, revision = 1) =>
    h.pieceProject.updatePiece(userId, 'p1', { document: doc, expectedRevision: revision });

  it('nada mudou → 422 NO_PIECE_CHANGE; revisão errada → 409 REVISION_CONFLICT; peça com issues → 422 PIECE_INVALID', async () => {
    const h = harness();
    await expect(edit(h, fixturePieceDocument())).rejects.toMatchObject({
      response: { code: 'NO_PIECE_CHANGE' },
    });
    await expect(edit(h, fixturePieceDocument(), 3)).rejects.toMatchObject({
      status: 409,
      response: { code: 'REVISION_CONFLICT', revision: 1 },
    });
    h.pieces.issuesFor.mockResolvedValueOnce([{ code: 'PRODUCT_IMAGE_REQUIRED', message: 'x' }]);
    const edited = fixturePieceDocument();
    products(edited).items[0].imageUrl = '/uploads/gallery/x.png';
    await expect(edit(h, edited)).rejects.toMatchObject({
      response: {
        code: 'PIECE_INVALID',
        issues: [{ code: 'PRODUCT_IMAGE_REQUIRED', message: 'x' }],
      },
    });
  });

  it('formato (aspecto) ou kit diferentes → 422 (duplique o vídeo); projeto de outro formato → 422 FORMAT_NOT_OFFER_PIECE', async () => {
    const h = harness();
    await expect(edit(h, fixturePieceDocument({ aspectRatio: '4:5' }))).rejects.toMatchObject({
      response: { code: 'PIECE_ASPECT_MISMATCH' },
    });
    await expect(
      edit(h, fixturePieceDocument({ character: { kitId: 'kit-2' } })),
    ).rejects.toMatchObject({
      response: { code: 'PIECE_KIT_CHANGED' },
    });
    h.project.format = 'offer_carousel';
    await expect(edit(h, fixturePieceDocument())).rejects.toMatchObject({
      response: { code: 'FORMAT_NOT_OFFER_PIECE' },
    });
  });

  it('com produção em andamento (generating) a edição é recusada pelo estado do projeto', async () => {
    const h = harness();
    h.project.status = McProjectStatus.GENERATING;
    const edited = fixturePieceDocument();
    products(edited).items[1].imageUrl = '/uploads/gallery/outra.png';
    await expect(edit(h, edited)).rejects.toMatchObject({
      response: { code: 'PROJECT_STATE_INVALID' },
    });
  });
});

describe('McQualityService — campos de composição da peça', () => {
  it('cor do painel não é composição (está nos clipes): 422 COMPOSITION_FIELD_NOT_SUPPORTED; sem mudança e sem descritor novo → NO_COMPOSITION_CHANGE', async () => {
    const h = harness();
    h.deliver();
    await expect(
      h.service.updateComposition(userId, 'p1', {
        expectedRevision: 1,
        talkBackgroundColor: '#000000',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'COMPOSITION_FIELD_NOT_SUPPORTED',
        details: { fields: ['talkBackgroundColor'] },
      },
    });
    await expect(
      h.service.updateComposition(userId, 'p1', { expectedRevision: 1 }),
    ).rejects.toMatchObject({
      response: { code: 'NO_COMPOSITION_CHANGE' },
    });
    // mesmo roteiro, descritor novo → é composição (o compose leva o pieceHash)
    const edited = fixturePieceDocument();
    products(edited).items[1].imageUrl = '/uploads/gallery/outra.png';
    await h.service.updateComposition(
      userId,
      'p1',
      { expectedRevision: 1 },
      { pieceSnapshot: edited, logoBox: null },
    );
    expect(h.project.status).toBe(McProjectStatus.VISUAL_REVIEW);
    expect(h.project.pieceSnapshot).toEqual(edited);
    expect(character(h.project.pieceSnapshot as McPieceDocument).rect).toEqual(
      character(edited).rect,
    );
  });
});
