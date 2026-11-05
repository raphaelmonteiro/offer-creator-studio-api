import * as sharp from 'sharp';
import { loadRgb } from '../../../shared/image/rgb';
import { SceneElement } from '../domain/scene.types';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import * as retention from '../services/scene-retention';
import { insertAsset } from '../testing/scene-fixtures';
import { useProcessorHarness } from '../testing/scene-processor-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

const logoEl: SceneElement = {
  id: 'logo-1',
  kind: 'logo',
  name: 'Logo 1',
  x: 0.2,
  y: 0.05,
  w: 0.3,
  aspect: 2,
  rotation: 0,
  z: 1,
  assetId: 'a1',
};
const textEl: SceneElement = {
  id: 'text-1',
  kind: 'text',
  name: 'Texto 1',
  x: 0.5,
  y: 0.9,
  w: 0.6,
  aspect: 5,
  rotation: 0,
  z: 2,
  text: 'Páscoa',
  fontSize: 7,
  color: '#fff',
};
const genEl: SceneElement = {
  id: 'gen-1',
  kind: 'generated',
  name: 'Balão',
  x: 0.7,
  y: 0.4,
  w: 0.2,
  aspect: 1,
  rotation: 0,
  z: 3,
  assetId: 'a2',
};

describeIfSceneDb(
  'SceneTurnProcessor: ajuste geral, camadas e adicionar (banco chroma_x_e2e)',
  () => {
    jest.setTimeout(60_000);
    const h = useProcessorHarness();
    afterEach(() => jest.restoreAllMocks());

    const lastReply = async (sceneId: string) => {
      const messages = await h.messagesOf(sceneId);
      return messages[messages.length - 1].content;
    };
    const noModelCalls = () => {
      const fake = h.fakeProvider(() => h.okResult());
      return {
        ...fake,
        total: () =>
          fake.generate.mock.calls.length +
          fake.edit.mock.calls.length +
          fake.generateTransparent.mock.calls.length,
      };
    };

    describe('ajuste geral confirmado (global_regenerate)', () => {
      const globalPlan = {
        operation: 'global_regenerate' as const,
        instruction: 'deixa tudo mais quente',
      };

      it('edita a master inteira sem máscara, no tamanho nativo, e logo, texto e elementos ficam como estavam', async () => {
        const { scene, master } = await h.readyScene({ elements: [logoEl, textEl, genEl] });
        const version = await h.queueTurn(scene, {
          plan: globalPlan,
          request: 'Confirmar',
          operation: 'generate',
        });
        const real = h.mock();
        const { provider, edit } = h.fakeProvider(() => h.okResult(), {
          edit: async (input) => ({ ...(await real.edit(input)), costUsd: 0.14 }),
        });
        const prune = jest.spyOn(retention, 'pruneSceneAssets');

        await h.processorWith(provider).process(h.job(scene.id, version.id));

        const input = edit.mock.calls[0][0];
        expect(input.mask).toBeUndefined();
        expect(input.size).toBe('1024x2048');
        expect(input.prompt).toContain('"deixa tudo mais quente"');
        expect(input.prompt).toContain('Mantenha a composição');
        const done = await h.versionOf(version.id);
        expect(done).toMatchObject({
          status: 'ready',
          operation: 'generate',
          parentVersionId: scene.currentVersionId,
        });
        expect(done.elements).toEqual([logoEl, textEl, genEl]);
        expect(done.metrics.calls).toEqual([
          expect.objectContaining({ kind: 'edit', costUsd: 0.14 }),
          expect.objectContaining({ kind: 'vision' }),
        ]);
        expect(done.masterAssetId).not.toBe(version.parentVersionId);
        const after = await loadRgb(
          await sharp(
            h.files.absolutePath(
              (
                await h.dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
                  id: done.masterAssetId as string,
                })
              ).url,
            ),
          )
            .png()
            .toBuffer(),
        );
        const before = await loadRgb(master);
        expect(Buffer.from(after.data).equals(Buffer.from(before.data))).toBe(false);
        expect(prune).toHaveBeenCalledTimes(1);
        expect((await h.sceneOf(scene.id)).currentVersionId).toBe(version.id);
        expect(await lastReply(scene.id)).toContain('Logo e texto não mudaram');
      });

      it('registra a opção de reposicionar os elementos adicionados, que nunca são regenerados', async () => {
        const { scene } = await h.readyScene({ elements: [genEl] });
        const version = await h.queueTurn(scene, {
          plan: globalPlan,
          request: 'Confirmar',
          operation: 'generate',
          overrides: { metrics: { plan: globalPlan, repositionGenerated: true } },
        });
        await h.processorWith(h.mock()).process(h.job(scene.id, version.id));
        const done = await h.versionOf(version.id);
        expect(done.metrics.repositionGenerated).toBe(true);
        expect(done.elements).toEqual([genEl]);
      });

      it('limite antes da chamada de imagem: PAID_CALL_LIMIT e nada é chamado', async () => {
        const { scene } = await h.readyScene();
        const version = await h.queueTurn(scene, {
          plan: globalPlan,
          request: 'Confirmar',
          operation: 'generate',
          overrides: {
            metrics: {
              plan: globalPlan,
              calls: [
                {
                  id: 'c0',
                  kind: 'edit',
                  status: 'done',
                  model: 'm',
                  size: '1x1',
                  startedAt: new Date().toISOString(),
                  costUsd: 0.14,
                },
              ],
            },
          },
        });
        const fake = noModelCalls();
        await h
          .processorWith(fake.provider, { TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE: '1' })
          .process(h.job(scene.id, version.id));
        expect(fake.total()).toBe(0);
        expect(await h.versionOf(version.id)).toMatchObject({
          status: 'failed',
          errorCode: 'PAID_CALL_LIMIT',
        });
      });

      it('limite 1 e nada gravado (PV-8): a imagem roda, a visão é pulada, a versão fica ready e o custo é só o da edição', async () => {
        const { scene } = await h.readyScene({ elements: [genEl] });
        const version = await h.queueTurn(scene, {
          plan: globalPlan,
          request: 'Confirmar',
          operation: 'generate',
        });
        const real = h.mock();
        const { provider, edit } = h.fakeProvider(() => h.okResult(), {
          edit: async (input) => ({ ...(await real.edit(input)), costUsd: 0.14 }),
        });
        const vision = { compare: jest.fn() };

        await h
          .processorWith(provider, { TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE: '1' }, vision)
          .process(h.job(scene.id, version.id));

        expect(edit).toHaveBeenCalledTimes(1);
        expect(vision.compare).not.toHaveBeenCalled();
        const done = await h.versionOf(version.id);
        expect(done).toMatchObject({ status: 'ready', errorCode: null, providerCostUsd: 0.14 });
        expect(done.metrics.calls).toEqual([expect.objectContaining({ kind: 'edit' })]);
        expect(await lastReply(scene.id)).toContain('Criei uma nova versão do fundo');
      });
    });

    describe('set_layer pelo chat (sem modelo)', () => {
      it('logo e frase: camadas nas posições pedidas, custo 0, mesma master, sem chamar o provedor', async () => {
        const { scene, masterAsset, previewAsset } = await h.readyScene();
        const logo = await insertAsset(
          h.dataSource,
          { id: scene.currentVersionId as string, sceneId: scene.id },
          'logo',
          { width: 600, height: 300 },
        );
        const plan = {
          operation: 'set_layer' as const,
          actions: [
            {
              type: 'add_logo' as const,
              assetId: logo.id,
              side: 'left' as const,
              zone: 'header' as const,
            },
            {
              type: 'set_text' as const,
              text: 'Ofertas da semana',
              placement: 'below-logo' as const,
              replace: false,
            },
          ],
        };
        const version = await h.queueTurn(scene, {
          plan,
          request:
            'coloca a logo à esquerda no cabeçalho e escreve "Ofertas da semana" embaixo dela',
          attachments: [{ assetId: logo.id }],
        });
        const fake = noModelCalls();
        const prune = jest.spyOn(retention, 'pruneSceneAssets');

        await h.processorWith(fake.provider).process(h.job(scene.id, version.id));

        expect(fake.total()).toBe(0);
        const done = await h.versionOf(version.id);
        expect(done).toMatchObject({
          status: 'ready',
          operation: 'set_layer',
          providerCostUsd: 0,
          masterAssetId: masterAsset.id,
          previewAssetId: previewAsset.id,
        });
        expect(done.elements.map((e) => [e.kind, e.assetId ?? e.text])).toEqual([
          ['logo', logo.id],
          ['text', 'Ofertas da semana'],
        ]);
        expect(done.elements[1].x).toBeCloseTo(done.elements[0].x);
        expect(done.elements[1].y).toBeGreaterThan(done.elements[0].y);
        expect((await h.sceneOf(scene.id)).totalCostUsd).toBe(0);
        expect(prune).toHaveBeenCalledTimes(1);
        expect(await lastReply(scene.id)).toContain('Alterado apenas');
      });

      it('mover a logo para a direita: a versão é set_layer e o resto da cena não muda', async () => {
        const { scene } = await h.readyScene({ elements: [logoEl, textEl] });
        const plan = {
          operation: 'set_layer' as const,
          actions: [
            { type: 'move' as const, target: { kind: 'logo' as const }, side: 'right' as const },
          ],
        };
        const version = await h.queueTurn(scene, { plan, request: 'passa a logo para a direita' });
        const fake = noModelCalls();

        await h.processorWith(fake.provider).process(h.job(scene.id, version.id));

        const done = await h.versionOf(version.id);
        expect(done.status).toBe('ready');
        expect(done.elements[0].x).toBeCloseTo(0.8);
        expect(done.elements[1]).toEqual(textEl);
        expect(fake.total()).toBe(0);
      });

      it('alvo que não existe: versão rejected com a resposta, sem custo', async () => {
        const { scene } = await h.readyScene();
        const plan = {
          operation: 'set_layer' as const,
          actions: [
            { type: 'move' as const, target: { kind: 'logo' as const }, side: 'right' as const },
          ],
        };
        const version = await h.queueTurn(scene, { plan, request: 'passa a logo para a direita' });
        await h.processorWith(noModelCalls().provider).process(h.job(scene.id, version.id));
        expect(await h.versionOf(version.id)).toMatchObject({
          status: 'rejected',
          providerCostUsd: 0,
        });
        expect(await lastReply(scene.id)).toContain('Não encontrei a logo');
        expect((await h.sceneOf(scene.id)).currentVersionId).toBe(scene.currentVersionId);
      });
    });

    describe('adicionar (PNG transparente)', () => {
      const addPlan = (
        target: { kind: 'rect'; rect: { x: number; y: number; w: number; h: number } } | null,
      ) => ({
        operation: 'add_element' as const,
        subject: 'balão de ar quente',
        target,
      });

      it('cria um elemento generated com o PNG recortado na área marcada; o fundo não muda', async () => {
        const { scene, masterAsset } = await h.readyScene({ elements: [logoEl] });
        const rect = { x: 0.1, y: 0.1, w: 0.3, h: 0.15 };
        const version = await h.queueTurn(scene, {
          plan: addPlan({ kind: 'rect', rect }),
          request: 'adiciona um balão de ar quente',
          operation: 'add_element',
        });
        const real = h.mock();
        const { provider, generateTransparent } = h.fakeProvider(() => h.okResult(), {
          transparent: async (input) => ({
            ...(await real.generateTransparent(input)),
            costUsd: 0.09,
          }),
        });
        const prune = jest.spyOn(retention, 'pruneSceneAssets');

        await h.processorWith(provider).process(h.job(scene.id, version.id));

        expect(generateTransparent.mock.calls[0][0]).toMatchObject({ size: '1024x1024' });
        expect(generateTransparent.mock.calls[0][0].prompt).toContain('balão de ar quente');
        const done = await h.versionOf(version.id);
        expect(done).toMatchObject({
          status: 'ready',
          operation: 'add_element',
          masterAssetId: masterAsset.id,
          providerCostUsd: 0.09,
        });
        expect(done.metrics.calls).toEqual([
          expect.objectContaining({ kind: 'transparent', costUsd: 0.09 }),
        ]);
        const added = done.elements.find((e) => e.kind === 'generated') as SceneElement;
        expect(done.elements).toHaveLength(2);
        expect(added.name).toBe('Balão de ar quente');
        expect(added.x).toBeCloseTo(0.25);
        expect(added.y).toBeCloseTo(0.175);
        expect(added.w).toBeLessThanOrEqual(0.3);
        const asset = await h.dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
          id: added.assetId as string,
        });
        expect(asset).toMatchObject({ role: 'element', versionId: version.id });
        const meta = await sharp(h.files.absolutePath(asset.url)).metadata();
        expect(meta.hasAlpha).toBe(true);
        expect(added.aspect).toBeCloseTo((meta.width as number) / (meta.height as number));
        expect(prune).toHaveBeenCalledTimes(1);
      });

      it('sem área marcada: 25% da largura no centro do miolo', async () => {
        const { scene } = await h.readyScene();
        const version = await h.queueTurn(scene, {
          plan: addPlan(null),
          request: 'acrescenta uma nuvem',
          operation: 'add_element',
        });
        await h.processorWith(h.mock()).process(h.job(scene.id, version.id));
        const done = await h.versionOf(version.id);
        const added = done.elements[0];
        expect(added).toMatchObject({ kind: 'generated', x: 0.5, w: 0.25 });
        expect(added.y).toBeCloseTo(0.5, 1);
        expect(await lastReply(scene.id)).toContain('no centro do miolo');
      });

      it('imagem toda transparente: falha com o custo gravado e sem elemento', async () => {
        const { scene } = await h.readyScene();
        const version = await h.queueTurn(scene, {
          plan: addPlan(null),
          request: 'adiciona um balão',
          operation: 'add_element',
        });
        const empty = await sharp({
          create: {
            width: 64,
            height: 64,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          },
        })
          .png()
          .toBuffer();
        const { provider } = h.fakeProvider(() => h.okResult(), {
          transparent: async () => ({
            buffer: empty,
            usage: null,
            costUsd: 0.09,
            requestId: 'r',
            latencyMs: 5,
          }),
        });
        await h.processorWith(provider).process(h.job(scene.id, version.id));
        expect(await h.versionOf(version.id)).toMatchObject({
          status: 'failed',
          errorCode: 'PROVIDER_ERROR',
          providerCostUsd: 0.09,
        });
      });

      it('limite antes da imagem: PAID_CALL_LIMIT', async () => {
        const { scene } = await h.readyScene();
        const version = await h.queueTurn(scene, {
          plan: addPlan(null),
          request: 'adiciona um balão',
          operation: 'add_element',
          overrides: {
            metrics: {
              plan: addPlan(null),
              calls: [
                {
                  id: 'c0',
                  kind: 'transparent',
                  status: 'done',
                  model: 'm',
                  size: '1x1',
                  startedAt: new Date().toISOString(),
                },
              ],
            },
          },
        });
        const fake = noModelCalls();
        await h
          .processorWith(fake.provider, { TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE: '1' })
          .process(h.job(scene.id, version.id));
        expect(fake.total()).toBe(0);
        expect(await h.versionOf(version.id)).toMatchObject({
          status: 'failed',
          errorCode: 'PAID_CALL_LIMIT',
        });
      });
    });
  },
);
