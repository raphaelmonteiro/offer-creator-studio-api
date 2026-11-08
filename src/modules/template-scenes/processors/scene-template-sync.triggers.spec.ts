import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { DirectorPlan } from '../domain/scene-director-schema';
import { SceneElement } from '../domain/scene.types';
import { SceneProviderError } from '../providers/scene-image-provider';
import { SceneLockService } from '../services/scene-lock.service';
import { SceneReadService } from '../services/scene-read.service';
import { SceneVersionsService } from '../services/scene-versions.service';
import { directorPlan } from '../testing/scene-director-fixtures';
import { directorAnswer, useDirectorHarness } from '../testing/scene-director-harness';
import { insertAsset } from '../testing/scene-fixtures';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { fakeQueue, textElement } from '../testing/scene-test-helpers';

type Publish = { mock: { calls: unknown[][] } };

/** Os jobs de sincronização do template que a fila falsa recebeu. */
const syncJobs = (queue: Publish) =>
  queue.mock.calls.filter(([name]) => name === QUEUES.TEMPLATE_SCENE_TEMPLATE_SYNC);

const expectedJob = (sceneId: string) => [
  QUEUES.TEMPLATE_SCENE_TEMPLATE_SYNC,
  { sceneId },
  {
    manager: expect.anything(),
    singletonKey: sceneId,
    startAfterSeconds: 5,
    retryLimit: 2,
  },
];

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
  assetId: 'asset-x',
};

describeIfSceneDb(
  'Job de sincronização do template: enfileirado em cada version.ready (banco chroma_x_e2e)',
  () => {
    const h = useDirectorHarness();

    it('imagem pronta: um job na mesma transação, com a chave da cena e 5 s de espera', async () => {
      const { scene, version } = await h.queuedScene('campo verde com sol à direita');

      await h.processorWith(h.mock()).process(h.job(scene.id, version.id), 'job-1');

      expect((await h.versionOf(version.id)).status).toBe('ready');
      expect(syncJobs(h.syncQueue.publish)).toEqual([expectedJob(scene.id)]);
    });

    it('imagem que falhou não enfileira nada', async () => {
      const { scene, version } = await h.queuedScene('pedido que falha');
      const { provider } = h.fakeProvider(async () => {
        throw new SceneProviderError('PROVIDER_ERROR', 'falha simulada');
      });

      await h.processorWith(provider).process(h.job(scene.id, version.id), 'job-1');

      expect((await h.versionOf(version.id)).status).toBe('failed');
      expect(syncJobs(h.syncQueue.publish)).toEqual([]);
    });

    describe('REST: voltar e ajustar camada', () => {
      const versions = (queue: ReturnType<typeof fakeQueue>) =>
        new SceneVersionsService(
          h.dataSource,
          new SceneLockService(h.dataSource),
          new SceneReadService(h.dataSource),
          queue.service,
        );

      it('ajuste de camada (versão manual): um job', async () => {
        const { scene } = await h.readyScene();
        const queue = fakeQueue();

        await versions(queue).patchElements(
          scene.id,
          { expectedRevision: scene.revision, elements: [textElement('t1')] },
          null,
        );

        expect(syncJobs(queue.publish)).toEqual([expectedJob(scene.id)]);
      });

      it('voltar para uma versão antiga: um job', async () => {
        const { scene, version } = await h.readyScene();
        const second = await h.readyVersionLike(scene, 2, version.id);
        scene.currentVersionId = second.version.id;
        await h.dataSource.manager.save(scene);
        const queue = fakeQueue();

        await versions(queue).restore(scene.id, version.id, null);

        expect(syncJobs(queue.publish)).toEqual([expectedJob(scene.id)]);
      });

      it('voltar que dá erro (versão inexistente) não enfileira', async () => {
        const { scene } = await h.readyScene();
        const queue = fakeQueue();

        await expect(
          versions(queue).restore(scene.id, '00000000-0000-4000-8000-000000000000', null),
        ).rejects.toBeDefined();

        expect(syncJobs(queue.publish)).toEqual([]);
      });
    });

    describe('Diretor: camada e desfazer', () => {
      const answer = (ops: DirectorPlan['layer_ops']) =>
        directorAnswer(
          directorPlan({ turn_kind: 'camada', reply: 'Vou ajustar as camadas.', layer_ops: ops }),
        );

      it('camada pelo Diretor: um job', async () => {
        const ready = await h.readyScene({ elements: [LOGO] });
        const sent = await h.post(ready.scene.id, 'tira a logo');
        const { client } = h.directorClient(async () =>
          answer([
            {
              op: 'remove',
              layer: { kind: 'logo', name: null, side: null, direction: null },
              text: null,
              position: null,
              replace: false,
            },
          ]),
        );
        h.queue.publish.mockClear();

        await h
          .directorProcessor(client)
          .process({ sceneId: ready.scene.id, versionId: sent.versionId });

        expect((await h.versionOf(sent.versionId)).operation).toBe('set_layer');
        expect(syncJobs(h.queue.publish)).toEqual([expectedJob(ready.scene.id)]);
      });

      it('desfazer pelo Diretor: um job', async () => {
        const first = await h.readyScene();
        const v2 = await h.readyVersionLike(first.scene, 2, first.version.id);
        first.scene.currentVersionId = v2.version.id;
        await h.dataSource.manager.save(first.scene);
        const sent = await h.post(first.scene.id, 'volta como estava');
        const { client } = h.directorClient(async () =>
          directorAnswer(
            directorPlan({ turn_kind: 'desfazer', reply: 'Vou voltar.', undo_target: 'previous' }),
          ),
        );
        h.queue.publish.mockClear();

        await h
          .directorProcessor(client)
          .process({ sceneId: first.scene.id, versionId: sent.versionId });

        expect((await h.versionOf(sent.versionId)).operation).toBe('restore');
        expect(syncJobs(h.queue.publish)).toEqual([expectedJob(first.scene.id)]);
      });

      it('mensagem que o Diretor só responde (rejected) não enfileira', async () => {
        const ready = await h.readyScene({ elements: [LOGO] });
        await insertAsset(h.dataSource, ready.version, 'logo');
        const sent = await h.post(ready.scene.id, 'mexe na camada que não existe');
        const { client } = h.directorClient(async () =>
          answer([
            {
              op: 'move',
              layer: { kind: 'text', name: null, side: 'right', direction: null },
              text: null,
              position: null,
              replace: false,
            },
          ]),
        );
        h.queue.publish.mockClear();

        await h
          .directorProcessor(client)
          .process({ sceneId: ready.scene.id, versionId: sent.versionId });

        expect((await h.versionOf(sent.versionId)).status).toBe('rejected');
        expect(syncJobs(h.queue.publish)).toEqual([]);
      });
    });
  },
);
