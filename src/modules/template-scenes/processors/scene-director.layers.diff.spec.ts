import { SceneElement } from '../domain/scene.types';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { directorAnswer, useDirectorHarness } from '../testing/scene-director-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

const LOGO = (x: number): SceneElement => ({
  id: 'logo-1',
  kind: 'logo',
  name: 'Logo 1',
  x,
  y: 0.06,
  w: 0.3,
  aspect: 2,
  rotation: 0,
  z: 1,
  assetId: 'asset-x',
});

const layerPlan = (ops: Array<Record<string, unknown>>) => ({
  turn_kind: 'camada' as const,
  will_change_image: false,
  reply: 'Vou ajustar as camadas.',
  layer_ops: ops.map((op) => ({
    op: 'move',
    layer: null,
    text: null,
    position: null,
    replace: false,
    ...op,
  })) as never,
});

describeIfSceneDb(
  'Camadas pelo chat: onde, cor e resposta pela diferença (banco chroma_x_e2e)',
  () => {
    jest.setTimeout(60_000);
    const h = useDirectorHarness();
    const lastReply = async (sceneId: string) =>
      (await h.messagesOf(sceneId)).filter((m) => m.role === 'assistant').pop()?.content;

    /** Cena pronta com a camada dada na versão atual, e o turno de camada do Diretor. */
    async function turn(
      message: string,
      elements: SceneElement[],
      ops: Array<Record<string, unknown>>,
    ) {
      const { scene } = await h.readyScene();
      await h.dataSource.manager.update(
        TemplateSceneVersion,
        { id: scene.currentVersionId as string },
        { elements },
      );
      const sent = await h.post(scene.id, message);
      const { client } = h.directorClient(async () => directorAnswer(layerPlan(ops)));
      await h
        .directorProcessor(client)
        .process({ sceneId: scene.id, versionId: sent.versionId }, 'j');
      return { scene, version: await h.versionOf(sent.versionId) };
    }

    it('Texto em camada no lugar pedido: zona e lado do plano, cor por contraste com a master, resposta com o lugar', async () => {
      const { scene, version } = await turn(
        'coloca a frase "Promoção de Páscoa" como texto editável no rodapé à direita',
        [],
        [
          {
            op: 'set_text',
            text: { value: 'Promoção de Páscoa', placement: 'none' },
            position: { side: 'right', zone: 'footer' },
          },
        ],
      );
      expect(version.status).toBe('ready');
      const text = version.elements[0];
      expect(text).toMatchObject({ kind: 'text', text: 'Promoção de Páscoa' });
      expect(text.x).toBeCloseTo(0.66, 2);
      expect(text.y).toBeGreaterThan(0.85);
      // O rodapé da cena sintética é claro: a cor é a escura.
      expect(text.color).toBe('#1f1f1f');
      expect(await lastReply(scene.id)).toBe(
        'Coloquei a frase “Promoção de Páscoa” como camada de texto no rodapé, à direita. Dá para arrastar e mudar fonte e cor no quadro.',
      );
    });

    it('Camada que mudou: o chat diz o que foi feito e onde', async () => {
      const { scene, version } = await turn(
        'move a logo para a direita',
        [LOGO(0.2)],
        [{ layer: { kind: 'logo', name: null, side: 'right', direction: null } }],
      );
      expect(version.status).toBe('ready');
      expect(await lastReply(scene.id)).toBe('Movi a camada “Logo 1” para o cabeçalho, à direita.');
    });

    it('Camada que não mudou: nenhuma versão nasce, e o chat diz que já está lá', async () => {
      const { scene, version } = await turn(
        'move a logo para a direita',
        [LOGO(0.8)],
        [{ layer: { kind: 'logo', name: null, side: 'right', direction: null } }],
      );
      expect(version.status).toBe('rejected');
      expect(version.operation).not.toBe('set_layer');
      expect((await h.sceneOf(scene.id)).currentVersionId).not.toBe(version.id);
      expect(await lastReply(scene.id)).toBe(
        'A camada “Logo 1” já está no cabeçalho, à direita; nada mudou. Diga onde quer, ou arraste no quadro.',
      );
    });

    it('Logo e frase editável: as duas camadas e uma resposta que descreve as duas', async () => {
      const { scene, version } = await turn(
        'põe a frase "Ofertas" como texto editável',
        [LOGO(0.2)],
        [
          {
            op: 'set_text',
            text: { value: 'Ofertas', placement: 'bottom' },
            position: { side: 'left', zone: 'footer' },
          },
        ],
      );
      expect(version.elements.map((e) => e.kind)).toEqual(['logo', 'text']);
      expect(await lastReply(scene.id)).toContain(
        'Coloquei a frase “Ofertas” como camada de texto no rodapé, à esquerda.',
      );
    });

    it('Pintar a frase que é camada: o anúncio avisa que a camada de texto sai', async () => {
      const { scene } = await h.readyScene();
      await h.dataSource.manager.update(
        TemplateSceneVersion,
        { id: scene.currentVersionId as string },
        {
          elements: [
            { ...LOGO(0.5), id: 't1', kind: 'text', name: 'Texto 1', text: 'Promoção de Páscoa' },
          ],
        },
      );
      const sent = await h.post(
        scene.id,
        'eu queria um efeito como se tivesse sido escrito na madeira "Promoção de Páscoa"',
      );
      const { client } = h.directorClient(async () =>
        directorAnswer({
          turn_kind: 'pedido_item',
          will_change_image: true,
          reply: 'Vou pintar a frase “Promoção de Páscoa” na madeira da placa.',
          what_to_change: 'Paint the phrase on the wood',
          exact_text: ['Promoção de Páscoa'],
        }),
      );
      await h
        .directorProcessor(client)
        .process({ sceneId: scene.id, versionId: sent.versionId }, 'j');
      expect(await lastReply(scene.id)).toContain(
        'A frase vai ser pintada na imagem, e a camada de texto sai.',
      );
    });
  },
);
