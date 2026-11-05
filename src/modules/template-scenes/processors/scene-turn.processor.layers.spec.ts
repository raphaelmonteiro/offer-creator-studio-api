import * as retention from '../services/scene-retention';
import { insertAsset } from '../testing/scene-fixtures';
import { lastReplyOf, logoEl, noModelCalls, textEl } from '../testing/scene-operation-fixtures';
import { useProcessorHarness } from '../testing/scene-processor-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

describeIfSceneDb('SceneTurnProcessor: camadas pelo chat (banco chroma_x_e2e)', () => {
  jest.setTimeout(60_000);
  const h = useProcessorHarness();
  afterEach(() => jest.restoreAllMocks());
  const lastReply = (sceneId: string) => lastReplyOf(h, sceneId);
  const noModels = () => noModelCalls(h);

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
        request: 'coloca a logo à esquerda no cabeçalho e escreve "Ofertas da semana" embaixo dela',
        attachments: [{ assetId: logo.id }],
      });
      const fake = noModels();
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
      const fake = noModels();

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
      await h.processorWith(noModels().provider).process(h.job(scene.id, version.id));
      expect(await h.versionOf(version.id)).toMatchObject({
        status: 'rejected',
        providerCostUsd: 0,
      });
      expect(await lastReply(scene.id)).toContain('Não encontrei a logo');
      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(scene.currentVersionId);
    });
  });
});
