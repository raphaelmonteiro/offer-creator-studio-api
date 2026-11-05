import * as sharp from 'sharp';
import { Raster } from '../../../shared/image/raster';
import { loadRgb } from '../../../shared/image/rgb';
import { LocalTarget, SceneClassification } from '../domain/scene-operation.classifier';
import { authorizedRegion, marginPx, rasterizeRegion } from '../domain/scene-shapes';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { SceneProviderError } from '../providers/scene-image-provider';
import { SceneVisionClient } from '../providers/scene-vision-client';
import * as recomposeModule from '../services/scene-recompose';
import { useProcessorHarness } from '../testing/scene-processor-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { SceneTurnState } from './scene-turn-state';

const RECT = { x: 0.35, y: 0.3, w: 0.3, h: 0.15 };
const editPlan = (
  target: LocalTarget = { kind: 'rect', rect: RECT },
  over: Partial<Extract<SceneClassification, { operation: 'local_edit' }>> = {},
): SceneClassification => ({
  operation: 'local_edit',
  target,
  instruction: 'deixa o sol mais alaranjado',
  remove: false,
  ...over,
});

const goodVision = (): SceneVisionClient & { compare: jest.Mock } => ({
  compare: jest.fn(async () => ({
    text: JSON.stringify({ mudou: 'O sol ficou alaranjado.', atendeu: 'sim' }),
    usage: { prompt_tokens: 1000, completion_tokens: 100 },
    requestId: 'req_v',
    latencyMs: 10,
  })),
});

