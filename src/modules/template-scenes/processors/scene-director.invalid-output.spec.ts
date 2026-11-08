import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { describeIfSceneDb } from '../testing/scene-test-db';
import {
  DIRECTOR_CALL_COST,
  directorAnswer,
  useDirectorHarness,
} from '../testing/scene-director-harness';

describeIfSceneDb('SceneDirectorProcessor: saída inválida e custo (banco chroma_x_e2e)', () => {
  const h = useDirectorHarness();

  const messagesOf = (sceneId: string) =>
    h.dataSource.manager.find(TemplateSceneMessage, {
      where: { sceneId },
      order: { createdAt: 'ASC', role: 'DESC' },
    });
  const lastAssistant = async (sceneId: string) =>
    (await messagesOf(sceneId)).filter((m) => m.role === 'assistant').pop();
  const imageJobs = () =>
    h.queue.publish.mock.calls.filter(([queue]) => queue === QUEUES.TEMPLATE_SCENE_TURN);

  const turn = h.runTurn;

  describe('Saída inválida e custo', () => {
    it('Saída inválida uma vez: o plano válido segue, e o custo das duas chamadas fica registrado', async () => {
      const { scene, version, plan } = await turn('tira o coelho', async (_call, attempt) =>
        attempt === 1
          ? directorAnswer('{"turn_kind":"pergunta"}')
          : directorAnswer({
              turn_kind: 'pedido_item',
              will_change_image: true,
              reply: 'Vou tirar o coelho.',
              what_to_change: 'tirar o coelho',
              requests: [{ id: null, text: 'tirar o coelho', action: 'open', quote: null }],
            }),
      );
      expect(plan).toHaveBeenCalledTimes(2);
      expect(version).toMatchObject({ status: 'queued', step: null });
      const director = version.metrics.director as {
        calls: Array<{ status: string }>;
        costUsd: number;
      };
      expect(director.calls.map((c) => c.status)).toEqual(['failed', 'done']);
      expect(director.costUsd).toBeCloseTo(DIRECTOR_CALL_COST * 2, 6);
      expect(version.providerCostUsd).toBeCloseTo(DIRECTOR_CALL_COST * 2, 6);
      expect((await h.sceneOf(scene.id)).totalCostUsd).toBeCloseTo(DIRECTOR_CALL_COST * 2, 6);
      expect(version.metrics.calls).toBeUndefined();
    });

    it('Saída inválida duas vezes: failed DIRECTOR_UNAVAILABLE, chat avisa que nada foi alterado e a cena fica livre', async () => {
      const { scene, version, plan } = await turn('tira o coelho', async () =>
        directorAnswer('nao é json'),
      );
      expect(plan).toHaveBeenCalledTimes(2);
      expect(version).toMatchObject({ status: 'failed', errorCode: 'DIRECTOR_UNAVAILABLE' });
      const reply = await lastAssistant(scene.id);
      expect(reply?.content).toBe('Não consegui ler seu pedido agora. Nada foi alterado.');
      expect(imageJobs()).toHaveLength(0);
      const next = await h.post(scene.id, 'outra', {});
      expect(next.versionId).not.toBe(version.id);
    });

    it('Diretor passa do tempo: o resultado é o mesmo, sem nova chamada ao Diretor, e a cena fica livre', async () => {
      const { scene, version, plan } = await turn(
        'tira o coelho',
        () => new Promise(() => undefined),
        { env: { TEMPLATE_SCENE_DIRECTOR_TIMEOUT_MS: '30' } },
      );
      expect(plan).toHaveBeenCalledTimes(1);
      expect(version).toMatchObject({ status: 'failed', errorCode: 'DIRECTOR_UNAVAILABLE' });
      expect(imageJobs()).toHaveLength(0);
      expect(version.metrics.costUnknown).toBe(true);
      await expect(h.post(scene.id, 'outra', {})).resolves.toBeDefined();
    });

    it('sem saldo (insufficient_quota): PROVIDER_QUOTA, terminal, uma só chamada', async () => {
      const quota = Object.assign(new Error('quota'), { status: 429, code: 'insufficient_quota' });
      const { version, plan } = await turn('tira o coelho', async () => {
        throw quota;
      });
      expect(plan).toHaveBeenCalledTimes(1);
      expect(version).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_QUOTA' });
    });

    it('resposta sem usage: o plano segue e o custo fica marcado como desconhecido', async () => {
      const { version } = await turn(
        'quantos coelhos?',
        {
          turn_kind: 'pergunta',
          reply: 'Há 3 coelhos.',
        },
        {},
      );
      expect(version.metrics.costUnknown).toBeUndefined();
      const noUsage = await turn('quantos coelhos?', async () =>
        directorAnswer({ turn_kind: 'pergunta', reply: 'Há 3.' }, null),
      );
      expect(noUsage.version.metrics.costUnknown).toBe(true);
      expect(noUsage.version.providerCostUsd).toBe(0);
    });
  });
});
