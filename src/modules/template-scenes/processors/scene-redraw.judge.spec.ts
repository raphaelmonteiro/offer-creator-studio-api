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

describeIfSceneDb('O juiz confere e o resultado é sempre aplicado (banco chroma_x_e2e)', () => {
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
    expect(version.metrics.notApplied).toBeUndefined();
  });

  it('Juiz parcial: a versão vira a atual, e o chat diz que atendeu em parte', async () => {
    const judge = judgeReturning(verdict({ atendeu: 'parcial', mudou: 'Saiu um dos coelhos.' }));
    const { version, reply } = await run(judge);
    expect(version.status).toBe('ready');
    expect(reply).toBe(
      'Conferi a imagem nova e o pedido foi atendido em parte: Saiu um dos coelhos. Diga o que ajustar ou peça para voltar.',
    );
  });

  describe('Juiz indisponível', () => {
    it.each([
      [
        'a chamada falha',
        () => ({
          client: {
            compare: jest.fn().mockRejectedValue(new Error('HTTP 500')),
          } as SceneVisionClient,
        }),
      ],
      ['a resposta não é JSON', () => judgeReturning('texto solto')],
    ])(
      'quando %s: a versão vira a atual e o chat diz que não conseguiu conferir',
      async (_name, make) => {
        const { scene, queued, version, reply } = await run(make());
        expect(version.status).toBe('ready');
        expect((await h.sceneOf(scene.id)).currentVersionId).toBe(queued.id);
        expect(reply).toBe(
          'Apliquei a imagem nova, mas não consegui conferir o resultado. Veja se ficou como pediu.',
        );
        expect(version.metrics.judge).toEqual({ available: false });
      },
    );

    it('o juiz passa de 20 s: o resultado vale, e o chat diz que não conseguiu conferir', async () => {
      const hanging = {
        client: {
          compare: jest.fn().mockReturnValue(new Promise(() => undefined)),
        } as SceneVisionClient,
      };
      const { version, reply } = await run(hanging, {
        env: { TEMPLATE_SCENE_VISION_TIMEOUT_MS: '30' },
      });
      expect(version.status).toBe('ready');
      expect(reply).toContain('não consegui conferir');
    });
  });

  it('Limite de chamadas: o limite impede o juiz, a versão vira a atual e o chat diz que não conseguiu conferir', async () => {
    const judge = judgeReturning(verdict());
    const { version, reply } = await run(judge, {
      env: { TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE: '1' },
    });
    expect(judge.compare).not.toHaveBeenCalled();
    expect(version.status).toBe('ready');
    expect(reply).toContain('não consegui conferir');
  });

  it('o juiz recebe as imagens inteiras em JPEG, a mensagem e o plano, e o custo vai em metrics.calls', async () => {
    const judge = judgeReturning(verdict());
    const { version } = await run(judge);
    const call = judge.compare.mock.calls[0][0];
    expect(call.prompt).toContain('Mensagem do cliente: "tira o coelho da direita"');
    expect(call.prompt).toContain('pode estar errado');
    expect(call.before).toBeInstanceOf(Buffer);
    expect(call.before.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(call.after.subarray(0, 2).toString('hex')).toBe('ffd8');
    const calls = version.metrics.calls as Array<{ kind: string; costUsd: number }>;
    expect(calls.map((c) => c.kind)).toEqual(['edit', 'vision']);
    expect(calls[1].costUsd).toBe(0.0004);
    expect(version.providerCostUsd).toBeCloseTo(0.0604, 6);
  });

  describe('O chat só afirma o que foi conferido', () => {
    it('Resposta sem promessa de preservação: o chat nunca diz que o resto foi preservado', async () => {
      const { reply } = await run(judgeReturning(verdict()));
      expect(reply).not.toMatch(/preserv|nada mudou|fora da área|idêntic|exatamente como/i);
    });

    it('Juiz escreve frase proibida: o cliente vê o texto fixo, sem essa frase', async () => {
      const judge = judgeReturning(verdict({ mudou: 'Tudo foi preservado exceto o coelho.' }));
      const { reply } = await run(judge);
      expect(reply).toBe('Conferi a imagem nova: O pedido aparece atendido.');
      expect(reply).not.toMatch(/preserv/i);
    });

    it('Inventário inventado: a palavra "rio" do inventory_keep não aparece no que o cliente lê', async () => {
      const { reply, edit } = await run(judgeReturning(verdict()));
      expect(edit.mock.calls[0][0].prompt).toContain('rio ao fundo');
      expect(reply).not.toContain('rio');
    });

    it('Objeto errado: o juiz não atendeu, e o chat não diz que acertou', async () => {
      const judge = judgeReturning(
        verdict({ atendeu: 'nao', mudou: 'Saiu outro objeto, não o coelho.' }),
      );
      const { reply } = await run(judge);
      expect(reply).toContain('o pedido não aparece atendido');
      expect(reply).not.toMatch(/acertei|conferi a imagem nova: /i);
    });

    it('Texto na imagem: o chat relata que viu texto e que fica melhor como camada', async () => {
      const { reply, version } = await run(judgeReturning(verdict({ texto_na_imagem: true })));
      expect(version.status).toBe('ready');
      expect(reply).toBe(
        'Conferi a imagem nova: O coelho da direita saiu. Vi texto na imagem nova; se quiser texto, ele fica melhor como camada.',
      );
    });
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
      expect(edit.mock.calls[0][0].prompt).toContain(
        'Pedidos do cliente ainda em aberto: um rio no meio.',
      );
    });

    it('item feito que o juiz não vê mais depois do redesenho reabre, e o chat relata', async () => {
      const { scene, reply } = await run(judgeReturning(verdict({ nao_vistos: ['p1'] })), {
        brief: [rio('done')],
      });
      expect((await h.sceneOf(scene.id)).brief[0].status).toBe('open');
      expect(reply).toContain('Ainda não vi na imagem: um rio no meio.');
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
