import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { errorOf } from '../testing/scene-test-helpers';
import {
  DIRECTOR_CALL_COST,
  directorAnswer,
  useDirectorHarness,
} from '../testing/scene-director-harness';

const job = (sceneId: string, versionId: string) => ({ sceneId, versionId });

describeIfSceneDb('SceneDirectorProcessor: parar e cenas em paralelo (banco chroma_x_e2e)', () => {
  const h = useDirectorHarness();

  const messagesOf = (sceneId: string) =>
    h.dataSource.manager.find(TemplateSceneMessage, {
      where: { sceneId },
      order: { createdAt: 'ASC', role: 'DESC' },
    });
  const imageJobs = () =>
    h.queue.publish.mock.calls.filter(([queue]) => queue === QUEUES.TEMPLATE_SCENE_TURN);

  const turn = h.runTurn;

  describe('Parar durante a leitura', () => {
    it('Parar durante a leitura: a versão fica cancelled, o plano é descartado, o custo do Diretor fica registrado (Diretor parado também custa) e nenhuma imagem é chamada', async () => {
      const { scene } = await h.readyScene();
      const sent = await h.post(scene.id, 'tira o coelho');
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { client, plan } = h.directorClient(async () => {
        await gate;
        return directorAnswer({
          turn_kind: 'pedido_item',
          will_change_image: true,
          reply: 'Vou tirar o coelho.',
          what_to_change: 'tirar o coelho',
        });
      });
      const running = h.directorProcessor(client).process(job(scene.id, sent.versionId));
      while (plan.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

      const cancelled = await h.turns().cancel(scene.id, sent.versionId);
      expect(cancelled.status).toBe('cancelled');
      release();
      await running;

      const version = await h.versionOf(sent.versionId);
      expect(version.status).toBe('cancelled');
      expect(imageJobs()).toHaveLength(0);
      expect(version.providerCostUsd).toBeCloseTo(DIRECTOR_CALL_COST, 6);
      expect((await h.sceneOf(scene.id)).totalCostUsd).toBeCloseTo(DIRECTOR_CALL_COST, 6);
      expect(version.metrics.calls).toBeUndefined();
      expect((version.metrics.director as { calls: unknown[] }).calls).toHaveLength(1);
      const assistants = (await messagesOf(scene.id)).filter((m) => m.role === 'assistant');
      expect(assistants.map((m) => m.content)).toEqual(['Geração cancelada.']);
    });

    it('Parar durante a leitura fecha o item de turno anterior e não abre item do plano descartado', async () => {
      const { scene } = await h.readyScene();
      await h.dataSource.manager.update(
        TemplateScene,
        { id: scene.id },
        {
          brief: [
            {
              id: 'p1',
              text: 'um rio no meio',
              status: 'open',
              sourceMessageId: 'm-anterior',
              updatedAt: '2026-11-06T12:00:00.000Z',
            },
          ],
        },
      );
      const sent = await h.post(scene.id, 'coloca um trator vermelho no campo');
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { client, plan } = h.directorClient(async () => {
        await gate;
        return directorAnswer({
          turn_kind: 'pedido_item',
          will_change_image: true,
          reply: 'Vou colocar o trator.',
          what_to_change: 'colocar um trator vermelho',
          requests: [{ id: null, text: 'trator vermelho no campo', action: 'open', quote: null }],
        });
      });
      const running = h.directorProcessor(client).process(job(scene.id, sent.versionId));
      while (plan.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

      await h.turns().cancel(scene.id, sent.versionId);
      release();
      await running;

      const stored = await h.sceneOf(scene.id);
      expect(stored.brief.map((item) => [item.id, item.status])).toEqual([['p1', 'superseded']]);
    });

    it('Parar antes de o job começar: o Diretor nem é chamado, e nada é cobrado', async () => {
      const { scene } = await h.readyScene();
      const sent = await h.post(scene.id, 'tira o coelho');
      await h.turns().cancel(scene.id, sent.versionId);
      const { client } = h.directorClient(async () =>
        directorAnswer({ turn_kind: 'pergunta', reply: 'Há 3 coelhos.' }),
      );
      // o job chega depois do Parar: a versão já não está lendo, então o Diretor nem é chamado
      const plan = client.plan as jest.Mock;
      await h.directorProcessor(client).process(job(scene.id, sent.versionId));
      expect(plan).not.toHaveBeenCalled();
      expect((await h.versionOf(sent.versionId)).providerCostUsd).toBe(0);
    });

    it('Parar quando o Diretor acabou de responder: 409 VERSION_NOT_CANCELLABLE', async () => {
      const { scene, sent } = await turn('quantos coelhos?', {
        turn_kind: 'pergunta',
        reply: 'Há 3.',
      });
      expect(await errorOf(h.turns().cancel(scene.id, sent.versionId))).toEqual({
        status: 409,
        code: 'VERSION_NOT_CANCELLABLE',
      });
    });
  });

  describe('Diretor não espera a imagem de outra cena', () => {
    it('com a imagem da cena A em curso, o Diretor da cena B responde sem esperar', async () => {
      // cena A: a chamada de imagem está presa
      const { scene: sceneA, version: versionA } = await h.queuedScene('campo verde');
      let release: () => void = () => undefined;
      const blocked = new Promise<void>((resolve) => (release = resolve));
      const { provider, generate } = h.fakeProvider(async () => {
        await blocked;
        return h.okResult();
      });
      const imageRun = h.processorWith(provider).process(job(sceneA.id, versionA.id));
      while (generate.mock.calls.length === 0)
        await new Promise((resolve) => setTimeout(resolve, 5));

      // cena B: o Diretor termina enquanto a imagem de A continua presa
      const { version } = await turn('quantos coelhos?', { turn_kind: 'pergunta', reply: 'Há 3.' });
      expect(version.status).toBe('rejected');
      expect((await h.versionOf(versionA.id)).status).toBe('running');

      release();
      await imageRun;
      expect((await h.versionOf(versionA.id)).status).toBe('ready');
    });
  });
});
