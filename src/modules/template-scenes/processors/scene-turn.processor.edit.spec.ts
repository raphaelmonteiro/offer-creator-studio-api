import { SceneVisionClient } from '../providers/scene-vision-client';
import * as sharp from 'sharp';
import { Raster } from '../../../shared/image/raster';
import { loadRgb } from '../../../shared/image/rgb';
import { authorizedRegion, marginPx, rasterizeRegion } from '../domain/scene-shapes';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { editPlan, goodVision, pricedProviderOf, RECT } from '../testing/scene-edit-fixtures';
import { useProcessorHarness } from '../testing/scene-processor-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { genEl, logoEl } from '../testing/scene-operation-fixtures';
import { SceneTurnState } from './scene-turn-state';

describeIfSceneDb('SceneTurnProcessor: edição local (banco chroma_x_e2e)', () => {
  jest.setTimeout(60_000);
  const h = useProcessorHarness();

  afterEach(() => jest.restoreAllMocks());

  const pricedProvider = (costUsd = 0.035) => pricedProviderOf(h, costUsd);
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

  it('remover: o prompt leva a frase do cliente e a instrução de continuar o fundo', async () => {
    const { scene } = await h.readyScene();
    const version = await h.queueTurn(scene, {
      plan: editPlan(undefined, { remove: true, instruction: 'remover o sol' }),
      request: 'remover o sol',
    });
    const { provider, edit } = pricedProvider(0);

    await h.processorWith(provider, {}, goodVision()).process(h.job(scene.id, version.id));

    const prompt = edit.mock.calls[0][0].prompt;
    expect(prompt).toContain('remover o sol');
    expect(prompt).toContain('Continue o fundo ao redor');
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

  describe('pedido não atendido (correção 3)', () => {
    const visionSays = (satisfied: 'sim' | 'parcial' | 'nao') => ({
      compare: jest.fn(async () => ({
        text: JSON.stringify({ mudou: 'Os ovos continuam na imagem.', atendeu: satisfied }),
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
        requestId: 'req_v',
        latencyMs: 10,
      })),
    });

    it('Visão diz que não atendeu: versão ready com notApplied, a atual não muda, o custo soma e a resposta informa', async () => {
      const { scene } = await h.readyScene();
      const version = await h.queueTurn(scene, { plan: editPlan(), request: 'remova os ovos' });
      const { provider } = pricedProvider(0.035);

      await h.processorWith(provider, {}, visionSays('nao')).process(h.job(scene.id, version.id));

      const done = await h.versionOf(version.id);
      expect(done).toMatchObject({ status: 'ready', step: 'done' });
      expect(done.metrics.notApplied).toBe(true);
      expect(done.masterAssetId).not.toBeNull();
      const stored = await h.sceneOf(scene.id);
      expect(stored.currentVersionId).toBe(scene.currentVersionId);
      expect(stored.totalCostUsd).toBeCloseTo(0.03515, 5);
      expect(done.providerCostUsd).toBeCloseTo(0.03515, 5);
      const messages = await h.messagesOf(scene.id);
      const reply = messages[messages.length - 1].content;
      expect(reply).toBe(
        'Não consegui atender ao pedido: Os ovos continuam na imagem. Mantive a imagem atual. Esta tentativa custou US$ 0,04.',
      );
      expect(reply).not.toContain('preservado');
    });

    it.each(['sim', 'parcial'] as const)('%s continua trocando a imagem atual', async (answer) => {
      const { scene } = await h.readyScene();
      const version = await h.queueTurn(scene, { plan: editPlan(), request: 'deixa mais claro' });
      const { provider } = pricedProvider();

      await h.processorWith(provider, {}, visionSays(answer)).process(h.job(scene.id, version.id));

      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(version.id);
      expect((await h.versionOf(version.id)).metrics.notApplied).toBeUndefined();
    });

    it('Atendido em parte: a resposta não diz que o resto foi preservado', async () => {
      const { scene } = await h.readyScene();
      const version = await h.queueTurn(scene, { plan: editPlan(), request: 'deixa mais claro' });
      const { provider } = pricedProvider();

      await h
        .processorWith(provider, {}, visionSays('parcial'))
        .process(h.job(scene.id, version.id));

      const messages = await h.messagesOf(scene.id);
      expect(messages[messages.length - 1].content).not.toContain('preservado');
      expect(messages[messages.length - 1].content).toContain('em parte');
    });

    it('visão indisponível continua como antes: a edição vale', async () => {
      const { scene } = await h.readyScene();
      const version = await h.queueTurn(scene, { plan: editPlan(), request: 'deixa mais claro' });
      const broken: SceneVisionClient = { compare: jest.fn().mockRejectedValue(new Error('503')) };

      await h.processorWith(h.mock(), {}, broken).process(h.job(scene.id, version.id));

      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(version.id);
    });
  });

  describe('integrar uma camada ao fundo (correção 5)', () => {
    const basket = { ...genEl, id: 'cesta-1', name: 'Cesta de ovos' };
    const integratePlan = () =>
      editPlan(
        { kind: 'rect', rect: RECT },
        {
          instruction: 'integre esta cesta ao cenário',
          integrate: true,
          integrateLayer: { elementId: 'cesta-1', name: 'Cesta de ovos' },
        },
      );
    const run = async (answer: 'sim' | 'nao', request = 'x') => {
      const { scene } = await h.readyScene({ elements: [logoEl, basket] });
      const version = await h.queueTurn(scene, { plan: integratePlan(), request });
      const { provider, edit } = pricedProvider();
      const vision = {
        compare: jest.fn(async () => ({
          text: JSON.stringify({ mudou: 'A cesta está no gramado.', atendeu: answer }),
          usage: null,
          requestId: 'req_v',
          latencyMs: 1,
        })),
      };
      await h.processorWith(provider, {}, vision).process(h.job(scene.id, version.id));
      return { scene, version, edit };
    };

    it('aplicada: o prompt leva o nome da camada e a versão nova não tem mais a camada', async () => {
      const { scene, version, edit } = await run('sim');

      expect(edit.mock.calls[0][0].prompt).toContain('"Cesta de ovos" integrado ao fundo');
      const done = await h.versionOf(version.id);
      expect(done.elements.map((e) => e.id)).toEqual(['logo-1']);
      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(version.id);
    });

    it('Integração não atendida: a imagem atual e a camada ficam como estão', async () => {
      const { scene, version } = await run('nao');

      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(scene.currentVersionId);
      const current = await h.versionOf(scene.currentVersionId as string);
      expect(current.elements.map((e) => e.id)).toEqual(['logo-1', 'cesta-1']);
      expect((await h.versionOf(version.id)).metrics.notApplied).toBe(true);
    });

    it('sem mudança: a camada continua, porque nada foi pintado', async () => {
      const { scene } = await h.readyScene({ elements: [basket] });
      const version = await h.queueTurn(scene, {
        plan: { ...integratePlan(), instruction: 'integre #sem-mudanca' } as never,
        request: 'integre #sem-mudanca',
      });

      await h.processorWith(h.mock()).process(h.job(scene.id, version.id));

      const done = await h.versionOf(version.id);
      expect(done.metrics.noChange).toBe(true);
      expect(done.elements.map((e) => e.id)).toEqual(['cesta-1']);
    });
  });
});
