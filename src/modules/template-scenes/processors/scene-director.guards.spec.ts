import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { DirectorPlan } from '../domain/scene-director-schema';
import { directorAnswer, useDirectorHarness } from '../testing/scene-director-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

const open = (text: string) => ({ id: null, text, action: 'open' as const, quote: null });
const item = (extra: Partial<DirectorPlan>): Partial<DirectorPlan> => ({
  turn_kind: 'pedido_item',
  will_change_image: true,
  reply: 'Vou fazer a mudança.',
  ...extra,
});

describeIfSceneDb(
  'Validações do Diretor: pintado, composição e instrução (banco chroma_x_e2e)',
  () => {
    const h = useDirectorHarness();
    const imageJobs = () =>
      h.queue.publish.mock.calls.filter(([queue]) => queue === QUEUES.TEMPLATE_SCENE_TURN);
    const lastReply = async (sceneId: string) =>
      (await h.messagesOf(sceneId)).filter((m) => m.role === 'assistant').pop()?.content;

    describe('G2: plano sem instrução não chama imagem (R5)', () => {
      it.each([
        ['pedido_item', item({})],
        ['reclamacao com will_change_image', item({ turn_kind: 'reclamacao' })],
        ['imagem_nova', item({ turn_kind: 'imagem_nova' })],
      ])(
        '%s com os dois campos vazios: refaz, e persistindo o chat pergunta o que mudar',
        async (_n, plan) => {
          const { scene, version, plan: calls } = await h.runTurn('faz alguma coisa', plan);
          expect(calls).toHaveBeenCalledTimes(2);
          expect(version.status).toBe('rejected');
          expect(await lastReply(scene.id)).toContain('Não entendi o que mudar');
          expect(imageJobs()).toHaveLength(0);
        },
      );

      it('preenchido na segunda chamada, o plano segue', async () => {
        const { version } = await h.runTurn('tira o coelho', async (_c, attempt) =>
          directorAnswer(item(attempt === 1 ? {} : { what_to_change: 'tirar o coelho' })),
        );
        expect(version.status).toBe('queued');
        expect(imageJobs()).toHaveLength(1);
      });
    });

    describe('G3: escrita em todo campo que vai ao modelo (R2, R3, D-45)', () => {
      it('Escrita em what_to_change: nas duas chamadas vira recusa, sem imagem', async () => {
        const { scene, version, plan } = await h.runTurn(
          'deixa mais bonito',
          item({
            what_to_change:
              'escrever FELIZ PASCOA em letras grandes no topo; colocar o preco R$ 9,90',
          }),
        );
        expect(plan).toHaveBeenCalledTimes(2);
        expect(version.status).toBe('rejected');
        expect(await lastReply(scene.id)).toContain('Não pinto');
        expect(imageJobs()).toHaveLength(0);
      });

      it('Escrita em what_to_change corrigida ao refazer: o segundo plano segue e o custo das duas fica', async () => {
        const { version } = await h.runTurn('deixa mais bonito', async (_c, attempt) =>
          directorAnswer(
            item({ what_to_change: attempt === 1 ? 'colocar o titulo' : 'colocar mais flores' }),
          ),
        );
        expect(version.status).toBe('queued');
        const director = version.metrics.director as { calls: unknown[] };
        expect(director.calls).toHaveLength(2);
        expect((version.metrics.plan as DirectorPlan).what_to_change).toBe('colocar mais flores');
      });

      it('Inventário com conteúdo pintado: só o coelho segue, sem refazer', async () => {
        const { version, plan } = await h.runTurn(
          'mais flores',
          item({
            what_to_change: 'mais flores',
            inventory_keep: ['titulo Feliz Pascoa', 'logo da loja', 'preco R$ 9,90', 'coelho'],
          }),
        );
        expect(plan).toHaveBeenCalledTimes(1);
        expect((version.metrics.plan as DirectorPlan).inventory_keep).toEqual(['coelho']);
      });

      it('Diretor declara a escrita: written_content preenchido vira recusa, sem termo conhecido', async () => {
        const { version } = await h.runTurn(
          'coloca uma placa de boas-vindas',
          item({ what_to_put: 'uma placa de boas-vindas', written_content: ['Bem-vindo'] }),
        );
        expect(version.status).toBe('rejected');
        expect(imageJobs()).toHaveLength(0);
      });

      it('Pedido disfarçado que escapa: written_content vazio segue, e a regra de texto fica no prompt', async () => {
        const { version } = await h.runTurn(
          'coloca uma placa de boas-vindas',
          item({ what_to_put: 'uma placa de boas-vindas' }),
        );
        expect(version.status).toBe('queued');
        expect(imageJobs()).toHaveLength(1);
      });

      it('Mencionar não é pedir escrita: "abrir espaço para os preços" segue sem refazer', async () => {
        const { version, plan } = await h.runTurn(
          'preciso de espaço para os preços',
          item({ what_to_change: 'abrir espaço para os preços' }),
        );
        expect(plan).toHaveBeenCalledTimes(1);
        expect(version.status).toBe('queued');
      });
    });

    describe('G4: composição em pedido em aberto (R4)', () => {
      it('"coelho com moldura dourada" em requests, nas duas chamadas: nenhuma imagem, e o chat pergunta se quer moldura', async () => {
        const { scene, version, plan } = await h.runTurn(
          'coloca um coelho',
          item({
            what_to_change: 'colocar um coelho',
            requests: [open('coelho com moldura dourada')],
          }),
        );
        expect(plan).toHaveBeenCalledTimes(2);
        expect(version.status).toBe('rejected');
        expect(await lastReply(scene.id)).toContain('Você quer moldura na imagem?');
        expect(imageJobs()).toHaveLength(0);
        expect((await h.sceneOf(scene.id)).brief).toEqual([]);
      });
    });
  },
);
