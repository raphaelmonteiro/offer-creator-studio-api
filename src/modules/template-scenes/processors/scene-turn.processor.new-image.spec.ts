import { genEl, lastReplyOf, logoEl, textEl } from '../testing/scene-operation-fixtures';
import { insertMessage } from '../testing/scene-fixtures';
import { useProcessorHarness } from '../testing/scene-processor-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

describeIfSceneDb('SceneTurnProcessor: imagem nova, D-18 (banco chroma_x_e2e)', () => {
  jest.setTimeout(60_000);
  const h = useProcessorHarness();
  afterEach(() => jest.restoreAllMocks());

  it('Confirmar a imagem nova: o provedor recebe generate, sem imagem, com o tema da primeira geração', async () => {
    const { scene, version: first } = await h.readyScene({ elements: [logoEl, textEl, genEl] });
    await insertMessage(h.dataSource, scene.id, {
      versionId: first.id,
      content: 'template de pascoa com ovos e um coelho',
    });
    const version = await h.queueTurn(scene, {
      plan: { operation: 'new_image', instruction: 'gere outra imagem' },
      request: 'Confirmar',
      operation: 'generate',
    });
    const { provider, generate, edit } = h.fakeProvider(() => h.okResult(0.13));
    const vision = { compare: jest.fn() };

    await h.processorWith(provider, {}, vision).process(h.job(scene.id, version.id));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();
    expect(vision.compare).not.toHaveBeenCalled();
    const input = generate.mock.calls[0][0];
    expect(input.prompt).toContain(
      '"template de pascoa com ovos e um coelho (pedido atual do cliente: gere outra imagem)"',
    );
    expect(input.prompt).toContain('única e contínua');
    const done = await h.versionOf(version.id);
    expect(done).toMatchObject({
      status: 'ready',
      operation: 'generate',
      parentVersionId: scene.currentVersionId,
    });
    expect(done.elements).toEqual([logoEl, textEl, genEl]);
    expect(done.metrics.calls).toHaveLength(1);
    expect(done.providerCostUsd).toBeCloseTo(0.13, 5);
    expect((await h.sceneOf(scene.id)).currentVersionId).toBe(version.id);
    expect(await lastReplyOf(h, scene.id)).toContain('Pronto');
  });

  it('um tema novo no pedido entra junto do tema original', async () => {
    const { scene, version: first } = await h.readyScene();
    await insertMessage(h.dataSource, scene.id, { versionId: first.id, content: 'páscoa' });
    const version = await h.queueTurn(scene, {
      plan: { operation: 'new_image', instruction: 'gere outra imagem mais rústica' },
      request: 'Confirmar',
      operation: 'generate',
    });
    const { provider, generate } = h.fakeProvider(() => h.okResult());

    await h.processorWith(provider).process(h.job(scene.id, version.id));

    expect(generate.mock.calls[0][0].prompt).toContain(
      'páscoa (pedido atual do cliente: gere outra imagem mais rústica)',
    );
  });
});
