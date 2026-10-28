import { CommercialsService } from '../commercials.service';
import { fixtureTalkTileScript } from '../domain/__fixtures__/mc-script-v2.fixtures';
import { MC_PIPELINE_V2 } from '../domain/mc-quality';
import { McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { computeTalkHashV2 } from '../domain/mc-step-hashes';
import { MC_STEP_CREDITS } from '../domain/mc-pricing.config';
import { TALK_PROMPT_SUFFIX } from '../domain/mc-talk-prompts';
import { McScript, McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';
import { fakeManager } from './mc-fake-manager.fixture';
import { McMaterializerService } from './mc-materializer.service';
import { quoteTalkChunks } from './mc-talk-chunk-materializer';
import { readChunkSnapshot } from '../domain/mc-talk-chunk-step';

/**
 * Materialização do `talk` por TRECHO (change video-fala-continua, 1.4): um step por trecho ancorado na
 * cena líder, hash encadeado pela junção, cotação por trecho e cache que religa as fatias.
 */
const TALK_CREDITS = MC_STEP_CREDITS[McStepType.TALK];

const kit = {
  id: 'kit-1',
  userId: 'u1',
  version: 1,
  voiceId: 'voice-1',
  tileAssetId: 'tile-1',
  tileBackgroundColor: '#112233',
  identityMode: 'generated',
  source: 'mascot',
  style: '3d_render',
} as unknown as McCharacterKit;
const tile = { id: 'tile-1', fileUrl: '/uploads/tile.png', width: 720, height: 960 };

function scriptWith(durationsMs: number[], continuous = true): McScript {
  const base = fixtureTalkTileScript({ backgroundColor: '#ff8800' });
  const scenes = durationsMs.map((_ms, i) => ({
    ...base.scenes[i % base.scenes.length],
    idx: i,
    sceneId: `fx-${i + 1}`,
    dialogue: `Fala número ${i + 1} do vídeo.`,
  }));
  return { ...base, scenes, ...(continuous ? { talkMode: 'continuous' as const } : {}) };
}

function projectFor(script: McScript): McProject {
  return {
    id: 'proj-1',
    userId: 'u1',
    kitId: 'kit-1',
    aspectRatio: '4:5',
    pipelineVersion: MC_PIPELINE_V2,
    revision: 1,
    tier: 'economico',
    format: 'offer_piece',
    script,
    options: null,
  } as unknown as McProject;
}

async function setup(
  durationsMs: number[],
  opts: { cache?: Parameters<typeof fakeManager>[0]['cache'] } = {},
) {
  const audios = durationsMs.map((ms, i) => ({ id: `au-${i + 1}`, durationMs: ms, metadata: {} }));
  const manager = fakeManager({ assets: [tile, ...audios], cache: opts.cache });
  manager.seed(McCharacterKit, [{ ...kit }]);
  const service = new McMaterializerService({
    appendEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as CommercialsService);
  const script = scriptWith(durationsMs);
  const project = projectFor(script);
  const scenes = await service.syncScenesV2(manager, project, script, { rearm: true });
  scenes.forEach((scene, i) => Object.assign(scene, { audioAssetId: `au-${i + 1}` }));
  return { manager, service, script, project, scenes };
}

describe('materializeProductionV2 em modo contínuo — um talk por trecho', () => {
  it('3 falas curtas (8,4 s) viram UM trecho: um step na cena líder, snapshot com as 3 falas, prompt contínuo', async () => {
    const { manager, service, script, project, scenes } = await setup([2168, 1907, 4310]);
    const { steps, items } = await service.materializeProductionV2(
      manager,
      project,
      script,
      scenes,
    );
    expect(steps).toHaveLength(1);
    const step = steps[0];
    expect(step.type).toBe(McStepType.TALK);
    expect(step.sceneId).toBe(scenes[0].id);
    const chunk = readChunkSnapshot(step.inputSnapshot)!;
    expect(chunk.sceneIds).toEqual(['fx-1', 'fx-2', 'fx-3']);
    expect(chunk.sceneRowIds).toEqual(scenes.map((s) => s.id));
    expect(chunk.speeches.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 2168],
      [2368, 4275],
      [4475, 8785],
    ]);
    expect(chunk.join).toBeNull();
    const prompt = (step.inputSnapshot as { prompt: string }).prompt;
    expect(prompt).toContain('speaks several sentences in one continuous take');
    expect(prompt).not.toContain('Start and end in a neutral');
    // o cliente continua pagando por fala (3 itens), cobrados no step do trecho
    expect(items).toHaveLength(3);
    expect(step.costCredits).toBe(3 * TALK_CREDITS);
    // cenas seguidoras não têm step
    expect(manager.steps().filter((s) => s.sceneId === scenes[1].id)).toHaveLength(0);
  });

  it('26 s em 6 falas de ~4,3 s → 3 trechos de 2 falas; o hash de cada um encadeia o do anterior (junção)', async () => {
    const durations = [4300, 4300, 4300, 4300, 4300, 4300];
    const { manager, service, script, project, scenes } = await setup(durations);
    const { steps } = await service.materializeProductionV2(manager, project, script, scenes);
    expect(steps).toHaveLength(3);
    const chunks = steps.map((s) => readChunkSnapshot(s.inputSnapshot)!);
    expect(chunks.map((c) => c.sceneIds.length)).toEqual([2, 2, 2]);
    expect(chunks[0].tailMs).toBe(200);
    expect(chunks[2].tailMs).toBe(0);
    expect(chunks[1].join).toMatchObject({ fromChunkIndex: 0, fromStepHash: steps[0].inputHash });
    expect(chunks[2].join).toMatchObject({ fromChunkIndex: 1, fromStepHash: steps[1].inputHash });
    expect(chunks[1].join!.fromSceneRowId).toBe(scenes[0].id);

    // trocar a fala do 1º trecho muda o hash dos três (cascata); o conteúdo próprio do 3º não mudou
    const audio = manager.rows.get(
      (await import('../../../shared/media-assets/animation-asset.entity')).AnimationAsset,
    ) as Array<{ id: string; durationMs: number }>;
    Object.assign(scenes[0], { audioAssetId: 'au-novo' });
    audio.push({ id: 'au-novo', durationMs: 4300 });
    const again = await service.materializeProductionV2(manager, project, script, scenes);
    expect(again.steps.map((s, i) => s.inputHash !== steps[i].inputHash)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('trecho de UMA fala sem cauda nem junção mantém o hash legado (cache reaproveitado entre modos)', async () => {
    const { manager, service, script, project, scenes } = await setup([4300]);
    const { steps } = await service.materializeProductionV2(manager, project, script, scenes);
    const snapshot = steps[0].inputSnapshot as {
      engine: { model: string };
      backgroundColor: string;
      prompt: string;
    };
    expect(snapshot.prompt).toContain(TALK_PROMPT_SUFFIX.slice(0, 60));
    expect(snapshot.prompt).toContain('Start and end in a neutral'); // prompt de hoje: 1 fala não é "contínua"
    expect(steps[0].inputHash).toBe(
      computeTalkHashV2({
        engineModel: snapshot.engine.model,
        tileAssetId: 'tile-1',
        audioAssetId: 'au-1',
        prompt: snapshot.prompt,
        backgroundColor: snapshot.backgroundColor,
        attempt: 1,
      }),
    );
  });

  it('projeto SEM talkMode segue com um talk por cena (modo de hoje)', async () => {
    const { manager, service, project, scenes } = await setup([2000, 2000, 2000]);
    const script = scriptWith([2000, 2000, 2000], false);
    const { steps } = await service.materializeProductionV2(
      manager,
      { ...project, script } as McProject,
      script,
      scenes,
    );
    expect(steps).toHaveLength(3);
    expect(steps.every((s) => readChunkSnapshot(s.inputSnapshot) === null)).toBe(true);
  });

  it('cache do trecho: a líder e as seguidoras ficam ready com as fatias do asset reaproveitado', async () => {
    const { manager, service, script, project, scenes } = await setup([2168, 1907, 4310], {
      cache: [{ id: 'old-step', outputAssetId: 'slice-1' }],
    });
    const AnimationAsset = (await import('../../../shared/media-assets/animation-asset.entity'))
      .AnimationAsset;
    (manager.rows.get(AnimationAsset) as Array<Record<string, unknown>>).push({
      id: 'slice-1',
      metadata: {
        chunkSlices: [{ assetId: 'slice-1' }, { assetId: 'slice-2' }, { assetId: 'slice-3' }],
      },
    });
    const { steps } = await service.materializeProductionV2(manager, project, script, scenes);
    expect(steps[0].status).toBe(McStepStatus.SKIPPED_CACHED);
    expect(steps[0].costCredits).toBe(0);
    const rows = manager.scenes();
    expect(rows.map((r) => [r.status, r.finalAssetId])).toEqual([
      [McSceneStatus.READY, 'slice-1'],
      [McSceneStatus.READY, 'slice-2'],
      [McSceneStatus.READY, 'slice-3'],
    ]);
  });
});

describe('reroll por trecho e cotação (D13)', () => {
  const durations = [4300, 4300, 4300, 4300, 4300, 4300];

  async function delivered() {
    const ctx = await setup(durations);
    const first = await ctx.service.materializeProductionV2(
      ctx.manager,
      ctx.project,
      ctx.script,
      ctx.scenes,
    );
    // entregue: os 3 trechos concluídos
    for (const step of first.steps) {
      await ctx.manager.update(
        McStep,
        { id: step.id },
        { status: McStepStatus.SUCCEEDED, outputAssetId: `out-${step.id}` },
      );
    }
    return { ...ctx, first };
  }

  it('reroll de uma fala do trecho 2 regrava o trecho 2 (attempt+1, reroll) e o 3 (cascata sem crédito); o trecho 1 não é tocado', async () => {
    const { manager, service, script, project, scenes, first } = await delivered();
    const target = scenes[2]; // 1ª fala do 2º trecho
    const { steps, items } = await service.materializeProductionV2(
      manager,
      project,
      script,
      [target],
      {
        forceNewAttempt: true,
      },
    );
    expect(steps).toHaveLength(2);
    expect(steps[0].sceneId).toBe(scenes[2].id);
    expect(steps[0].attempt).toBe(2);
    expect(steps[0].inputHash).not.toBe(first.steps[1].inputHash);
    expect(steps[1].sceneId).toBe(scenes[4].id);
    // cobra só a fala pedida do trecho pedido; a cascata não cobra (Q2)
    expect(steps[0].costCredits).toBe(TALK_CREDITS);
    expect(steps[1].costCredits).toBe(0);
    expect(items).toHaveLength(1);
    expect(items[0].sceneId).toBe('fx-3');
    // o 1º trecho continua com o step original
    expect(manager.steps().filter((s) => s.sceneId === scenes[0].id)).toHaveLength(1);
  });

  it('a cotação lista os trechos e, depois de editar a fala 1, marca o 1º como edited e os seguintes como cascade', async () => {
    const { manager, service, script, project, scenes } = await delivered();
    const AnimationAsset = (await import('../../../shared/media-assets/animation-asset.entity'))
      .AnimationAsset;
    (manager.rows.get(AnimationAsset) as Array<Record<string, unknown>>).push({
      id: 'au-edit',
      durationMs: 4100,
    });
    Object.assign(scenes[0], { audioAssetId: 'au-edit' });
    const quote = await quoteTalkChunks(service, manager, {
      project,
      script,
      scenes,
      mode: { cutout: false, framing: 'busto', keyColor: null, continuous: true },
    });
    expect(quote.chunks!.map((c) => c.reason)).toEqual(['edited', 'cascade', 'cascade']);
    expect(quote.chunks![0]).toMatchObject({
      index: 0,
      sceneIds: ['fx-1', 'fx-2'],
      joinFromIndex: null,
      rewrite: true,
    });
    expect(quote.chunks![1].joinFromIndex).toBe(0);
    expect(quote.chunks!.every((c) => c.estimatedUsd > 0)).toBe(true);
    expect(quote.estimatedUsd).toBeCloseTo(
      quote.chunks!.reduce((t, c) => t + c.estimatedUsd, 0),
      4,
    );
    expect(quote.scenes).toHaveLength(6);
    expect(quote.scenes.map((s) => s.chunkIndex)).toEqual([0, 0, 1, 1, 2, 2]);
    // a cotação não grava nada
    expect(manager.steps()).toHaveLength(3);
  });

  it('resolveChunkReroll: o trecho da fala pedida (todas as falas dele) + os seguintes em cascata; o anterior fica de fora', async () => {
    const { manager, service, script, project, scenes } = await delivered();
    const scope = (await service.resolveChunkReroll(manager, project, script, [scenes[3]]))!;
    expect(scope.chunkIndex).toBe(1);
    expect(scope.sceneIds).toEqual(['fx-3', 'fx-4']);
    expect(scope.cascadeSceneIds).toEqual(['fx-5', 'fx-6']);
    expect(scope.regravar.map((s) => s.id)).toEqual([scenes[2].id, scenes[3].id]);
    expect(scope.cascade.map((s) => s.id)).toEqual([scenes[4].id, scenes[5].id]);
    // o último trecho não tem seguinte; um trecho só: sem cascata
    const last = (await service.resolveChunkReroll(manager, project, script, [scenes[5]]))!;
    expect(last.chunkIndex).toBe(2);
    expect(last.cascadeSceneIds).toEqual([]);
    // nada é escrito
    expect(manager.steps()).toHaveLength(3);
  });

  it('resolveChunkReroll: duas falas pedidas em trechos diferentes regravam os dois e os seguintes; fora do modo contínuo é null', async () => {
    const { manager, service, script, project, scenes } = await delivered();
    const scope = (await service.resolveChunkReroll(manager, project, script, [
      scenes[0],
      scenes[2],
    ]))!;
    expect(scope.chunkIndex).toBe(0);
    expect(scope.sceneIds).toEqual(['fx-1', 'fx-2', 'fx-3', 'fx-4']);
    expect(scope.cascadeSceneIds).toEqual(['fx-5', 'fx-6']);
    const plain = { ...script, talkMode: undefined } as McScript;
    expect(
      await service.resolveChunkReroll(manager, { ...project, script: plain } as McProject, plain, [
        scenes[0],
      ]),
    ).toBeNull();
  });

  it('editar uma fala que muda o agrupamento: os trechos seguintes (mesmas falas, trechos novos) são cascata e não cobram', async () => {
    const { manager, service, script, project, scenes } = await delivered();
    const AnimationAsset = (await import('../../../shared/media-assets/animation-asset.entity'))
      .AnimationAsset;
    // a fala 1 passa de 4,3 s para 7,8 s: o trecho 1 fica só com ela e as demais se reagrupam
    (manager.rows.get(AnimationAsset) as Array<Record<string, unknown>>).push({
      id: 'au-longa',
      durationMs: 7800,
    });
    Object.assign(scenes[0], { audioAssetId: 'au-longa' });
    const quote = await quoteTalkChunks(service, manager, {
      project,
      script,
      scenes,
      mode: { cutout: false, framing: 'busto', keyColor: null, continuous: true },
    });
    expect(quote.chunks!.map((c) => c.reason)).toEqual(['edited', 'cascade', 'cascade', 'cascade']);
    expect(quote.chunks![0].chargedSceneIds).toEqual(['fx-1']); // só a fala editada cobra
    expect(quote.chunks!.slice(1).every((c) => c.chargedSceneIds.length === 0)).toBe(true);
  });

  it('o trecho editado cobra só as falas editadas (as irmãs regravadas junto não)', async () => {
    const { manager, service, script, project, scenes } = await delivered();
    const AnimationAsset = (await import('../../../shared/media-assets/animation-asset.entity'))
      .AnimationAsset;
    (manager.rows.get(AnimationAsset) as Array<Record<string, unknown>>).push({
      id: 'au-edit',
      durationMs: 4100,
    });
    Object.assign(scenes[2], { audioAssetId: 'au-edit' }); // 1ª fala do 2º trecho
    const { items, steps } = await service.materializeProductionV2(
      manager,
      project,
      script,
      scenes,
    );
    const talkItems = items.filter((i) => !i.cached);
    expect(talkItems.map((i) => i.sceneId)).toEqual(['fx-3']);
    expect(steps.find((s) => s.sceneId === scenes[2].id)!.costCredits).toBe(TALK_CREDITS);
    // o trecho seguinte regravado pela junção: crédito 0
    expect(steps.find((s) => s.sceneId === scenes[4].id)!.costCredits).toBe(0);
    expect(items.some((i) => i.sceneId === 'fx-5')).toBe(false);
  });

  it('cotação inicial (sem step anterior): todos os trechos new', async () => {
    const { manager, service, script, project, scenes } = await setup(durations);
    const quote = await quoteTalkChunks(service, manager, {
      project,
      script,
      scenes,
      mode: { cutout: false, framing: 'busto', keyColor: null, continuous: true },
    });
    expect(quote.chunks!.map((c) => c.reason)).toEqual(['new', 'new', 'new']);
    expect(quote.rewriteCount).toBe(6);
  });
});
