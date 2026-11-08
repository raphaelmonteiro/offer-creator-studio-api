import { nativeSizeOfFormat } from '../domain/scene-format-size';
import { findSceneFormat } from '../domain/scene-formats';
import { SceneElement } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { directorPlan } from '../testing/scene-director-fixtures';
import { insertMessage, insertScene, insertVersion } from '../testing/scene-fixtures';
import { useProcessorHarness } from '../testing/scene-processor-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

const itemPlan = (change: string, extra: Partial<Parameters<typeof directorPlan>[0]> = {}) =>
  directorPlan({
    turn_kind: 'pedido_item',
    will_change_image: true,
    reply: 'Vou fazer.',
    what_to_change: change,
    inventory_keep: ['cesta de ovos'],
    ...extra,
  });

describeIfSceneDb('SceneRedrawHandler: itens em aberto no prompt (banco chroma_x_e2e)', () => {
  jest.setTimeout(120_000);
  const h = useProcessorHarness();
  afterEach(() => jest.restoreAllMocks());

  /** Cena no formato dado, com a versão 1 pronta e a master no tamanho nativo. */
  async function sceneOf(formatId: string, elements: SceneElement[] = []) {
    const format = findSceneFormat(formatId)!;
    const native = nativeSizeOfFormat(format)!;
    const ready = await h.readyScene({ width: native.width, height: native.height, elements });
    await h.dataSource.manager.update(
      TemplateScene,
      { id: ready.scene.id },
      {
        formatId,
        artWidthCm: format.artWidthCm,
        artHeightCm: format.artHeightCm,
      },
    );
    return { ...ready, scene: await h.sceneOf(ready.scene.id), native };
  }

  const FORMAT = 'folheto-27x40';

  async function insertSceneRow() {
    const scene = await insertScene(h.dataSource, { name: 'Primeira imagem' });
    h.trackScene(scene.id);
    return scene;
  }

  describe('Itens em aberto no prompt', () => {
    it('Imagem nova com item em aberto: o prompt traz a linha de pedidos em aberto logo depois do pedido', async () => {
      const { scene } = await sceneOf(FORMAT);
      await h.dataSource.manager.update(
        TemplateScene,
        { id: scene.id },
        {
          brief: [
            {
              id: 'p1',
              text: 'um rio no meio',
              status: 'open',
              sourceMessageId: 'm',
              updatedAt: 'x',
            },
          ],
        },
      );
      const queued = await h.queueRedraw(scene, {
        plan: directorPlan({
          turn_kind: 'imagem_nova',
          will_change_image: true,
          what_to_put: 'campo verde',
        }),
        request: 'gere outra imagem',
        operation: 'generate',
      });
      const { provider, generate } = h.fakeProvider(() => h.okResult());

      await h.processorWith(provider).process(h.job(scene.id, queued.id));

      const lines = generate.mock.calls[0][0].prompt.split('\n');
      expect(lines[1]).toBe('Pedido do cliente: "campo verde.".');
      expect(lines[2]).toBe('Pedidos do cliente ainda em aberto: um rio no meio.');
    });

    it('Uma mudança por rodada (D-54): a edição não leva a linha de pedidos em aberto', async () => {
      const { scene } = await sceneOf(FORMAT);
      await h.dataSource.manager.update(
        TemplateScene,
        { id: scene.id },
        {
          brief: [
            {
              id: 'p1',
              text: 'um rio no meio',
              status: 'open',
              sourceMessageId: 'm',
              updatedAt: 'x',
            },
            {
              id: 'p2',
              text: 'escreve FELIZ PASCOA',
              status: 'open',
              sourceMessageId: 'm',
              updatedAt: 'x',
            },
          ],
        },
      );
      const queued = await h.queueRedraw(scene, {
        plan: itemPlan('mais flores'),
        request: 'mais flores',
      });
      const { provider, edit } = h.fakeProvider(() => h.okResult());

      await h.processorWith(provider).process(h.job(scene.id, queued.id));

      const prompt = edit.mock.calls[0][0].prompt;
      expect(prompt).not.toContain('em aberto');
      expect(prompt).not.toContain('um rio no meio');
      expect((await h.sceneOf(scene.id)).brief).toHaveLength(2);
    });

    it('Primeira imagem: mesmo com o pedido da mensagem em aberto na lista, o prompt não traz a linha', async () => {
      const scene = await insertSceneRow();
      await h.dataSource.manager.update(
        TemplateScene,
        { id: scene.id },
        {
          brief: [
            { id: 'p1', text: 'campo verde', status: 'open', sourceMessageId: 'm', updatedAt: 'x' },
          ],
        },
      );
      const version = await insertVersion(h.dataSource, scene.id, {
        number: 1,
        status: 'queued',
        operation: 'generate',
        metrics: { plan: directorPlan({ turn_kind: 'imagem_nova', what_to_put: 'campo verde' }) },
      });
      await insertMessage(h.dataSource, scene.id, {
        versionId: version.id,
        content: 'campo verde',
      });
      const { provider, generate } = h.fakeProvider(() => h.okResult());

      await h.processorWith(provider).process(h.job(scene.id, version.id));

      expect(generate.mock.calls[0][0].prompt).not.toContain('em aberto');
    });

    it.each(['local_edit', 'add_element', 'set_layer'] as const)(
      'Job antigo na fila (%s): a versão fica failed e nenhuma chamada paga é feita',
      async (operation) => {
        const { scene } = await sceneOf(FORMAT);
        const queued = await h.queueRedraw(scene, {
          plan: itemPlan('mais flores'),
          request: 'mais flores',
          operation,
        });
        const { provider, edit, generate } = h.fakeProvider(() => h.okResult());

        await h.processorWith(provider).process(h.job(scene.id, queued.id));

        expect(edit).not.toHaveBeenCalled();
        expect(generate).not.toHaveBeenCalled();
        expect(await h.versionOf(queued.id)).toMatchObject({
          status: 'failed',
          errorCode: 'PROVIDER_ERROR',
          providerCostUsd: 0,
        });
      },
    );
  });
});
