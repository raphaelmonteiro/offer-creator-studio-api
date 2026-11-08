import { TemplateScene } from '../entities/template-scene.entity';
import { SceneVisionClient } from '../providers/scene-vision-client';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { directorPlan } from '../testing/scene-director-fixtures';
import { useProcessorHarness } from '../testing/scene-processor-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

const verdict = (extra: Record<string, unknown> = {}) => ({
  atendeu: 'sim',
  mudou: 'O coelho da direita saiu.',
  vistos: [],
  nao_vistos: [],
  faltou: '',
  texto_lido: [],
  texto_extra: '',
  emenda: false,
  emenda_descricao: '',
  ...extra,
});
const judgeReturning = (
  body: unknown,
  usage: object | null = { prompt_tokens: 3000, completion_tokens: 200 },
) => {
  const compare = jest.fn().mockResolvedValue({
    text: typeof body === 'string' ? body : JSON.stringify(body),
    usage,
    requestId: 'req_judge',
    latencyMs: 700,
  });
  return { client: { compare } as SceneVisionClient, compare };
};
const plan = directorPlan({
  turn_kind: 'pedido_item',
  will_change_image: true,
  what_to_change: 'tirar o coelho da direita',
  inventory_keep: ['rio ao fundo'],
});

describeIfSceneDb('O juiz e a memória do que o cliente pediu (banco chroma_x_e2e)', () => {
  jest.setTimeout(60_000);
  const h = useProcessorHarness();
  afterEach(() => jest.restoreAllMocks());

  async function run(
    judge: { client: SceneVisionClient } | null,
    options: {
      brief?: TemplateScene['brief'];
      env?: Record<string, string>;
      message?: string;
    } = {},
  ) {
    const { scene } = await h.readyScene();
    const fresh = await h.sceneOf(scene.id);
    const queued = await h.queueRedraw(fresh, {
      plan,
      request: options.message ?? 'tira o coelho da direita',
    });
    if (options.brief) await h.setBrief(scene.id, queued.id, options.brief);
    const { provider, edit } = h.fakeProvider(() => h.okResult(0.06));
    await h.processorWith(provider, options.env, judge?.client).process(h.job(scene.id, queued.id));
    const messages = await h.dataSource.manager.find(TemplateSceneMessage, {
      where: { sceneId: scene.id, versionId: queued.id, role: 'assistant' },
    });
    return {
      scene,
      queued,
      edit,
      version: await h.versionOf(queued.id),
      reply: messages[0]?.content ?? '',
    };
  }

  it('Juiz aprova: a versão vira a atual e o chat diz o que foi conferido', async () => {
    const judge = judgeReturning(verdict());
    const { scene, queued, version, reply } = await run(judge);
    expect(version.status).toBe('ready');
    expect((await h.sceneOf(scene.id)).currentVersionId).toBe(queued.id);
    expect(reply).toBe('Conferi a imagem nova: O coelho da direita saiu.');
    expect(version.metrics.judge).toMatchObject({ available: true, satisfied: 'sim' });
  });

  it('Juiz reprova: a versão vira a atual, o chat diz que aplicou e que o pedido não aparece atendido, e nenhuma outra imagem é chamada', async () => {
    const judge = judgeReturning(verdict({ atendeu: 'nao', mudou: 'O coelho continua lá.' }));
    const { scene, queued, edit, version, reply } = await run(judge);
    expect(version.status).toBe('ready');
    expect((await h.sceneOf(scene.id)).currentVersionId).toBe(queued.id);
    expect(reply).toBe(
      'Apliquei a imagem nova, mas na conferência o pedido não aparece atendido: O coelho continua lá. Diga o que ajustar ou use "Voltar para a anterior".',
    );
    expect(edit).toHaveBeenCalledTimes(1);
    expect(version.metrics.judge).toMatchObject({ satisfied: 'nao' });
  });

  it('Juiz parcial: a versão vira a atual, e o chat diz que atendeu em parte', async () => {
    const judge = judgeReturning(verdict({ atendeu: 'parcial', mudou: 'Saiu um dos coelhos.' }));
    const { version, reply } = await run(judge);
    expect(version.status).toBe('ready');
    expect(reply).toBe(
      'Conferi a imagem nova e o pedido foi atendido em parte: Saiu um dos coelhos. Diga o que ajustar ou peça para voltar.',
    );
  });

  describe('memória do que o cliente pediu (G9): só o juiz fecha', () => {
    /** `turn` é item da mensagem do turno; `before` é item aberto num turno anterior (D-59). */
    const rio = (status: 'open' | 'done', source: 'turn' | 'before' = 'turn') => ({
      id: 'p1',
      text: 'um rio no meio',
      status,
      sourceMessageId: source === 'turn' ? 'turn' : 'm-anterior',
      updatedAt: '2026-11-06T12:00:00.000Z',
    });
    const statusOf = async (sceneId: string) => (await h.sceneOf(sceneId)).brief[0].status;

    it('Fecha pelo juiz: o rio visto vira feito, e o próximo prompt não o traz como aberto', async () => {
      const { scene, version } = await run(judgeReturning(verdict({ vistos: ['p1'] })), {
        brief: [rio('open')],
      });
      expect(await statusOf(scene.id)).toBe('done');
      expect(version.metrics.judgeBrief).toMatchObject({ closed: ['p1'] });
    });

    it('O que falta não é pedaço da mensagem: o chat diz a frase "faltou" do juiz, e o item do turno continua em aberto', async () => {
      const { scene, reply, edit } = await run(
        judgeReturning(verdict({ nao_vistos: [], faltou: 'um rio no meio do campo' })),
        { brief: [rio('open')] },
      );
      expect(reply).toContain('Ainda falta: um rio no meio do campo.');
      expect(reply).not.toContain('Ainda não vi na imagem');
      expect(await statusOf(scene.id)).toBe('open');
      // D-54: a edição pede uma mudança só, então a linha de pedidos em aberto não entra no prompt.
      expect(edit.mock.calls[0][0].prompt).not.toContain('em aberto');
    });

    it('Item feito some da imagem: o item continua feito, o chat não diz "Ainda falta" e nenhuma imagem é refeita sozinha', async () => {
      const judge = judgeReturning(verdict({ nao_vistos: ['p1'] }));
      const { scene, reply, edit } = await run(judge, { brief: [rio('done')] });
      expect(await statusOf(scene.id)).toBe('done');
      expect(reply).not.toContain('Ainda falta');
      expect(edit).toHaveBeenCalledTimes(1);
      // O juiz nem recebe o item feito: o pedido a ele só traz os itens do turno (PV-60 mudado por D-59).
      expect(JSON.stringify(judge.compare.mock.calls[0][0])).not.toContain('um rio no meio');
    });

    it('Item de turno anterior em nao_vistos: o id é ignorado, o chat não diz "Ainda falta", e o item fica superado ao fim do turno', async () => {
      const judge = judgeReturning(verdict({ nao_vistos: ['p1'], vistos: [] }));
      const { scene, reply, version } = await run(judge, { brief: [rio('open', 'before')] });
      expect(version.status).toBe('ready');
      expect(reply).toBe('Conferi a imagem nova: O coelho da direita saiu.');
      expect(await statusOf(scene.id)).toBe('superseded');
      expect(version.metrics.briefSuperseded).toEqual(['p1']);
      expect(JSON.stringify(judge.compare.mock.calls[0][0])).not.toContain('um rio no meio');
    });

    it('Item de turno anterior em vistos também é ignorado: ninguém fecha o que não é do turno', async () => {
      const { scene, version } = await run(judgeReturning(verdict({ vistos: ['p1'] })), {
        brief: [rio('open', 'before')],
      });
      expect(await statusOf(scene.id)).toBe('superseded');
      expect(version.metrics.judgeBrief).toMatchObject({ closed: [] });
    });

    it('Ainda falta dito uma vez: o item do turno que sobrou fica superado no turno seguinte', async () => {
      const first = await run(judgeReturning(verdict({ nao_vistos: ['p1'], faltou: '' })), {
        brief: [rio('open')],
      });
      expect(first.reply).toContain('Ainda falta: um rio no meio. Quer que eu faça agora?');
      expect(await statusOf(first.scene.id)).toBe('open');

      // O turno seguinte é outro pedido: o item de ontem entra como "do turno anterior", sem ser cobrado.
      const second = await h.queueRedraw(await h.sceneOf(first.scene.id), {
        plan,
        request: 'deixa o céu mais azul',
        number: 3,
      });
      const judge = judgeReturning(verdict({ nao_vistos: ['p1'] }));
      const { provider } = h.fakeProvider(() => h.okResult(0.06));
      await h
        .processorWith(provider, undefined, judge.client)
        .process(h.job(first.scene.id, second.id));
      const reply = (await h.messagesOf(first.scene.id)).find(
        (m) => m.versionId === second.id && m.role === 'assistant',
      );
      expect(reply?.content).not.toContain('Ainda falta');
      expect(await statusOf(first.scene.id)).toBe('superseded');
    });

    it('Pedido seguinte muda o anterior (repro de B1): placa vazia feita, depois "deixa o texto escrito na madeira", sem "Ainda falta" nesse turno nem no seguinte', async () => {
      const placa = {
        id: 'p1',
        text: 'placa de madeira vazia no rodapé',
        status: 'open' as const,
        sourceMessageId: 'turn',
        updatedAt: '2026-11-06T12:00:00.000Z',
      };
      const first = await run(judgeReturning(verdict({ vistos: ['p1'] })), { brief: [placa] });
      expect(await statusOf(first.scene.id)).toBe('done');

      // Turno 2: a placa recebe o texto, o juiz (que nem recebe o item feito) devolve p1 em nao_vistos e `faltou` vazio.
      const replies: string[] = [];
      for (const [number, request] of [
        [3, 'deixa o texto escrito na madeira'],
        [4, 'deixa o céu mais azul'],
      ] as const) {
        const queued = await h.queueRedraw(await h.sceneOf(first.scene.id), {
          plan,
          request,
          number,
        });
        const { provider } = h.fakeProvider(() => h.okResult(0.06));
        const judge = judgeReturning(verdict({ nao_vistos: ['p1'], faltou: '' }));
        await h
          .processorWith(provider, undefined, judge.client)
          .process(h.job(first.scene.id, queued.id));
        const reply = (await h.messagesOf(first.scene.id)).find(
          (m) => m.versionId === queued.id && m.role === 'assistant',
        );
        replies.push(reply?.content ?? '');
        expect(JSON.stringify(judge.compare.mock.calls[0][0])).not.toContain('placa de madeira');
      }
      expect(replies[0]).not.toContain('Ainda falta');
      expect(replies[1]).not.toContain('Ainda falta');
      expect(await statusOf(first.scene.id)).toBe('done');
    });

    it('juiz indisponível: ninguém fecha item, e o do turno continua aberto', async () => {
      const failing = {
        client: { compare: jest.fn().mockRejectedValue(new Error('x')) } as SceneVisionClient,
      };
      const { scene } = await run(failing, { brief: [rio('open')] });
      expect(await statusOf(scene.id)).toBe('open');
    });
  });
});
