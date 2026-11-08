import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { TemplateScene } from '../entities/template-scene.entity';
import { useDirectorHarness } from '../testing/scene-director-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

const entry = (id: string, text: string): TemplateScene['brief'][number] => ({
  id,
  text,
  status: 'open',
  sourceMessageId: 'm0',
  updatedAt: '2026-11-06T12:00:00.000Z',
});
const drop = (id: string | null, quote: string, text = 'rio') => ({
  id,
  text,
  action: 'drop' as const,
  quote,
});
const turn = (requests: ReturnType<typeof drop>[], reply = 'Tudo bem.') => ({
  turn_kind: 'outro' as const,
  will_change_image: false,
  reply,
  requests,
});

describeIfSceneDb(
  '"Esquece isso" e desistência pelo caminho do Diretor (banco chroma_x_e2e)',
  () => {
    const h = useDirectorHarness();
    const imageJobs = () =>
      h.queue.publish.mock.calls.filter(([queue]) => queue === QUEUES.TEMPLATE_SCENE_TURN);
    const lastReply = async (sceneId: string) =>
      (await h.messagesOf(sceneId)).filter((m) => m.role === 'assistant').pop()?.content ?? '';
    const statuses = async (sceneId: string) =>
      (await h.sceneOf(sceneId)).brief.map((b) => [b.id, b.status]);

    it('Esquece isso com um item em aberto: o item fica desistido e o chat diz "Tirei da lista: rio."', async () => {
      const { scene, version, plan } = await h.runTurn(
        'esquece isso',
        turn([drop('p1', 'esquece isso')]),
        {
          brief: [entry('p1', 'rio')],
        },
      );
      expect(plan).toHaveBeenCalledTimes(1);
      expect(version.status).toBe('rejected');
      expect(await statuses(scene.id)).toEqual([['p1', 'dropped']]);
      expect(await lastReply(scene.id)).toBe('Tudo bem. Tirei da lista: rio.');
      expect(imageJobs()).toHaveLength(0);
    });

    it('Esquece isso refere-se ao mais recente: só o rio fica desistido, e o chat diz qual tirou', async () => {
      const { scene } = await h.runTurn('deixa pra la', turn([drop('p2', 'deixa pra la')]), {
        brief: [entry('p1', 'coelho'), entry('p2', 'rio')],
      });
      // D-59: o coelho era de turno anterior e a mensagem não o pede, então fica superado (não desistido).
      expect(await statuses(scene.id)).toEqual([
        ['p1', 'superseded'],
        ['p2', 'dropped'],
      ]);
      expect(await lastReply(scene.id)).toContain('Tirei da lista: rio.');
    });

    it.each([
      ['drop do coelho', [drop('p1', 'esquece isso', 'coelho')]],
      ['nenhum id', [drop(null, 'esquece isso')]],
    ])(
      'Esquece isso com alvo incerto (%s): nada desiste, o chat pergunta citando os dois, sem imagem',
      async (_n, requests) => {
        const { scene, version, plan } = await h.runTurn('esquece isso', turn(requests), {
          brief: [entry('p1', 'coelho'), entry('p2', 'rio')],
        });
        expect(plan).toHaveBeenCalledTimes(1);
        expect(version.status).toBe('rejected');
        expect(await statuses(scene.id)).toEqual([
          ['p1', 'open'],
          ['p2', 'open'],
        ]);
        expect(await lastReply(scene.id)).toBe('Qual destes você quer esquecer: coelho, rio?');
        expect(imageJobs()).toHaveLength(0);
      },
    );

    it('sem item em aberto: o chat diz que não há pedido para esquecer', async () => {
      const { scene } = await h.runTurn('esquece isso', turn([drop(null, 'esquece isso')]));
      expect(await lastReply(scene.id)).toContain('Não há pedido em aberto');
    });

    it('Plural do item: "esquece as flores" desiste do item "flor"', async () => {
      const { scene } = await h.runTurn(
        'esquece as flores',
        turn([drop('p1', 'esquece as flores', 'flores')]),
        {
          brief: [entry('p1', 'flor')],
        },
      );
      expect(await statuses(scene.id)).toEqual([['p1', 'dropped']]);
      expect(await lastReply(scene.id)).toContain('Tirei da lista: flor.');
    });

    it('Citação sem palavra do item: "de" em "muda a cor de fundo" é saída inválida, e o item de turno anterior fica superado', async () => {
      const { scene, version, plan } = await h.runTurn(
        'muda a cor de fundo',
        turn([drop('p1', 'de', 'coelho')]),
        { brief: [entry('p1', 'coelho')] },
      );
      expect(plan).toHaveBeenCalledTimes(2);
      expect(version).toMatchObject({ status: 'failed', errorCode: 'DIRECTOR_UNAVAILABLE' });
      // D-59: a falha também encerra o turno, e o item de turno anterior fica superado.
      expect(await statuses(scene.id)).toEqual([['p1', 'superseded']]);
    });
  },
);
