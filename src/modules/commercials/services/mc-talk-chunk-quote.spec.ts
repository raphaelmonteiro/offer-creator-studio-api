import { McStepStatus } from '../domain/mc-state-machines';
import { McScript, McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';
import { quoteTalkChunks } from './mc-talk-chunk-materializer';
import { setup, TALK_CREDITS } from './mc-talk-chunk-materializer.fixture';

/** Reroll por trecho, cascata e cotação do `talk` (change video-fala-continua, 1.4, D13). */
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

  it('a cascata nunca repete a tentativa do trecho: dois steps `talk` da mesma líder com a mesma tentativa deixavam o novo invisível ao agendador', async () => {
    const { manager, service, script, project, scenes } = await delivered();
    const leaderOf = (row: (typeof scenes)[number]) =>
      manager
        .steps()
        .filter((s) => s.sceneId === row.id && s.type === McStepType.TALK)
        .map((s) => s.attempt);
    for (const round of [1, 2]) {
      const { steps } = await service.materializeProductionV2(
        manager,
        project,
        script,
        [scenes[2]],
        { forceNewAttempt: true },
      );
      // conclui o que foi criado, como o worker faria, antes do reroll seguinte
      for (const step of steps) {
        await manager.update(McStep, { id: step.id }, { status: McStepStatus.SUCCEEDED });
      }
      for (const leader of [scenes[2], scenes[4]]) {
        const attempts = leaderOf(leader);
        expect(new Set(attempts).size).toBe(attempts.length); // sem empate de tentativa
      }
      // o step novo da cascata é o de maior tentativa da líder do trecho 3
      const cascade = steps.find((s) => s.sceneId === scenes[4].id)!;
      expect(cascade.attempt).toBe(Math.max(...(leaderOf(scenes[4]) as number[])));
      expect(cascade.attempt).toBe(round + 1);
    }
  });

  it('repetir a materialização sem mudança (mesmo hash) não abre tentativa nova', async () => {
    const { manager, service, script, project, scenes } = await delivered();
    await service.materializeProductionV2(manager, project, script, scenes);
    const attempts = manager
      .steps()
      .filter((s) => s.type === McStepType.TALK)
      .map((s) => s.attempt);
    expect(Math.max(...(attempts as number[]))).toBe(1);
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
