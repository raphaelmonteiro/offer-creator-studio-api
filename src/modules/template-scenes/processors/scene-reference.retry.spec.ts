import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { SceneProviderError } from '../providers/scene-image-provider';
import { loadReferenceView } from '../services/scene-reference-view';
import { insertVersion } from '../testing/scene-fixtures';
import { conceptVision, useReferenceHarness } from '../testing/scene-reference-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { errorOf } from '../testing/scene-test-helpers';

describeIfSceneDb(
  'Tentar de novo, falha e parada da geração por referência (banco chroma_x_e2e)',
  () => {
    const h = useReferenceHarness();
    const proposedScene = (overrides?: Parameters<typeof h.newScene>[0]) =>
      h.proposedScene(overrides);
    const view = (sceneId: string) => loadReferenceView(h.dataSource.manager, sceneId);

    it('Tentar de novo (D-4): repete a geração com o mesmo encarte antes de qualquer edição', async () => {
      const { scene, revision } = await proposedScene();
      const first = await h.generate(scene.id, revision);
      await h.run(scene.id, first.versionId);
      expect((await view(scene.id))?.canRetry).toBe(true);

      const second = await h.generate(scene.id, await h.revisionOf(scene.id));
      expect((await h.messagesOf(scene.id)).at(-1)?.content).toBe('Tentar de novo com o encarte.');
      const fake = await h.run(scene.id, second.versionId);

      expect(fake.edit).toHaveBeenCalledTimes(1);
      const versions = await h.versions(scene.id);
      expect(
        versions.filter((v) => v.operation === 'generate' && v.status === 'ready'),
      ).toHaveLength(2);
      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(second.versionId);
      expect(await h.versionOf(second.versionId)).toMatchObject({
        parentVersionId: first.versionId,
      });
    });

    it('Tentar de novo depois de uma edição: 422 REFERENCE_NOT_PROPOSED, nenhuma chamada e o botão some', async () => {
      const { scene, revision } = await proposedScene();
      const first = await h.generate(scene.id, revision);
      await h.run(scene.id, first.versionId);
      await insertVersion(h.dataSource, scene.id, {
        number: 10,
        operation: 'redraw',
        status: 'ready',
        parentVersionId: first.versionId,
      });
      expect((await view(scene.id))?.canRetry).toBe(false);
      h.publish.mockClear();

      expect(await errorOf(h.generate(scene.id, await h.revisionOf(scene.id)))).toEqual({
        status: 422,
        code: 'REFERENCE_NOT_PROPOSED',
      });
      expect(h.publish).not.toHaveBeenCalled();
    });

    it('repetição que falha: a versão 2 fica failed, a 1 continua a atual e o botão continua', async () => {
      const { scene, revision } = await proposedScene();
      const first = await h.generate(scene.id, revision);
      await h.run(scene.id, first.versionId);
      const second = await h.generate(scene.id, await h.revisionOf(scene.id));
      const quota = h.fakeProvider(async () => {
        throw new SceneProviderError('PROVIDER_QUOTA', 'sem saldo', 0);
      });
      await h.run(scene.id, second.versionId, { provider: quota });

      expect(await h.versionOf(second.versionId)).toMatchObject({
        status: 'failed',
        errorCode: 'PROVIDER_QUOTA',
      });
      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(first.versionId);
      expect(await view(scene.id)).toMatchObject({ state: 'used', canRetry: true });
    });

    it('falha do provedor na primeira geração: PROVIDER_QUOTA e a ficha volta a proposed; dá para gerar de novo', async () => {
      const { scene, read, revision } = await proposedScene();
      const sent = await h.generate(scene.id, revision);
      const quota = h.fakeProvider(async () => {
        throw new SceneProviderError('PROVIDER_QUOTA', 'sem saldo', 0);
      });
      await h.run(scene.id, sent.versionId, { provider: quota });

      expect(await h.versionOf(sent.versionId)).toMatchObject({
        status: 'failed',
        errorCode: 'PROVIDER_QUOTA',
      });
      expect((await h.referenceState(read.versionId))?.state).toBe('proposed');
      const again = await h.generate(scene.id, await h.revisionOf(scene.id));
      expect(again.versionId).not.toBe(sent.versionId);
    });

    it('Parar a geração: cancelled e a ficha volta a proposed', async () => {
      const { scene, read, revision } = await proposedScene();
      const sent = await h.generate(scene.id, revision);
      await h.dataSource.manager.update(
        TemplateSceneVersion,
        { id: sent.versionId },
        { cancelRequestedAt: new Date() },
      );
      const fake = await h.run(scene.id, sent.versionId);

      expect((await h.versionOf(sent.versionId)).status).toBe('cancelled');
      expect(fake.edit).not.toHaveBeenCalled();
      expect((await h.referenceState(read.versionId))?.state).toBe('proposed');
    });

    it('clique duplo: um 202 e um 409, e uma só versão generate', async () => {
      const { scene, revision } = await proposedScene();
      const results = await Promise.allSettled([
        h.generate(scene.id, revision),
        h.generate(scene.id, revision),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(['SCENE_BUSY', 'REVISION_CONFLICT']).toContain(
        (rejected.reason.getResponse() as { code: string }).code,
      );
      expect((await h.versions(scene.id)).filter((v) => v.operation === 'generate')).toHaveLength(
        1,
      );
    });

    it('gerar sem ficha proposta: sem leitura, com a ficha failed ou discarded: 422 e nenhuma chamada', async () => {
      const empty = await h.newScene();
      expect(await errorOf(h.generate(empty.id, 0))).toEqual({
        status: 422,
        code: 'REFERENCE_NOT_PROPOSED',
      });

      const failed = await h.newScene();
      const sent = await h.upload(failed.id);
      await h.run(failed.id, sent.versionId, {
        vision: conceptVision(() => ({ is_retail_flyer: false })).client,
      });
      expect(await errorOf(h.generate(failed.id, await h.revisionOf(failed.id)))).toEqual({
        status: 422,
        code: 'REFERENCE_NOT_PROPOSED',
      });
      expect(h.publish).toHaveBeenCalledTimes(1); // só o envio da cena com a ficha failed
    });
  },
);
