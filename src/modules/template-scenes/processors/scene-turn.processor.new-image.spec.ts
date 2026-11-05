import { genEl, lastReplyOf, logoEl, textEl } from '../testing/scene-operation-fixtures';
import { insertMessage, insertVersion } from '../testing/scene-fixtures';
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
      '"template de pascoa com ovos e um coelho (pedido atual do cliente, que prevalece sobre o anterior: gere outra imagem)"',
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
      'páscoa (pedido atual do cliente, que prevalece sobre o anterior: gere outra imagem mais rústica)',
    );
  });

  it('a geração grava o pedido efetivo em metrics, e a próxima imagem nova parte do mais recente (PV-33)', async () => {
    const { scene, version: first } = await h.readyScene();
    await insertMessage(h.dataSource, scene.id, { versionId: first.id, content: 'páscoa' });
    const { provider, generate } = h.fakeProvider(() => h.okResult());
    const second = await h.queueTurn(scene, {
      plan: { operation: 'new_image', instruction: 'gere outra imagem de natal' },
      request: 'Confirmar',
      operation: 'generate',
    });
    await h.processorWith(provider).process(h.job(scene.id, second.id));
    const recorded =
      'páscoa (pedido atual do cliente, que prevalece sobre o anterior: gere outra imagem de natal)';
    expect((await h.versionOf(second.id)).metrics.generationRequest).toBe(recorded);

    const third = await h.queueTurn(await h.sceneOf(scene.id), {
      plan: { operation: 'new_image', instruction: 'gere outra imagem' },
      request: 'Confirmar',
      number: 3,
      operation: 'generate',
    });
    await h.processorWith(provider).process(h.job(scene.id, third.id));

    const prompt = generate.mock.calls[1][0].prompt;
    expect(prompt).toContain('natal');
    expect(prompt).toContain(`${recorded} (pedido atual do cliente, que prevalece`);
    expect(prompt).toContain('sobre o anterior: gere outra imagem)');
    expect((await h.versionOf(third.id)).status).toBe('ready');
  });

  it('ajuste geral no meio, aplicado ou não, não devolve o tema à primeira geração (R39)', async () => {
    const { scene, version: first } = await h.readyScene();
    await insertMessage(h.dataSource, scene.id, { versionId: first.id, content: 'páscoa' });
    const { provider, generate } = h.fakeProvider(() => h.okResult());
    const second = await h.queueTurn(scene, {
      plan: { operation: 'new_image', instruction: 'gere outra imagem de natal' },
      request: 'Confirmar',
      operation: 'generate',
    });
    await h.processorWith(provider).process(h.job(scene.id, second.id));
    const recorded =
      'páscoa (pedido atual do cliente, que prevalece sobre o anterior: gere outra imagem de natal)';
    for (const [number, status] of [
      [3, 'ready'],
      [4, 'failed'],
    ] as const) {
      await insertVersion(h.dataSource, scene.id, {
        number,
        status,
        operation: 'generate',
        metrics: { globalInstruction: 'deixa mais quente' },
      });
    }

    const fifth = await h.queueTurn(await h.sceneOf(scene.id), {
      plan: { operation: 'new_image', instruction: 'gere outra imagem' },
      request: 'Confirmar',
      number: 5,
      operation: 'generate',
    });
    await h.processorWith(provider).process(h.job(scene.id, fifth.id));

    const prompt = generate.mock.calls[1][0].prompt;
    expect(prompt).toContain(`${recorded} (pedido atual do cliente, que prevalece`);
    expect(prompt).toContain('natal');
  });

  it('a primeira geração ignora a que falhou e grava o tema (R30)', async () => {
    const { scene, version: first } = await h.readyScene();
    await insertMessage(h.dataSource, scene.id, { versionId: first.id, content: 'páscoa' });
    const failed = await insertVersion(h.dataSource, scene.id, {
      number: 2,
      status: 'failed',
      operation: 'generate',
    });
    await insertMessage(h.dataSource, scene.id, { versionId: failed.id, content: 'natal' });
    const version = await h.queueTurn(scene, {
      plan: { operation: 'new_image', instruction: 'gere outra imagem' },
      request: 'Confirmar',
      number: 3,
      operation: 'generate',
    });
    const { provider, generate } = h.fakeProvider(() => h.okResult());

    await h.processorWith(provider).process(h.job(scene.id, version.id));

    expect(generate.mock.calls[0][0].prompt).toContain('páscoa');
    expect(generate.mock.calls[0][0].prompt).not.toContain('natal');
  });

  it('sem geração anterior em disco, o prompt leva a instrução do plano, nunca o texto do botão (R30)', async () => {
    const { scene } = await h.readyScene();
    const version = await h.queueTurn(scene, {
      plan: { operation: 'new_image', instruction: 'gere outra imagem de natal' },
      request: 'Confirmar',
      operation: 'generate',
    });
    const { provider, generate } = h.fakeProvider(() => h.okResult());

    await h.processorWith(provider).process(h.job(scene.id, version.id));

    const prompt = generate.mock.calls[0][0].prompt;
    expect(prompt).toContain('"gere outra imagem de natal"');
    expect(prompt).not.toContain('Confirmar');
  });
});
