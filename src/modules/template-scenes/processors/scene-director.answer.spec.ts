import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { DirectorPlan } from '../domain/scene-director-schema';
import { directorAnswer, useDirectorHarness } from '../testing/scene-director-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

const open = (text: string) => ({ id: null, text, action: 'open' as const, quote: null });
const answer = (extra: Partial<DirectorPlan>): Partial<DirectorPlan> => ({
  turn_kind: 'pedido_item',
  will_change_image: false,
  ...extra,
});

describeIfSceneDb(
  'Diretor responde em vez de pedir imagem (validação 8, banco chroma_x_e2e)',
  () => {
    const h = useDirectorHarness();
    const imageJobs = () =>
      h.queue.publish.mock.calls.filter(([queue]) => queue === QUEUES.TEMPLATE_SCENE_TURN);
    const lastReply = async (sceneId: string) =>
      (await h.messagesOf(sceneId)).filter((m) => m.role === 'assistant').pop()?.content ?? '';

    it('Diretor não vê o objeto: a resposta vai como leitura, sem refazer e sem imagem', async () => {
      const { scene, version, plan } = await h.runTurn(
        'tira a cerca',
        answer({
          reply: 'Não vejo uma cerca na imagem. Onde ela está?',
          requests: [open('tirar a cerca')],
        }),
      );
      expect(plan).toHaveBeenCalledTimes(1);
      expect(version.status).toBe('rejected');
      expect(await lastReply(scene.id)).toBe(
        'Pelo que vejo na imagem: Não vejo uma cerca na imagem. Onde ela está?',
      );
      expect(imageJobs()).toHaveLength(0);
    });

    it('Resposta não fecha o pedido: "tira a cerca" fica em aberto na lista, para o cliente marcar a área depois', async () => {
      const { scene } = await h.runTurn(
        'tira a cerca',
        answer({
          reply: 'Não vejo uma cerca. Pode marcar a área?',
          requests: [open('tirar a cerca')],
        }),
      );
      const brief = (await h.sceneOf(scene.id)).brief;
      expect(brief.map((item) => [item.text, item.status])).toEqual([['tirar a cerca', 'open']]);
    });

    it('Plano diz que não muda, mas traz instrução: will_change_image falso é respeitado, sem imagem', async () => {
      const { version, scene } = await h.runTurn(
        'tira o preço',
        answer({
          reply: 'Não vejo nenhum preço na imagem; onde ele está?',
          what_to_change: 'remover o preço',
          what_to_put: 'campo limpo',
        }),
      );
      expect(version.status).toBe('rejected');
      expect(imageJobs()).toHaveLength(0);
      expect(await lastReply(scene.id)).toContain('Não vejo nenhum preço');
    });

    it('Anúncio sem ação: "Vou tirar a cerca" com will_change_image falso refaz uma vez, e persistindo vira o texto fixo, sem prefixo', async () => {
      const { scene, version, plan } = await h.runTurn(
        'tira a cerca',
        answer({ reply: 'Vou tirar a cerca.' }),
      );
      expect(plan).toHaveBeenCalledTimes(2);
      expect(version.status).toBe('rejected');
      expect(await lastReply(scene.id)).toBe(
        'Não entendi o que mudar na imagem. Me diga o que você quer que eu faça. Nada foi alterado.',
      );
      expect(imageJobs()).toHaveLength(0);
    });

    it('Anúncio sem ação corrigido ao refazer: a segunda resposta, sem "vou", vai ao cliente', async () => {
      const { scene, plan } = await h.runTurn('tira a cerca', async (_c, attempt) =>
        directorAnswer(
          answer({
            reply: attempt === 1 ? 'Vou tirar a cerca.' : 'Não vejo uma cerca; onde ela está?',
          }),
        ),
      );
      expect(plan).toHaveBeenCalledTimes(2);
      expect(await lastReply(scene.id)).toBe(
        'Pelo que vejo na imagem: Não vejo uma cerca; onde ela está?',
      );
    });

    it('Resposta barrada sem instrução: "Pronto, removi a cerca." cai no texto fixo, sem refazer e sem prefixo', async () => {
      const { scene, plan } = await h.runTurn(
        'tira a cerca',
        answer({ reply: 'Pronto, removi a cerca.' }),
      );
      expect(plan).toHaveBeenCalledTimes(1);
      expect(await lastReply(scene.id)).toContain('Não entendi o que mudar');
      expect(imageJobs()).toHaveLength(0);
    });

    it('Plano sem instrução: will_change_image verdadeiro e campos vazios refaz uma vez e, persistindo, pergunta', async () => {
      const { scene, version, plan } = await h.runTurn(
        'tira a cerca',
        answer({ will_change_image: true, reply: 'Vou tirar a cerca.' }),
      );
      expect(plan).toHaveBeenCalledTimes(2);
      expect(version.status).toBe('rejected');
      expect(await lastReply(scene.id)).toContain('Não entendi o que mudar');
      expect(imageJobs()).toHaveLength(0);
    });

    it('Remoção do que existe na imagem: o plano com a instrução e will_change_image verdadeiro chama a imagem', async () => {
      const { version, plan } = await h.runTurn(
        'tira o título',
        answer({
          will_change_image: true,
          reply: 'Vou remover o título do topo.',
          what_to_change: 'Remover o título Feliz Páscoa 2027 da parte de cima',
          what_to_put: 'Céu e flores na parte de cima',
          requests: [open('tirar o título')],
        }),
      );
      expect(plan).toHaveBeenCalledTimes(1);
      expect(version.status).toBe('queued');
      expect(imageJobs()).toHaveLength(1);
    });
  },
);
