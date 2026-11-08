import { DirectorPlan } from '../domain/scene-director-schema';
import { SceneElement } from '../domain/scene.types';
import { directorPlan } from '../testing/scene-director-fixtures';
import { directorAnswer, useDirectorHarness } from '../testing/scene-director-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { judgePromptOf, visionReadings } from '../testing/scene-vision-fake';
import { pointFace } from '../testing/scene-fixtures';

const PROMO = 'Promoção de Páscoa';
const OFERTA = 'Oferta de Páscoa';
const LOGO: SceneElement = {
  id: 'logo-1',
  kind: 'logo',
  name: 'Logo 1',
  x: 0.2,
  y: 0.06,
  w: 0.3,
  aspect: 2,
  rotation: 0,
  z: 1,
  assetId: 'asset-x',
};
const moveLogo = (): DirectorPlan['layer_ops'] => [
  {
    op: 'move',
    layer: { kind: 'logo', name: null, side: 'right', direction: null },
    text: null,
    position: null,
    replace: false,
  },
];

/** `metrics.paintedText` sobrevive às versões que não mudam a imagem (R66): camada pelo chat e desfazer. */
describeIfSceneDb('Texto pintado herdado por camada e desfazer (banco chroma_x_e2e)', () => {
  jest.setTimeout(60_000);
  const h = useDirectorHarness();

  const paint = (versionId: string, lines: unknown[]) =>
    h.dataSource.manager.update(
      'template_scene_versions',
      { id: versionId },
      { metrics: { paintedText: lines } },
    );

  it('Texto pintado sobrevive à camada: a versão da camada copia o campo, e o pedido seguinte mantém e confere a frase', async () => {
    const { scene, version: v1 } = await h.readyScene({ elements: [LOGO] });
    await paint(v1.id, [{ text: PROMO, zone: 'footer' }]);
    const sent = await h.post(scene.id, 'passa a logo para a direita');
    const { client } = h.directorClient(async () =>
      directorAnswer(directorPlan({ turn_kind: 'camada', layer_ops: moveLogo() })),
    );
    await h.directorProcessor(client).process({ sceneId: scene.id, versionId: sent.versionId });

    const layered = await h.versionOf(sent.versionId);
    expect(layered).toMatchObject({ operation: 'set_layer', status: 'ready' });
    expect(layered.metrics.paintedText).toEqual([{ text: PROMO, zone: 'footer' }]);
    expect(layered.metrics.layer).toBeDefined();

    const judge = visionReadings([[{ pedido: PROMO, lido: PROMO }]]);
    const queued = await h.queueRedraw(await h.sceneOf(scene.id), {
      plan: directorPlan({
        turn_kind: 'pedido_item',
        will_change_image: true,
        what_to_change: 'Add more daisies near the bottom',
      }),
      request: 'coloca mais margaridas no rodapé',
      number: 3,
    });
    const { provider, edit } = h.fakeProvider(() => h.okResult(0.1));
    await h.processorWith(provider, undefined, judge.client).process(h.job(scene.id, queued.id));
    const prompt = edit.mock.calls[0][0].prompt;
    expect(prompt).toContain(`Line 1: “${PROMO}”`);
    expect(prompt).not.toContain('No text, no letters');
    expect(judgePromptOf(judge.compare)).toContain(PROMO);
    expect((await h.versionOf(queued.id)).metrics.paintedText).toEqual([
      { text: PROMO, zone: 'footer' },
    ]);
  });

  it('versão sem texto pintado não ganha o campo na camada', async () => {
    const { scene } = await h.readyScene({ elements: [LOGO] });
    const sent = await h.post(scene.id, 'passa a logo para a direita');
    const { client } = h.directorClient(async () =>
      directorAnswer(directorPlan({ turn_kind: 'camada', layer_ops: moveLogo() })),
    );
    await h.directorProcessor(client).process({ sceneId: scene.id, versionId: sent.versionId });
    expect((await h.versionOf(sent.versionId)).metrics.paintedText).toBeUndefined();
  });

  it('Texto pintado volta com o desfazer: a versão restaurada copia o campo da versão de origem', async () => {
    const first = await h.readyScene();
    const v2 = await h.readyVersionLike(first.scene, 2, first.version.id);
    await pointFace(h.dataSource, first.scene, v2.version.id);
    await paint(first.version.id, [{ text: PROMO, zone: 'footer' }]);
    await paint(v2.version.id, [{ text: OFERTA, zone: 'footer' }]);

    const sent = await h.post(first.scene.id, 'volta');
    const { client } = h.directorClient(async () =>
      directorAnswer(directorPlan({ turn_kind: 'desfazer', undo_target: 'previous' })),
    );
    await h
      .directorProcessor(client)
      .process({ sceneId: first.scene.id, versionId: sent.versionId });

    const restored = await h.versionOf(sent.versionId);
    expect(restored).toMatchObject({ operation: 'restore', parentVersionId: first.version.id });
    expect(restored.metrics.paintedText).toEqual([{ text: PROMO, zone: 'footer' }]);
  });
});
