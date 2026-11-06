import * as fs from 'fs/promises';
import * as sharp from 'sharp';
import { nativeSizeOfFormat } from '../domain/scene-format-size';
import { findSceneFormat, SCENE_FORMAT_IDS } from '../domain/scene-formats';
import { SceneElement } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset as TemplateSceneAssetEntity } from '../entities/template-scene-asset.entity';
import { directorPlan } from '../testing/scene-director-fixtures';
import { insertMessage, insertScene, insertVersion } from '../testing/scene-fixtures';
import { useProcessorHarness } from '../testing/scene-processor-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

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
};
const TEXT: SceneElement = {
  id: 'text-1',
  kind: 'text',
  name: 'Texto 1',
  x: 0.5,
  y: 0.95,
  w: 0.6,
  aspect: 6,
  rotation: 0,
  z: 2,
  text: 'Ofertas da semana',
};

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
      expect(input.prompt.startsWith('Nesta imagem: tirar o coelho da direita do rodapé.')).toBe(
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
      expect(input.prompt.startsWith('Dentro do retângulo da camada de marcação:')).toBe(true);
      expect(input.prompt).toContain('não deixe o retângulo no resultado');
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

  describe('um formato, os demais cenários', () => {
    const FORMAT = 'folheto-27x40';

    it.each([
      ['Mover um item', 'trocar o sol de lado, para a esquerda', 'troca o sol de lado'],
      [
        'Adicionar um item',
        'adicionar um passarinho na árvore rosa',
        'coloca um passarinho na arvore rosa',
      ],
      [
        'Zona citada sem marcação',
        'adicionar um balão no cabeçalho',
        'adiciona um balão no cabeçalho',
      ],
    ])(
      '%s: segue como redesenho, sem markup, sem elemento novo e sem PNG transparente',
      async (_name, change, request) => {
        const { scene } = await sceneOf(FORMAT, [LOGO, TEXT]);
        const queued = await h.queueRedraw(scene, { plan: itemPlan(change), request });
        const { provider, edit } = h.fakeProvider(() => h.okResult());

        await h.processorWith(provider).process(h.job(scene.id, queued.id));

        expect(edit).toHaveBeenCalledTimes(1);
        expect(edit.mock.calls[0][0]).not.toHaveProperty('markup');
        const done = await h.versionOf(queued.id);
        expect(done.elements).toEqual([LOGO, TEXT]);
        expect(done.status).toBe('ready');
      },
    );

    it('Adicionar com marcação: a master inteira e o markup, sem elemento novo', async () => {
      const { scene } = await sceneOf(FORMAT, [LOGO]);
      const queued = await h.queueRedraw(scene, {
        plan: itemPlan('adicionar um balão na área marcada'),
        request: 'adiciona um balão aqui',
        overrides: {
          requestedMask: {
            kind: 'lasso',
            points: [
              { x: 0.3, y: 0.3 },
              { x: 0.5, y: 0.3 },
              { x: 0.4, y: 0.5 },
            ],
          },
          requestedRegion: { x: 0.3, y: 0.3, w: 0.2, h: 0.2 },
        },
      });
      const { provider, edit } = h.fakeProvider(() => h.okResult());

      await h.processorWith(provider).process(h.job(scene.id, queued.id));

      expect(edit.mock.calls[0][0].markup).toBeDefined();
      const done = await h.versionOf(queued.id);
      expect(done.elements).toEqual([LOGO]);
      expect(done.metrics.markup).toMatchObject({ kind: 'laço' });
      expect(done.requestedMask).toMatchObject({ kind: 'lasso' });
    });

    it('Base depois de restaurar: o provedor recebe a master restaurada, que é a atual', async () => {
      const { scene, version: v1 } = await sceneOf(FORMAT);
      const second = await h.readyVersionLike(
        scene,
        2,
        v1.id,
        await sharp({
          create: { width: scene.widthPx, height: scene.heightPx, channels: 3, background: '#a33' },
        })
          .png()
          .toBuffer(),
      );
      const restored = await insertVersion(h.dataSource, scene.id, {
        number: 3,
        operation: 'restore',
        status: 'ready',
        parentVersionId: v1.id,
        masterAssetId: v1.masterAssetId,
        previewAssetId: v1.previewAssetId,
      });
      scene.currentVersionId = restored.id;
      await h.dataSource.manager.save(scene);
      const queued = await h.queueRedraw(scene, {
        plan: itemPlan('mais flores'),
        request: 'mais flores',
        number: 4,
      });
      const { provider, edit } = h.fakeProvider(() => h.okResult());

      await h.processorWith(provider).process(h.job(scene.id, queued.id));

      const sent = edit.mock.calls[0][0].image;
      expect(Buffer.compare(sent, await storedMaster(v1.id))).toBe(0);
      expect(Buffer.compare(sent, await storedMaster(second.version.id))).not.toBe(0);
    });

    it('Camadas no redesenho: logo e texto têm a mesma posição e o mesmo conteúdo, e o modelo recebe só a master', async () => {
      const { scene, version: v1 } = await sceneOf(FORMAT, [LOGO, TEXT]);
      const queued = await h.queueRedraw(scene, {
        plan: itemPlan('mais flores'),
        request: 'mais flores',
      });
      const { provider, edit } = h.fakeProvider(() => h.okResult());

      await h.processorWith(provider).process(h.job(scene.id, queued.id));

      const done = await h.versionOf(queued.id);
      expect(done.elements).toEqual([LOGO, TEXT]);
      expect(done.elements).not.toBe(v1.elements);
      // a imagem enviada é exatamente a master: nada das camadas é compositado nela
      expect(Buffer.compare(edit.mock.calls[0][0].image, await storedMaster(v1.id))).toBe(0);
      expect(edit.mock.calls[0][0].prompt).not.toContain('Ofertas da semana');
    });

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

    it('Item em aberto com conteúdo pintado: o prompt leva o rio e não leva "escreve FELIZ PASCOA"', async () => {
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
      expect(prompt).toContain('Pedidos do cliente ainda em aberto: um rio no meio.');
      expect(prompt).not.toContain('FELIZ');
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

    it('versão sem plano do Diretor: falha sem chamada paga', async () => {
      const { scene } = await sceneOf(FORMAT);
      const queued = await insertVersion(h.dataSource, scene.id, {
        number: 2,
        status: 'queued',
        operation: 'redraw',
        parentVersionId: scene.currentVersionId,
      });
      const { provider, edit } = h.fakeProvider(() => h.okResult());
      await h.processorWith(provider).process(h.job(scene.id, queued.id));
      expect(edit).not.toHaveBeenCalled();
      expect((await h.versionOf(queued.id)).status).toBe('failed');
    });

    it('master da versão atual apagada: falha sem chamada paga', async () => {
      const { scene, masterAsset } = await sceneOf(FORMAT);
      await h.dataSource.query(
        `UPDATE template_scene_assets SET "purgedAt" = now() WHERE id = $1`,
        [masterAsset.id],
      );
      const queued = await h.queueRedraw(scene, {
        plan: itemPlan('mais flores'),
        request: 'mais flores',
      });
      const { provider, edit } = h.fakeProvider(() => h.okResult());
      await h.processorWith(provider).process(h.job(scene.id, queued.id));
      expect(edit).not.toHaveBeenCalled();
      expect((await h.versionOf(queued.id)).errorCode).toBe('PROVIDER_ERROR');
    });
  });

  async function insertSceneRow() {
    const scene = await insertScene(h.dataSource, { name: 'Primeira imagem' });
    h.trackScene(scene.id);
    return scene;
  }
});
