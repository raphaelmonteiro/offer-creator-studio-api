import { PlanOverrides } from '../testing/scene-director-fixtures';
import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { DirectorPlan } from '../domain/scene-director-schema';
import { directorAnswer, useDirectorHarness } from '../testing/scene-director-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

const open = (text: string) => ({ id: null, text, action: 'open' as const, quote: null });
const item = (extra: PlanOverrides): PlanOverrides => ({
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

    describe('G3: o pedido de escrita não é recusado (D-51)', () => {
      it('Pedido normal não vira recusa nem pergunta: plano com escrita no pedido segue, sem refazer', async () => {
        const { version, plan } = await h.runTurn(
          'deixa mais bonito',
          item({ what_to_change: 'write FELIZ PASCOA in big letters at the top' }),
        );
        expect(plan).toHaveBeenCalledTimes(1);
        expect(version.status).toBe('queued');
        expect(imageJobs()).toHaveLength(1);
      });

      it('Preservação com texto pintado segue como veio: o código não filtra por conteúdo', async () => {
        const { version, plan } = await h.runTurn(
          'mais flores',
          item({
            what_to_change: 'mais flores',
            inventory_keep: ['the title lettering', 'the store logo', 'the bunny'],
          }),
        );
        expect(plan).toHaveBeenCalledTimes(1);
        expect((version.metrics.plan as DirectorPlan).image?.preserve).toEqual([
          'the title lettering',
          'the store logo',
          'the bunny',
        ]);
      });

      it('Pedido disfarçado de escrita: a placa sem exact_text segue, e o prompt termina em "No text"', async () => {
        const { version } = await h.runTurn(
          'coloca uma placa de boas-vindas',
          item({ what_to_put: 'a welcome sign' }),
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

    describe('Região marcada sem marcação (D-51)', () => {
      it('nas duas chamadas a versão falha com DIRECTOR_UNAVAILABLE, sem imagem', async () => {
        const { version, plan } = await h.runTurn('tira esse coelho', async () => {
          const raw = JSON.stringify(item({ what_to_change: 'remove the bunny' })).replace(
            '"zone":"whole"',
            '"zone":"marked"',
          );
          return directorAnswer(raw);
        });
        expect(plan).toHaveBeenCalledTimes(2);
        expect(version).toMatchObject({ status: 'failed', errorCode: 'DIRECTOR_UNAVAILABLE' });
        expect(imageJobs()).toHaveLength(0);
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
