import {
  directorAnswer,
  DIRECTOR_CALL_COST,
  useDirectorHarness,
} from '../testing/scene-director-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

describeIfSceneDb('Exceção depois do Diretor não perde o custo (R13, banco chroma_x_e2e)', () => {
  const h = useDirectorHarness();

  it('publish do job de imagem falha: a versão fica failed DIRECTOR_UNAVAILABLE e o custo do Diretor fica na versão e na cena', async () => {
    const { scene } = await h.readyScene();
    const before = (await h.sceneOf(scene.id)).totalCostUsd;
    const sent = await h.post(scene.id, 'tira o coelho');
    const { client } = h.directorClient(async () =>
      directorAnswer({
        turn_kind: 'pedido_item',
        will_change_image: true,
        reply: 'Vou tirar o coelho.',
        what_to_change: 'tirar o coelho',
      }),
    );
    h.queue.publish.mockReset();
    h.queue.publish.mockRejectedValue(new Error('fila fora do ar'));

    await h.directorProcessor(client).process({ sceneId: scene.id, versionId: sent.versionId });

    const version = await h.versionOf(sent.versionId);
    expect(version).toMatchObject({ status: 'failed', errorCode: 'DIRECTOR_UNAVAILABLE' });
    expect(version.providerCostUsd).toBeCloseTo(DIRECTOR_CALL_COST, 6);
    expect((await h.sceneOf(scene.id)).totalCostUsd - before).toBeCloseTo(DIRECTOR_CALL_COST, 6);
    expect(version.metrics.director).toMatchObject({ costUsd: DIRECTOR_CALL_COST });
  });
});
