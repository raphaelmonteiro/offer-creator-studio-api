import { SceneVisionClient } from '../providers/scene-vision-client';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { directorPlan } from '../testing/scene-director-fixtures';
import { judgeOf } from '../services/scene-views';
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

    it.each([
      [
        'nao',
        'Apliquei a imagem nova, mas na conferência o pedido não aparece atendido. Diga o que ajustar',
      ],
      ['parcial', 'Conferi a imagem nova e o pedido foi atendido em parte. Diga o que ajustar'],
    ])(
      'R6: com mudou barrado e veredito %s, o chat não diz "O pedido aparece atendido"',
      async (atendeu, expected) => {
        const { reply } = await run(
          judgeReturning(verdict({ atendeu, mudou: 'tudo foi preservado exceto o coelho' })),
        );
        expect(reply).toContain(expected);
        expect(reply).not.toContain('O pedido aparece atendido');
      },
    );

    it('Juiz vê emenda: a versão vira a atual, o chat dá o aviso com a descrição e nenhuma outra imagem é chamada', async () => {
      const judge = judgeReturning(
        verdict({ emenda: true, emenda_descricao: 'grupo sobre uma faixa de grama flutuando' }),
      );
      const { scene, queued, edit, version, reply } = await run(judge);
      expect(version.status).toBe('ready');
      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(queued.id);
      expect(reply).toBe(
        'Conferi a imagem nova: O coelho da direita saiu. Na conferência, vi o que parece uma emenda ou um objeto flutuando: grupo sobre uma faixa de grama flutuando. Diga o que ajustar ou peça para voltar.',
      );
      expect(edit).toHaveBeenCalledTimes(1);
      expect(version.metrics.judge).toMatchObject({ seam: true });
    });

    it('Emenda na primeira imagem: só há o DEPOIS, e o chat dá o mesmo aviso', async () => {
      const { scene } = await h.readyScene();
      const fresh = await h.sceneOf(scene.id);
      const queued = await h.queueRedraw(fresh, {
        plan,
        request: 'gera um template de pascoa',
        operation: 'generate',
        overrides: { parentVersionId: null },
      });
      const judge = judgeReturning(
        verdict({ emenda: true, emenda_descricao: 'corte brusco no meio' }),
      );
      const { provider } = h.fakeProvider(() => h.okResult(0.06));
      await h.processorWith(provider, undefined, judge.client).process(h.job(scene.id, queued.id));
      const messages = await h.dataSource.manager.find(TemplateSceneMessage, {
        where: { sceneId: scene.id, versionId: queued.id, role: 'assistant' },
      });
      expect((await h.versionOf(queued.id)).status).toBe('ready');
      expect(messages[0].content).toContain(
        'Na conferência, vi o que parece uma emenda ou um objeto flutuando: corte brusco no meio. Diga o que ajustar ou peça para voltar.',
      );
    });

    it('Juiz não vê emenda: o chat não fala de emenda nem afirma que a imagem está sem emenda', async () => {
      const { reply } = await run(judgeReturning(verdict({ emenda: false })));
      expect(reply).not.toMatch(/emenda|flutuando/i);
    });

    it('Descrição de emenda barrada: o chat dá o aviso sem a descrição', async () => {
      const { reply } = await run(
        judgeReturning(verdict({ emenda: true, emenda_descricao: 'o resto foi preservado' })),
      );
      expect(reply).toContain(
        'Na conferência, vi o que parece uma emenda ou um objeto flutuando. Diga o que ajustar ou peça para voltar.',
      );
      expect(reply).not.toContain('preservado');
    });

    it('Descrição de emenda vazia: o aviso sai sem a descrição', async () => {
      const { reply } = await run(judgeReturning(verdict({ emenda: true, emenda_descricao: '' })));
      expect(reply).toContain('um objeto flutuando. Diga o que ajustar');
    });

    it('Emenda não muda o veredito: o juiz diz sim com emenda, e a versão guarda sim', async () => {
      const { version } = await run(
        judgeReturning(verdict({ emenda: true, emenda_descricao: 'x' })),
      );
      expect(version.metrics.judge).toMatchObject({ satisfied: 'sim', seam: true });
      expect(judgeOf(version)).toBe('sim');
    });

    it('Texto que ninguém pediu: o chat relata o que viu e oferece tirar, sem afirmar que não há texto', async () => {
      const { reply, version } = await run(judgeReturning(verdict({ texto_extra: 'PROMO' })));
      expect(version.status).toBe('ready');
      expect(reply).toBe(
        'Conferi a imagem nova: O coelho da direita saiu. Vi na imagem um texto que você não pediu: “PROMO”. Diga se quer que eu tire.',
      );
    });
  });
});