describeIfSceneDb('SceneTurnProcessor: edição local (banco chroma_x_e2e)', () => {
  jest.setTimeout(60_000);
  const h = useProcessorHarness();

  afterEach(() => jest.restoreAllMocks());

  /** Provedor que usa a edição do mock (pinta de verdade) mas cobra um valor conhecido. */
  const pricedProvider = (costUsd = 0.035) => {
    const real = h.mock();
    return h.fakeProvider(() => h.okResult(), {
      edit: async (input) => ({ ...(await real.edit(input)), costUsd, requestId: 'req_edit' }),
    });
  };
  const outsideDifferent = (a: Uint8Array, b: Uint8Array, a0: Raster): number => {
    let different = 0;
    for (let i = 0; i < a0.data.length; i += 1) {
      if (a0.data[i]) continue;
      for (let c = 0; c < 3; c += 1) if (a[i * 3 + c] !== b[i * 3 + c]) different += 1;
    }
    return different;
  };
  const masterOf = async (assetId: string | null) => {
    const asset = await h.dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
      id: assetId as string,
    });
    return loadRgb(await sharp(h.files.absolutePath(asset.url)).png().toBuffer());
  };

  it('retângulo: a nova master só difere dentro da região, com métricas, custo por etapa e etapas com nome', async () => {
    const { scene, master } = await h.readyScene();
    const version = await h.queueTurn(scene, {
      plan: editPlan(),
      request: 'deixa o sol mais alaranjado',
      overrides: { requestedRegion: RECT },
    });
    const { provider, edit } = pricedProvider();
    const vision = goodVision();
    const steps: string[] = [];
    const advance = SceneTurnState.prototype.advance;
    jest.spyOn(SceneTurnState.prototype, 'advance').mockImplementation(function (
      this: SceneTurnState,
      ctx,
      step,
    ) {
      steps.push(step);
      return advance.call(this, ctx, step);
    });

    await h.processorWith(provider, {}, vision).process(h.job(scene.id, version.id));

    const done = await h.versionOf(version.id);
    expect(done).toMatchObject({
      status: 'ready',
      step: 'done',
      operation: 'local_edit',
      requestedRegion: RECT,
    });
    expect(steps).toEqual(['editing', 'blending', 'checking', 'saving']);
    expect(done.metrics).toMatchObject({
      noChange: false,
      vision: { satisfied: 'sim' },
      crop: expect.objectContaining({ downscaled: false }),
    });
    expect(done.metrics.insideMaskDiffRatio).toBeGreaterThan(0.9);
    expect(done.metrics.marginDiffRatio).not.toBeUndefined();
    expect(done.metrics.seamSsim).not.toBeUndefined();
    expect(done.metrics.maskAreaRatio).toBeCloseTo(0.045, 3);
    // custo por etapa: a edição e a visão, cada uma com a tentativa fechada
    expect(done.metrics.calls).toEqual([
      expect.objectContaining({
        kind: 'edit',
        status: 'done',
        costUsd: 0.035,
        requestId: 'req_edit',
      }),
      expect.objectContaining({ kind: 'vision', status: 'done', requestId: 'req_v' }),
    ]);
    expect(done.providerCostUsd).toBeCloseTo(0.03515, 5);
    expect((await h.sceneOf(scene.id)).totalCostUsd).toBeCloseTo(0.03515, 5);
    // a edição recebeu o recorte com a máscara e o prompt em português
    const input = edit.mock.calls[0][0];
    expect(input.mask).toBeDefined();
    expect(input.prompt).toContain('Na área marcada: deixa o sol mais alaranjado');
    // exterior idêntico à versão anterior
    const before = await loadRgb(master);
    const after = await masterOf(done.masterAssetId);
    const shape = await rasterizeRegion({ kind: 'rect', rect: RECT }, 1024, 2048);
    const authorized = authorizedRegion(shape, marginPx(0.04, 1024, 2048));
    expect(outsideDifferent(before.data, after.data, authorized)).toBe(0);
    const stored = await h.sceneOf(scene.id);
    expect(stored.currentVersionId).toBe(version.id);
    const messages = await h.messagesOf(scene.id);
    expect(messages[messages.length - 1].content).toContain('O sol ficou alaranjado.');
  });

  it('laço: o vizinho fora da forma e da margem fica idêntico', async () => {
    const { scene, master } = await h.readyScene();
    const mask = {
      kind: 'lasso' as const,
      points: [
        { x: 0.4, y: 0.3 },
        { x: 0.6, y: 0.3 },
        { x: 0.5, y: 0.42 },
      ],
    };
    const version = await h.queueTurn(scene, {
      plan: editPlan({ kind: 'mask', mask }),
      request: 'deixa o sol mais brilhante',
      overrides: { requestedMask: mask },
    });

    await h.processorWith(h.mock()).process(h.job(scene.id, version.id));

    const done = await h.versionOf(version.id);
    expect(done.status).toBe('ready');
    const before = await loadRgb(master);
    const after = await masterOf(done.masterAssetId);
    const shape = await rasterizeRegion(mask, 1024, 2048);
    const authorized = authorizedRegion(shape, marginPx(0.04, 1024, 2048));
    expect(outsideDifferent(before.data, after.data, authorized)).toBe(0);
  });

  it('remover: o prompt pede para tirar o item e continuar o fundo, sem repetir o pedido', async () => {
    const { scene } = await h.readyScene();
    const version = await h.queueTurn(scene, {
      plan: editPlan(undefined, { remove: true, instruction: 'remover o sol' }),
      request: 'remover o sol',
    });
    const { provider, edit } = pricedProvider(0);

    await h.processorWith(provider, {}, goodVision()).process(h.job(scene.id, version.id));

    expect(edit.mock.calls[0][0].prompt).toContain(
      'remova o que está na área marcada e continue o fundo ao redor',
    );
    expect((await h.versionOf(version.id)).status).toBe('ready');
  });

  it('o modelo devolve a mesma área: versão ready com aviso e sem gastar a visão', async () => {
    const { scene } = await h.readyScene();
    const version = await h.queueTurn(scene, {
      plan: editPlan(undefined, { instruction: 'x #sem-mudanca' }),
      request: 'x #sem-mudanca',
    });
    const vision = goodVision();

    await h.processorWith(h.mock(), {}, vision).process(h.job(scene.id, version.id));

    const done = await h.versionOf(version.id);
    expect(done.status).toBe('ready');
    expect(done.metrics.noChange).toBe(true);
    expect(done.metrics.calls).toHaveLength(1);
    expect(vision.compare).not.toHaveBeenCalled();
    const messages = await h.messagesOf(scene.id);
    expect(messages[messages.length - 1].content).toContain('Não vi mudança');
  });

  it('visão indisponível: a edição vale e a resposta sai das métricas', async () => {
    const { scene } = await h.readyScene();
    const version = await h.queueTurn(scene, { plan: editPlan(), request: 'deixa o sol laranja' });
    const broken: SceneVisionClient = { compare: jest.fn().mockRejectedValue(new Error('503')) };

    await h.processorWith(h.mock(), {}, broken).process(h.job(scene.id, version.id));

    const done = await h.versionOf(version.id);
    expect(done.status).toBe('ready');
    expect(done.metrics.vision).toBeNull();
    expect(done.metrics.calls?.[1]).toMatchObject({
      kind: 'vision',
      status: 'failed',
      errorCode: 'VISION_ERROR',
    });
    const messages = await h.messagesOf(scene.id);
    expect(messages[messages.length - 1].content).toBe(
      'Pronto! Editei a área marcada. O resto da imagem foi preservado.',
    );
  });

  it('limite de chamadas em 1: a visão é pulada, a versão fica ready e o custo é só o da edição', async () => {
    const { scene } = await h.readyScene();
    const version = await h.queueTurn(scene, { plan: editPlan(), request: 'deixa o sol laranja' });
    const { provider } = pricedProvider(0.035);
    const vision = goodVision();

    await h
      .processorWith(provider, { TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE: '1' }, vision)
      .process(h.job(scene.id, version.id));

    const done = await h.versionOf(version.id);
    expect(done.status).toBe('ready');
    expect(done.errorCode).toBeNull();
    expect(done.metrics.calls).toHaveLength(1);
    expect(vision.compare).not.toHaveBeenCalled();
    expect(done.providerCostUsd).toBe(0.035);
    const messages = await h.messagesOf(scene.id);
    expect(messages[messages.length - 1].content).toContain('Editei a área marcada');
  });

  it('limite antes da chamada de imagem: PAID_CALL_LIMIT e o provedor nem é chamado', async () => {
    const { scene } = await h.readyScene();
    const version = await h.queueTurn(scene, {
      plan: editPlan(),
      request: 'deixa o sol laranja',
      overrides: {
        metrics: {
          plan: editPlan(),
          calls: [
            {
              id: 'c0',
              kind: 'edit',
              status: 'done',
              model: 'm',
              size: '1x1',
              startedAt: new Date().toISOString(),
              costUsd: 0.01,
            },
          ],
        },
      },
    });
    const { provider, edit } = pricedProvider();

    await h
      .processorWith(provider, { TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE: '1' })
      .process(h.job(scene.id, version.id));

    expect(edit).not.toHaveBeenCalled();
    expect(await h.versionOf(version.id)).toMatchObject({
      status: 'failed',
      errorCode: 'PAID_CALL_LIMIT',
    });
    expect((await h.sceneOf(scene.id)).currentVersionId).toBe(scene.currentVersionId);
  });

  it('conferência byte a byte falha: RECOMPOSE_MISMATCH, custo gravado e a versão anterior continua atual', async () => {
    const { scene } = await h.readyScene();
    const version = await h.queueTurn(scene, { plan: editPlan(), request: 'deixa o sol laranja' });
    const actual = recomposeModule.recompose;
    jest.spyOn(recomposeModule, 'recompose').mockImplementation(async (...args) => {
      const result = await actual(...args);
      result.final.data[0] = (result.final.data[0] + 1) % 256;
      return result;
    });
    const { provider } = pricedProvider(0.035);

    await h.processorWith(provider).process(h.job(scene.id, version.id));

    const done = await h.versionOf(version.id);
    expect(done).toMatchObject({ status: 'failed', errorCode: 'RECOMPOSE_MISMATCH' });
    expect(done.providerCostUsd).toBe(0.035);
    expect((await h.sceneOf(scene.id)).currentVersionId).toBe(scene.currentVersionId);
    const messages = await h.messagesOf(scene.id);
    expect(messages[messages.length - 1]).toMatchObject({ status: 'failed' });
  });

  it('falta de crédito na edição: uma só requisição, failed PROVIDER_QUOTA', async () => {
    const { scene } = await h.readyScene();
    const version = await h.queueTurn(scene, { plan: editPlan(), request: 'deixa o sol laranja' });
    const { provider, edit } = h.fakeProvider(() => h.okResult(), {
      edit: async () => {
        throw new SceneProviderError('PROVIDER_QUOTA', 'sem saldo');
      },
    });

    await h.processorWith(provider).process(h.job(scene.id, version.id));

    expect(edit).toHaveBeenCalledTimes(1);
    const done = await h.versionOf(version.id);
    expect(done).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_QUOTA' });
    expect(done.metrics.calls).toEqual([
      expect.objectContaining({ kind: 'edit', status: 'failed' }),
    ]);
  });

  it('cancelamento durante a edição: resultado descartado, custo gravado, versão cancelled', async () => {
    const { scene } = await h.readyScene();
    const version = await h.queueTurn(scene, { plan: editPlan(), request: 'deixa o sol laranja' });
    const real = h.mock();
    const { provider } = h.fakeProvider(() => h.okResult(), {
      edit: async (input) => {
        await h.dataSource.manager.update(
          'template_scene_versions',
          { id: version.id },
          { cancelRequestedAt: new Date() },
        );
        return { ...(await real.edit(input)), costUsd: 0.035 };
      },
    });

    await h.processorWith(provider).process(h.job(scene.id, version.id));

    const done = await h.versionOf(version.id);
    expect(done.status).toBe('cancelled');
    expect(done.providerCostUsd).toBe(0.035);
    expect((await h.sceneOf(scene.id)).currentVersionId).toBe(scene.currentVersionId);
  });

  it('região pequena demais para o recorte: rejeita sem chamar o modelo', async () => {
    const { scene } = await h.readyScene({ width: 256, height: 512 });
    const version = await h.queueTurn(scene, { plan: editPlan(), request: 'deixa o sol laranja' });
    const { provider, edit } = pricedProvider();

    await h.processorWith(provider).process(h.job(scene.id, version.id));

    expect(edit).not.toHaveBeenCalled();
    expect(await h.versionOf(version.id)).toMatchObject({ status: 'rejected', providerCostUsd: 0 });
  });

  it('poda: a edição que cria a 6ª versão ready marca a master da 1ª para o GC', async () => {
    const { scene, masterAsset, master } = await h.readyScene();
    // versões 2..5: ready, cada uma com master e prévia próprias; a cena aponta para a 5
    let previous = scene.currentVersionId;
    for (const n of [2, 3, 4, 5]) {
      previous = (await h.readyVersionLike(scene, n, previous, master)).version.id;
    }
    const sceneRow = await h.sceneOf(scene.id);
    sceneRow.currentVersionId = previous;
    await h.dataSource.manager.save(sceneRow);
    const version = await h.queueTurn(
      { id: scene.id, currentVersionId: previous },
      { plan: editPlan(), request: 'deixa o sol laranja', number: 6 },
    );

    await h.processorWith(h.mock()).process(h.job(scene.id, version.id));

    expect((await h.versionOf(version.id)).status).toBe('ready');
    const first = await h.dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
      id: masterAsset.id,
    });
    expect(first.expiresAt).not.toBeNull();
  });
});
