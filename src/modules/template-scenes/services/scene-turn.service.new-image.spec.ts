import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { errorOf } from '../testing/scene-test-helpers';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { useTurnServiceHarness } from '../testing/scene-turn-service-harness';

describeIfSceneDb('SceneTurnService: imagem nova do zero, D-18 (banco chroma_x_e2e)', () => {
  const h = useTurnServiceHarness();

  it('Gere outra imagem: pergunta sem job, com o custo, versão rejected e custo da cena intacto', async () => {
    const scene = await h.readyScene('Nova imagem pergunta');

    const asked = await h.send(scene.id, { content: 'gere uma segunda imagem' });

    expect(asked).toMatchObject({ jobId: null, operation: 'needs_confirmation_new_image' });
    expect(asked.assistantMessage?.content).toContain('US$ 0,13');
    expect(h.publish).not.toHaveBeenCalled();
    const versions = await h.versionsOf(scene.id);
    expect(versions[1]).toMatchObject({ status: 'rejected', operation: 'generate' });
    expect(versions[1].metrics.pendingConfirmation).toMatchObject({
      request: 'gere uma segunda imagem',
      kind: 'new_image',
    });
    expect((await h.sceneOf(scene.id)).totalCostUsd).toBe(0);
  });

  it('"quero que mude tudo" também pergunta; "deixa tudo mais quente" continua sendo o ajuste geral', async () => {
    const scene = await h.readyScene('Nova imagem mude tudo');
    const asked = await h.send(scene.id, { content: 'quero que mude tudo' });
    expect(asked.operation).toBe('needs_confirmation_new_image');
    const global = await h.send(scene.id, { content: 'deixa tudo mais quente' }, asked.revision);
    expect(global.operation).toBe('needs_confirmation_global');
  });

  it('Confirmar a imagem nova: enfileira a geração com o pedido original, na versão filha da atual', async () => {
    const scene = await h.readyScene('Nova imagem confirma');
    const asked = await h.send(scene.id, { content: 'gere outra imagem' });

    const confirmed = await h.send(
      scene.id,
      { content: 'Confirmar', confirmGlobal: true, replyToMessageId: asked.assistantMessage!.id },
      asked.revision,
    );

    expect(confirmed).toMatchObject({ operation: 'new_image', jobId: 'job-1' });
    const queued = (await h.versionsOf(scene.id))[2] as TemplateSceneVersion;
    expect(queued).toMatchObject({
      status: 'queued',
      operation: 'generate',
      parentVersionId: scene.currentVersionId,
    });
    expect(queued.metrics.plan).toMatchObject({
      operation: 'new_image',
      instruction: 'gere outra imagem',
    });
  });

  it('Cancelar ou repetir a imagem nova: repetir dá 409 CONFIRMATION_NOT_PENDING e não duplica o job', async () => {
    const scene = await h.readyScene('Nova imagem repete');
    const asked = await h.send(scene.id, { content: 'gere outra imagem' });
    const confirm = (revision: number) =>
      h.send(
        scene.id,
        { content: 'sim', confirmGlobal: true, replyToMessageId: asked.assistantMessage!.id },
        revision,
      );
    const first = await confirm(asked.revision);
    await h.dataSource.manager.update(
      TemplateSceneVersion,
      { id: first.versionId },
      { status: 'failed' },
    );

    expect(await errorOf(confirm(first.revision))).toEqual({
      status: 409,
      code: 'CONFIRMATION_NOT_PENDING',
    });
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('Pedido de imagem nova com área marcada: a marcação manda e vira edição local', async () => {
    const scene = await h.readyScene('Nova imagem com área');
    const result = await h.send(scene.id, {
      content: 'gere outra imagem',
      region: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 },
    });
    expect(result).toMatchObject({ operation: 'local_edit', jobId: 'job-1' });
  });
});
