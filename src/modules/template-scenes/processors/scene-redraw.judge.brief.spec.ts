import { SceneVisionClient } from '../providers/scene-vision-client';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { directorPlan } from '../testing/scene-director-fixtures';
import { useProcessorHarness } from '../testing/scene-processor-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

const verdict = (extra: Record<string, unknown> = {}) => ({
  atendeu: 'sim',
  mudou: 'O coelho da direita saiu.',
  vistos: [],
  nao_vistos: [],
  texto_na_imagem: false,
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
    if (options.brief)
      await h.dataSource.manager.update(TemplateScene, { id: scene.id }, { brief: options.brief });
    const fresh = await h.sceneOf(scene.id);
    const queued = await h.queueRedraw(fresh, {
      plan,
      request: options.message ?? 'tira o coelho da direita',
    });
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
    const rio = (status: 'open' | 'done') => ({
      id: 'p1',
      text: 'um rio no meio',
      status,
      sourceMessageId: 'm',
      updatedAt: '2026-11-06T12:00:00.000Z',
    });

    it('Fecha pelo juiz: o rio visto vira feito, e o próximo prompt não o traz como aberto', async () => {
      const { scene, version } = await run(judgeReturning(verdict({ vistos: ['p1'] })), {
        brief: [rio('open')],
      });
      expect((await h.sceneOf(scene.id)).brief[0].status).toBe('done');
      expect(version.metrics.judgeBrief).toMatchObject({ closed: ['p1'] });
    });

    it('Continua em aberto: o juiz não viu o rio, o chat diz "Ainda não vi na imagem: um rio no meio" e o próximo prompt ainda o leva', async () => {
      const { scene, reply, edit } = await run(judgeReturning(verdict({ nao_vistos: ['p1'] })), {
        brief: [rio('open')],
      });
      expect(reply).toContain('Ainda não vi na imagem: um rio no meio.');
      expect((await h.sceneOf(scene.id)).brief[0].status).toBe('open');
      // D-54: a edição pede uma mudança só, então a linha de pedidos em aberto não entra no prompt.
      expect(edit.mock.calls[0][0].prompt).not.toContain('em aberto');
    });

    it('Item feito some da imagem: o juiz não vê mais o rio, o item reabre, o chat relata e nenhuma imagem é refeita sozinha', async () => {
      const { scene, reply, edit } = await run(judgeReturning(verdict({ nao_vistos: ['p1'] })), {
        brief: [rio('done')],
      });
      expect((await h.sceneOf(scene.id)).brief[0].status).toBe('open');
      expect(reply).toContain('Ainda não vi na imagem: um rio no meio.');
      // nenhuma chamada de imagem é refeita sozinha: a única é a do próprio turno
      expect(edit).toHaveBeenCalledTimes(1);
    });

    it('juiz indisponível: a lista não muda, ninguém fecha item', async () => {
      const failing = {
        client: { compare: jest.fn().mockRejectedValue(new Error('x')) } as SceneVisionClient,
      };
      const { scene } = await run(failing, { brief: [rio('open')] });
      expect((await h.sceneOf(scene.id)).brief[0].status).toBe('open');
    });
  });
});
