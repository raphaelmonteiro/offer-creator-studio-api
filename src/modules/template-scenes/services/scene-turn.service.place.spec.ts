import { describeIfSceneDb } from '../testing/scene-test-db';
import { useTurnServiceHarness } from '../testing/scene-turn-service-harness';

const PHRASE = 'Adicione uma cesta de ovos no lugar da cerca removida';

describeIfSceneDb('SceneTurnService: "no lugar de X" no adicionar (banco chroma_x_e2e)', () => {
  const h = useTurnServiceHarness();

  it('No lugar de um item, sem área: pede para marcar onde, sem job e sem custo', async () => {
    const scene = await h.readyScene('Lugar sem área');

    const result = await h.send(scene.id, { content: PHRASE });

    expect(result).toMatchObject({ jobId: null, operation: 'needs_region' });
    expect(result.assistantMessage?.content).toBe(
      'Marque onde quer "cesta de ovos" e envie de novo. Nada foi alterado.',
    );
    expect(h.publish).not.toHaveBeenCalled();
    expect((await h.sceneOf(scene.id)).totalCostUsd).toBe(0);
  });

  it('No lugar de um item, com área: enfileira o adicionar com o assunto "cesta de ovos"', async () => {
    const scene = await h.readyScene('Lugar com área');

    const result = await h.send(scene.id, {
      content: PHRASE,
      region: { x: 0.1, y: 0.1, w: 0.3, h: 0.15 },
    });

    expect(result).toMatchObject({ operation: 'add_element', jobId: 'job-1' });
    const queued = (await h.versionsOf(scene.id))[1];
    expect(queued.metrics.plan).toMatchObject({
      operation: 'add_element',
      subject: 'cesta de ovos',
    });
  });
});
