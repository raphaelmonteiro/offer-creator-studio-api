import * as fs from 'fs/promises';
import * as path from 'path';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { useProcessorHarness } from '../testing/scene-processor-harness';

describeIfSceneDb(
  'SceneTurnProcessor: cancelamento, idempotência e disjuntor (banco chroma_x_e2e)',
  () => {
    const h = useProcessorHarness();
    const {
      processorWith,
      queuedScene,
      job,
      versionOf,
      sceneOf,
      messagesOf,
      fakeProvider,
      okResult,
    } = h;
    it('cancelamento durante a chamada: resultado descartado, custo gravado, versão cancelled', async () => {
      const { scene, version } = await queuedScene('cancela durante');
      const { provider } = fakeProvider(async () => {
        // o usuário clica em "Cancelar" enquanto a chamada paga está em curso
        await h.dataSource.manager.update(
          TemplateSceneVersion,
          { id: version.id },
          { cancelRequestedAt: new Date() },
        );
        return okResult(0.12);
      });
      const before = await sceneOf(scene.id);

      await processorWith(provider).process(job(scene.id, version.id));

      const done = await versionOf(version.id);
      expect(done).toMatchObject({
        status: 'cancelled',
        providerCostUsd: 0.12,
        masterAssetId: null,
      });
      expect(done.metrics.calls).toEqual([
        expect.objectContaining({ status: 'done', costUsd: 0.12 }),
      ]);
      const stored = await sceneOf(scene.id);
      expect(stored.totalCostUsd).toBe(0.12);
      expect(stored.currentVersionId).toBe(before.currentVersionId);
      expect(await h.dataSource.manager.countBy(TemplateSceneAsset, { sceneId: scene.id })).toBe(0);
      await expect(
        fs.access(path.join(h.uploadsDir, 'template-scenes', scene.id)),
      ).rejects.toThrow();
      const messages = await messagesOf(scene.id);
      expect(messages[1].content).toBe('Geração cancelada.');
    });

    it('Parar durante a imagem: os itens do turno parado e do anterior ficam superados (B2)', async () => {
      const { scene, version } = await queuedScene('cancela com itens');
      await h.setBrief(scene.id, version.id, [
        {
          id: 'p1',
          text: 'um rio no meio',
          status: 'open',
          sourceMessageId: 'm-anterior',
          updatedAt: '2026-11-06T12:00:00.000Z',
        },
        {
          id: 'p2',
          text: 'trator vermelho no campo',
          status: 'open',
          sourceMessageId: 'turn',
          updatedAt: '2026-11-06T12:00:00.000Z',
        },
      ]);
      const { provider } = fakeProvider(async () => {
        await h.dataSource.manager.update(
          TemplateSceneVersion,
          { id: version.id },
          { cancelRequestedAt: new Date() },
        );
        return okResult(0.12);
      });

      await processorWith(provider).process(job(scene.id, version.id));

      expect((await versionOf(version.id)).status).toBe('cancelled');
      expect((await sceneOf(scene.id)).brief.map((item) => [item.id, item.status])).toEqual([
        ['p1', 'superseded'],
        ['p2', 'superseded'],
      ]);
    });

    it('cancelamento pedido antes de o worker pegar: cancela sem chamar o provedor', async () => {
      const { provider, generate } = fakeProvider(() => okResult());
      const { scene, version } = await queuedScene('cancela antes', {
        cancelRequestedAt: new Date(),
      });
      await processorWith(provider).process(job(scene.id, version.id));
      expect(generate).not.toHaveBeenCalled();
      expect(await versionOf(version.id)).toMatchObject({
        status: 'cancelled',
        providerCostUsd: 0,
      });
    });

    it('cena excluída durante a chamada: resultado descartado e custo gravado', async () => {
      const { scene, version } = await queuedScene('excluída durante');
      const { provider } = fakeProvider(async () => {
        await h.dataSource.manager.softDelete(TemplateScene, { id: scene.id });
        return okResult(0.05);
      });

      await processorWith(provider).process(job(scene.id, version.id));

      expect(await versionOf(version.id)).toMatchObject({
        status: 'cancelled',
        providerCostUsd: 0.05,
      });
      expect(await h.dataSource.manager.countBy(TemplateSceneAsset, { sceneId: scene.id })).toBe(0);
    });

    it.each(['ready', 'failed', 'cancelled', 'running'] as const)(
      'job repetido com a versão %s: sai sem chamar o provedor e sem mudar o custo',
      async (status) => {
        const { provider, generate } = fakeProvider(() => okResult());
        const { scene, version } = await queuedScene(`repetido ${status}`, {
          status,
          providerCostUsd: 0.2,
        });
        await h.dataSource.manager.update(TemplateScene, { id: scene.id }, { totalCostUsd: 0.2 });

        await processorWith(provider).process(job(scene.id, version.id), 'job-repetido');

        expect(generate).not.toHaveBeenCalled();
        expect((await versionOf(version.id)).providerCostUsd).toBe(0.2);
        expect((await sceneOf(scene.id)).totalCostUsd).toBe(0.2);
      },
    );

    it('entregar o mesmo job duas vezes depois do sucesso chama o provedor uma vez só', async () => {
      const { provider, generate } = fakeProvider(() => okResult(0.1));
      const { scene, version } = await queuedScene('duas entregas');
      const processor = processorWith(provider);

      await processor.process(job(scene.id, version.id), 'job-1');
      await processor.process(job(scene.id, version.id), 'job-1');

      expect(generate).toHaveBeenCalledTimes(1);
      expect((await versionOf(version.id)).providerCostUsd).toBe(0.1);
    });

    it('versão ou cena inexistente: sai em silêncio', async () => {
      const { provider, generate } = fakeProvider(() => okResult());
      const { scene } = await queuedScene('inexistente');
      await expect(
        processorWith(provider).process(job(scene.id, '00000000-0000-4000-8000-000000000000')),
      ).resolves.toBeUndefined();
      await expect(
        processorWith(provider).process(
          job('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000001'),
        ),
      ).resolves.toBeUndefined();
      expect(generate).not.toHaveBeenCalled();
    });

    it('disjuntor: já com 4 chamadas pagas na versão, falha PAID_CALL_LIMIT sem chamar o provedor', async () => {
      const { provider, generate } = fakeProvider(() => okResult());
      const calls = Array.from({ length: 4 }, (_, i) => ({
        id: `c${i}`,
        kind: 'generate' as const,
        status: 'done' as const,
        model: 'm',
        size: '1x1',
        startedAt: new Date().toISOString(),
      }));
      const { scene, version } = await queuedScene('disjuntor', { metrics: { calls } });

      await processorWith(provider).process(job(scene.id, version.id));

      expect(generate).not.toHaveBeenCalled();
      expect(await versionOf(version.id)).toMatchObject({
        status: 'failed',
        errorCode: 'PAID_CALL_LIMIT',
      });
    });

    it('o limite do disjuntor vem de TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE', async () => {
      const { provider, generate } = fakeProvider(() => okResult());
      const call = {
        id: 'c',
        kind: 'generate' as const,
        status: 'done' as const,
        model: 'm',
        size: '1x1',
        startedAt: 'x',
      };
      const { scene, version } = await queuedScene('disjuntor env', { metrics: { calls: [call] } });
      await processorWith(provider, { TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE: '1' }).process(
        job(scene.id, version.id),
      );
      expect(generate).not.toHaveBeenCalled();
      expect((await versionOf(version.id)).errorCode).toBe('PAID_CALL_LIMIT');
    });
  },
);
