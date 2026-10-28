import { McStepStatus, McSceneStatus } from '../domain/mc-state-machines';
import { computeTalkHashV2 } from '../domain/mc-step-hashes';
import { TALK_PROMPT_SUFFIX } from '../domain/mc-talk-prompts';
import { McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { readChunkSnapshot } from '../domain/mc-talk-chunk-step';
import { scriptWith, setup, TALK_CREDITS } from './mc-talk-chunk-materializer.fixture';

/**
 * Materialização do `talk` por TRECHO (change video-fala-continua, 1.4): um step por trecho ancorado na
 * cena líder, hash encadeado pela junção e cache que religa as fatias.
 */
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
