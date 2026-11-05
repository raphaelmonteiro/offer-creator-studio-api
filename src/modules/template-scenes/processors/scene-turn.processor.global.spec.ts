import * as sharp from 'sharp';
import { loadRgb } from '../../../shared/image/rgb';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import * as retention from '../services/scene-retention';
import {
  genEl,
  lastReplyOf,
  logoEl,
  noModelCalls,
  textEl,
} from '../testing/scene-operation-fixtures';
import { useProcessorHarness } from '../testing/scene-processor-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

describeIfSceneDb('SceneTurnProcessor: ajuste geral (banco chroma_x_e2e)', () => {
  jest.setTimeout(60_000);
  const h = useProcessorHarness();
  afterEach(() => jest.restoreAllMocks());
  const lastReply = (sceneId: string) => lastReplyOf(h, sceneId);
  const noModels = () => noModelCalls(h);

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

    it('elementos adicionados ficam onde estão, com a mesma posição e a mesma imagem', async () => {
      const { scene } = await h.readyScene({ elements: [genEl] });
      const version = await h.queueTurn(scene, {
        plan: globalPlan,
        request: 'Confirmar',
        operation: 'generate',
      });
      await h.processorWith(h.mock()).process(h.job(scene.id, version.id));
      const done = await h.versionOf(version.id);
      expect(done.status).toBe('ready');
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
      const fake = noModels();
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
});
