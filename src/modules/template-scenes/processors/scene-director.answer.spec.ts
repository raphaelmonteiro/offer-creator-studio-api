import { PlanOverrides } from '../testing/scene-director-fixtures';
import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { directorAnswer, useDirectorHarness } from '../testing/scene-director-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

const open = (text: string) => ({ id: null, text, action: 'open' as const, quote: null });
const answer = (extra: PlanOverrides): PlanOverrides => ({
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
      expect(await lastReply(scene.id)).toBe('Não vejo uma cerca; onde ela está?');
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

    describe('Resposta sem imagem não passa por composição nem por número (R32)', () => {
      it('"Não vejo faixa." com "colocar uma faixa azul" no plano: o Diretor é chamado uma vez e a resposta dele sai', async () => {
        const { scene, plan, version } = await h.runTurn(
          'deixa mais bonito',
          answer({
            reply: 'Não vejo faixa. Onde ela está?',
            what_to_change: 'colocar uma faixa azul',
          }),
        );
        expect(plan).toHaveBeenCalledTimes(1);
        expect(version.status).toBe('rejected');
        expect(await lastReply(scene.id)).toBe(
          'Pelo que vejo na imagem: Não vejo faixa. Onde ela está?',
        );
      });

      it('número no plano que não chama imagem também não refaz', async () => {
        const { plan } = await h.runTurn(
          'coloca 2027',
          answer({ reply: 'Não vejo onde. Onde fica?', what_to_put: '2027 em cima' }),
        );
        expect(plan).toHaveBeenCalledTimes(1);
      });

      it('o mesmo plano com will_change_image verdadeiro continua passando pela composição', async () => {
        const { plan } = await h.runTurn(
          'coloca um coelho',
          answer({
            will_change_image: true,
            reply: 'Vou colocar.',
            what_to_change: 'colocar uma faixa azul',
          }),
        );
        expect(plan).toHaveBeenCalledTimes(2);
      });
    });

    describe('Anúncio sem ação em outra forma verbal (R33)', () => {
      it.each(['O coelho será removido.', 'Removerei o coelho.', 'Estou removendo o coelho.'])(
        '"%s" com will_change_image falso: refaz uma vez e, persistindo, o chat diz que não entendeu, sem prometer',
        async (reply) => {
          const { scene, plan, version } = await h.runTurn('tira o coelho', answer({ reply }));
          expect(plan).toHaveBeenCalledTimes(2);
          expect(version.status).toBe('rejected');
          const text = await lastReply(scene.id);
          expect(text).toContain('Não entendi o que mudar');
          expect(text).not.toContain('removid');
          expect(imageJobs()).toHaveLength(0);
        },
      );
    });
  },
);
