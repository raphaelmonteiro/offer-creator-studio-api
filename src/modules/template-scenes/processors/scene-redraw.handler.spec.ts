import * as fs from 'fs/promises';
import * as sharp from 'sharp';
import { nativeSizeOfFormat } from '../domain/scene-format-size';
import { findSceneFormat, SCENE_FORMAT_IDS } from '../domain/scene-formats';
import { SceneElement } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset as TemplateSceneAssetEntity } from '../entities/template-scene-asset.entity';
import { directorPlan } from '../testing/scene-director-fixtures';
import { insertMessage } from '../testing/scene-fixtures';
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

describeIfSceneDb('SceneRedrawHandler: o redesenho da imagem inteira (banco chroma_x_e2e)', () => {
  jest.setTimeout(120_000);
  const h = useProcessorHarness();
  afterEach(() => jest.restoreAllMocks());

  const storedMaster = async (versionId: string) => {
    const version = await h.versionOf(versionId);
    const asset = await h.dataSource.manager.findOneByOrFail(TemplateSceneAssetEntity, {
      id: version.masterAssetId as string,
    });
    return fs.readFile(h.files.absolutePath(asset.url));
  };

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

  describe.each(SCENE_FORMAT_IDS)('formato %s', (formatId) => {
    it('Pedido sem marcação: o provedor recebe a master inteira no tamanho nativo e nenhum markup', async () => {
      const { scene, version: v1, native } = await sceneOf(formatId);
      const queued = await h.queueRedraw(scene, {
        plan: itemPlan('tirar o coelho da direita do rodapé'),
        request: 'tira o coelho da direita do rodapé',
      });
      const { provider, edit, generate } = h.fakeProvider(() => h.okResult());

      await h.processorWith(provider).process(h.job(scene.id, queued.id));

      expect(edit).toHaveBeenCalledTimes(1);
      expect(generate).not.toHaveBeenCalled();
      const input = edit.mock.calls[0][0];
      expect(input.size).toBe(`${native.width}x${native.height}`);
      expect(input.model).toBe('gpt-image-2.6-sunburst');
      expect(input).not.toHaveProperty('markup');
      expect(input).not.toHaveProperty('mask');
      expect(Buffer.compare(input.image, await storedMaster(v1.id))).toBe(0);
      expect(input.prompt).toContain(
        'Make exactly one change: tirar o coelho da direita do rodapé.',
      );
      expect(input.prompt.startsWith('Edit the provided image.\n')).toBe(true);
      expect(input.prompt.endsWith('No text, no letters, no numbers, no logo, no watermark.')).toBe(
        true,
      );
      const done = await h.versionOf(queued.id);
      expect(done).toMatchObject({ status: 'ready', operation: 'redraw', parentVersionId: v1.id });
      const meta = await sharp(await storedMaster(queued.id)).metadata();
      expect([meta.width, meta.height]).toEqual([native.width, native.height]);
      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(queued.id);
    });

    it('Pedido com marcação: a master inteira e um markup do mesmo tamanho, transparente, sem mask', async () => {
      const { scene, version: v1, native } = await sceneOf(formatId);
      const queued = await h.queueRedraw(scene, {
        plan: itemPlan('tirar esse coelho'),
        request: 'tira esse coelho',
        overrides: { requestedRegion: { x: 0.3, y: 0.4, w: 0.2, h: 0.1 } },
      });
      const { provider, edit } = h.fakeProvider(() => h.okResult());

      await h.processorWith(provider).process(h.job(scene.id, queued.id));

      const input = edit.mock.calls[0][0];
      expect(Buffer.compare(input.image, await storedMaster(v1.id))).toBe(0);
      const markup = await sharp(input.markup as Buffer).metadata();
      expect([markup.width, markup.height, markup.hasAlpha]).toEqual([
        native.width,
        native.height,
        true,
      ]);
      expect(input).not.toHaveProperty('mask');
      expect(
        input.prompt.startsWith('Edit the provided image. The red outline on the markup layer'),
      ).toBe(true);
      expect(input.prompt).toContain('do not draw it');
      expect(input.prompt).toContain('Make the change only inside the outlined area.');
      const done = await h.versionOf(queued.id);
      expect(done.metrics.markup).toMatchObject({ kind: 'retângulo' });
      expect(done.requestedRegion).toMatchObject({ x: 0.3, y: 0.4 });
    });

    it('Imagem nova: o provedor recebe generate, sem imagem de referência, no tamanho nativo', async () => {
      const { scene, version: v1, native } = await sceneOf(formatId);
      const queued = await h.queueRedraw(scene, {
        plan: directorPlan({
          turn_kind: 'imagem_nova',
          will_change_image: true,
          what_to_put: 'campo verde com sol',
        }),
        request: 'gere outra imagem',
        operation: 'generate',
      });
      const { provider, edit, generate } = h.fakeProvider(() => h.okResult());

      await h.processorWith(provider).process(h.job(scene.id, queued.id));

      expect(edit).not.toHaveBeenCalled();
      expect(generate).toHaveBeenCalledTimes(1);
      const input = generate.mock.calls[0][0];
      expect(input).not.toHaveProperty('image');
      expect(input).not.toHaveProperty('markup');
      expect(input.size).toBe(`${native.width}x${native.height}`);
      expect(input.prompt).toContain(`imagem de ${native.width} x ${native.height} px`);
      const done = await h.versionOf(queued.id);
      expect(done).toMatchObject({
        status: 'ready',
        operation: 'generate',
        parentVersionId: v1.id,
      });
    });
  });

  describe('Frase de continuidade no formato alto (D-43)', () => {
    const TALL = 'folheto-27x54';
    const PHRASE = 'The scene is one continuous environment from top to bottom';

    it.each([
      ['pedido_composicao', true],
      ['pedido_ajuste_geral', false],
      ['pedido_item', false],
    ] as const)(
      '%s no formato alto: o prompt enviado ao provedor traz a frase? %s',
      async (kind, expected) => {
        const { scene } = await sceneOf(TALL);
        const queued = await h.queueRedraw(scene, {
          plan: itemPlan('mudar', { turn_kind: kind }),
          request: 'muda isso',
        });
        const { provider, edit } = h.fakeProvider(() => h.okResult());

        await h.processorWith(provider).process(h.job(scene.id, queued.id));

        expect(edit.mock.calls[0][0].prompt.includes(PHRASE)).toBe(expected);
      },
    );

    it('Composição quando o cliente pediu divisão antes: a frase sai', async () => {
      const { scene } = await sceneOf(TALL);
      await insertMessage(h.dataSource, scene.id, { content: 'divide em duas partes' });
      const queued = await h.queueRedraw(scene, {
        plan: itemPlan('reorganizar', { turn_kind: 'pedido_composicao' }),
        request: 'reorganiza tudo',
      });
      const { provider, edit } = h.fakeProvider(() => h.okResult());

      await h.processorWith(provider).process(h.job(scene.id, queued.id));

      expect(edit.mock.calls[0][0].prompt).not.toContain(PHRASE);
    });
  });
});
