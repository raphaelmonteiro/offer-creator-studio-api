import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { TemplateScene } from '../entities/template-scene.entity';
import { MockSceneDirectorClient } from '../providers/mock-scene-director.client';
import { SceneDirectorCall } from '../providers/scene-director-client';
import { directorAnswer, useDirectorHarness } from '../testing/scene-director-harness';
import { insertMessage } from '../testing/scene-fixtures';
import { describeIfSceneDb } from '../testing/scene-test-db';

const OLD: TemplateScene['brief'][number] = {
  id: 'p1',
  text: 'placa com “Oferta”',
  status: 'open',
  sourceMessageId: 'm-anterior',
  updatedAt: '2026-11-07T12:00:00.000Z',
};

describeIfSceneDb(
  'Sempre para a frente: itens do turno no Diretor (D-59, banco chroma_x_e2e)',
  () => {
    const h = useDirectorHarness();
    const imageJobs = () =>
      h.queue.publish.mock.calls.filter(([queue]) => queue === QUEUES.TEMPLATE_SCENE_TURN);
    const lastReply = async (sceneId: string) =>
      (await h.messagesOf(sceneId)).filter((m) => m.role === 'assistant').pop()?.content ?? '';
    const mock = new MockSceneDirectorClient();
    const viaMock = async (call: SceneDirectorCall) => mock.plan(call);

    describe('Mensagem que se contradiz', () => {
      it('Mensagem que se contradiz: pergunta que cita as duas frases, sem imagem, sem item e rejected', async () => {
        const { scene, version } = await h.runTurn(
          'cria uma placa e escreve nela promoção de páscoa, e eu quero que o texto oferta de páscoa fique como se fosse parte da placa #plano-contradicao',
          viaMock,
        );
        expect(version.status).toBe('rejected');
        expect(await lastReply(scene.id)).toBe(
          'Qual você quer: “promoção de páscoa” ou “oferta de páscoa”?',
        );
        expect(imageJobs()).toHaveLength(0);
        expect((await h.sceneOf(scene.id)).brief).toEqual([]);
        expect(version.metrics.calls).toBeUndefined();
      });

      it('Colocar e tirar a mesma coisa: pergunta o que o cliente quer, sem imagem e sem item aberto', async () => {
        const { scene, version } = await h.runTurn(
          'coloca um coelho no rodapé e tira o coelho #plano-contradicao',
          viaMock,
        );
        expect(version.status).toBe('rejected');
        expect(await lastReply(scene.id)).toContain('Qual você quer');
        expect(imageJobs()).toHaveLength(0);
        expect((await h.sceneOf(scene.id)).brief).toEqual([]);
      });

      it('a pergunta fecha o item de turno anterior: nada fica cobrado depois', async () => {
        const { scene } = await h.runTurn(
          'coloca um coelho no rodapé e tira o coelho #plano-contradicao',
          viaMock,
          { brief: [OLD] },
        );
        expect((await h.sceneOf(scene.id)).brief[0].status).toBe('superseded');
      });

      it('Resposta à pergunta da contradição: o plano pinta “Oferta de Páscoa” e “Promoção de Páscoa” não vai ao plano', async () => {
        const { scene, version } = await h.runTurn(
          'oferta de páscoa',
          async () =>
            directorAnswer({
              turn_kind: 'pedido_item',
              will_change_image: true,
              reply: 'Vou colocar a placa com a frase “Oferta de Páscoa”.',
              what_to_change: 'Add a wooden sign with the requested lettering',
              exact_text: ['Oferta de Páscoa'],
            }),
          { brief: [] },
        );
        expect(version).toMatchObject({ status: 'queued' });
        const stored = JSON.stringify(version.metrics.plan);
        expect(stored).toContain('Oferta de Páscoa');
        expect(stored).not.toContain('Promoção de Páscoa');
        expect(imageJobs()).toHaveLength(1);
        expect(scene.id).toBeDefined();
      });
    });

    describe('Item de turno anterior', () => {
      it('Voltar outro dia: "sim, faz" executa o item em aberto, que passa a ser da mensagem atual', async () => {
        const { scene } = await h.readyScene();
        const earlier = await insertMessage(h.dataSource, scene.id, {
          content: 'tira o coelho e coloca uma placa com "Oferta"',
          role: 'user',
        });
        await h.dataSource.manager.update(
          TemplateScene,
          { id: scene.id },
          { brief: [{ ...OLD, sourceMessageId: earlier.id }] },
        );
        const sent = await h.post(scene.id, 'sim, faz');
        const { client } = h.directorClient(async () =>
          directorAnswer({
            turn_kind: 'pedido_item',
            will_change_image: true,
            reply: 'Vou colocar a placa com a frase “Oferta”.',
            what_to_change: 'Add a modest sign',
            exact_text: ['Oferta'],
            requests: [{ id: 'p1', text: 'placa com “Oferta”', action: 'open', quote: null }],
          }),
        );
        await h
          .directorProcessor(client)
          .process({ sceneId: scene.id, versionId: sent.versionId }, 'job-d');

        expect((await h.versionOf(sent.versionId)).status).toBe('queued');
        const [item] = (await h.sceneOf(scene.id)).brief;
        expect(item).toMatchObject({ id: 'p1', status: 'open' });
        const message = (await h.messagesOf(scene.id)).find((m) => m.versionId === sent.versionId);
        expect(item.sourceMessageId).toBe(message?.id);
      });

      it('R84: "sim, faz" com item de duas linhas pedido em turno anterior gera imagem, sem pergunta de contradição', async () => {
        const { scene } = await h.readyScene();
        const earlier = await insertMessage(h.dataSource, scene.id, {
          content: 'coloca uma placa com “Oferta de Páscoa” e embaixo “Compre já”',
          role: 'user',
        });
        await h.dataSource.manager.update(
          TemplateScene,
          { id: scene.id },
          { brief: [{ ...OLD, text: 'placa com duas linhas', sourceMessageId: earlier.id }] },
        );
        const sent = await h.post(scene.id, 'sim, faz');
        const { client } = h.directorClient(async () =>
          directorAnswer({
            turn_kind: 'pedido_item',
            will_change_image: true,
            reply: 'Vou colocar a placa com as duas linhas.',
            what_to_change: 'Add a wooden sign with the requested lettering',
            exact_text: ['Oferta de Páscoa', 'Compre já'],
            requests: [{ id: 'p1', text: 'placa com duas linhas', action: 'open', quote: null }],
          }),
        );
        await h
          .directorProcessor(client)
          .process({ sceneId: scene.id, versionId: sent.versionId }, 'job-d');
        expect((await h.versionOf(sent.versionId)).status).toBe('queued');
        expect(await lastReply(scene.id)).not.toContain('Qual vai na imagem');
      });

      it('Voltar outro dia com outro pedido: o Diretor recebe o item como do turno anterior, e o pedido novo vale', async () => {
        const seen: string[] = [];
        const { scene, version } = await h.runTurn(
          'quantos coelhos tem?',
          async (call) => {
            seen.push(call.text);
            return directorAnswer({ turn_kind: 'pergunta', reply: 'Há 3 coelhos.' });
          },
          { brief: [OLD] },
        );
        expect(seen[0]).toContain('em aberto, do turno anterior');
        expect(seen[0]).toContain('- p1: placa com “Oferta”');
        expect(version.status).toBe('rejected');
        expect(await lastReply(scene.id)).toBe('Há 3 coelhos.');
        expect((await h.sceneOf(scene.id)).brief[0].status).toBe('superseded');
      });

      it('o turno seguinte não recebe o item superado como aberto', async () => {
        const first = await h.runTurn(
          'quantos coelhos tem?',
          async () => directorAnswer({ turn_kind: 'pergunta', reply: 'Há 3 coelhos.' }),
          { brief: [OLD] },
        );
        const sent = await h.post(first.scene.id, 'e ovos?');
        const seen: string[] = [];
        const { client } = h.directorClient(async (call) => {
          seen.push(call.text);
          return directorAnswer({ turn_kind: 'pergunta', reply: 'Há 5 ovos.' });
        });
        await h
          .directorProcessor(client)
          .process({ sceneId: first.scene.id, versionId: sent.versionId });
        expect(seen[0]).toContain('em aberto, do turno anterior: nenhum.');
        expect(seen[0]).not.toContain('placa com “Oferta”');
      });
    });
  },
);
