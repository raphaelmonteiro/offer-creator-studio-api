import { insertVersion } from '../testing/scene-fixtures';
import { directorPlan } from '../testing/scene-director-fixtures';
import { useProcessorHarness } from '../testing/scene-processor-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

describeIfSceneDb(
  'SceneRedrawHandler: plano que não serve não chama a imagem (banco chroma_x_e2e)',
  () => {
    jest.setTimeout(60_000);
    const h = useProcessorHarness();

    async function runWith(plan: unknown, operation: 'generate' | 'redraw') {
      const { scene } = await h.readyScene();
      const fresh = await h.sceneOf(scene.id);
      const queued = await insertVersion(h.dataSource, scene.id, {
        number: 2,
        status: 'queued',
        operation,
        parentVersionId: operation === 'redraw' ? fresh.currentVersionId : null,
        metrics: { plan },
      });
      const { provider, edit, generate } = h.fakeProvider(() => h.okResult());
      await h.processorWith(provider).process(h.job(scene.id, queued.id));
      return { edit, generate, version: await h.versionOf(queued.id) };
    }

    it('Job antigo de geração: o plano no formato da classificação antiga deixa a versão failed, sem chamada paga', async () => {
      const legacy = { intent: 'generate', confidence: 0.9, rationale: 'pedido de imagem' };
      const { edit, generate, version } = await runWith(legacy, 'generate');
      expect(generate).not.toHaveBeenCalled();
      expect(edit).not.toHaveBeenCalled();
      expect(version).toMatchObject({
        status: 'failed',
        errorCode: 'PROVIDER_ERROR',
        providerCostUsd: 0,
      });
    });

    it.each(['generate', 'redraw'] as const)(
      'Plano sem instrução (%s): failed sem chamada paga, nunca um prompt vazio',
      async (operation) => {
        const plan = directorPlan({ turn_kind: 'pedido_item', will_change_image: true });
        const { edit, generate, version } = await runWith(plan, operation);
        expect(generate).not.toHaveBeenCalled();
        expect(edit).not.toHaveBeenCalled();
        expect(version).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_ERROR' });
      },
    );
  },
);
