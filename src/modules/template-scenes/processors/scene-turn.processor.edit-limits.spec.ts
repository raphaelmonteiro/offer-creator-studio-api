import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { SceneProviderError } from '../providers/scene-image-provider';
import * as recomposeModule from '../services/scene-recompose';
import { editPlan, goodVision, pricedProviderOf } from '../testing/scene-edit-fixtures';
import { useProcessorHarness } from '../testing/scene-processor-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

describeIfSceneDb('SceneTurnProcessor: edição local, limites e falhas (banco chroma_x_e2e)', () => {
  jest.setTimeout(60_000);
  const h = useProcessorHarness();
  afterEach(() => jest.restoreAllMocks());
  const pricedProvider = (costUsd = 0.035) => pricedProviderOf(h, costUsd);

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
