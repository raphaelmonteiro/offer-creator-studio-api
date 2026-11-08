import { SceneVisionClient } from '../providers/scene-vision-client';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { directorPlan } from '../testing/scene-director-fixtures';
import { judgeOf } from '../services/scene-views';
import { useProcessorHarness } from '../testing/scene-processor-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

const ASKED = 'Promoção de Páscoa';
const sign = (exact: string[] = [ASKED]) =>
  directorPlan({
    turn_kind: 'pedido_item',
    will_change_image: true,
    what_to_change: 'Add one modest wooden sign',
    exact_text: exact,
  });

/** O juiz devolve uma leitura por chamada, na ordem; a última se repete. */
const judgeReading = (reads: Array<string | null>, extra: Record<string, unknown> = {}) => {
  let call = 0;
  const compare = jest.fn(async () => {
    const lido = reads[Math.min(call, reads.length - 1)];
    call += 1;
    return {
      text: JSON.stringify({
        atendeu: 'sim',
        mudou: 'A placa apareceu.',
        vistos: [],
        nao_vistos: [],
        faltou: '',
        texto_lido: lido === null ? [] : [{ pedido: ASKED, lido }],
        texto_extra: '',
        emenda: false,
        emenda_descricao: '',
        ...extra,
      }),
      usage: { prompt_tokens: 3000, completion_tokens: 200 },
      requestId: 'req_judge',
      latencyMs: 500,
    };
  });
  return { client: { compare } as SceneVisionClient, compare };
};

describeIfSceneDb('Texto pintado conferido letra por letra (banco chroma_x_e2e)', () => {
  jest.setTimeout(60_000);
  const h = useProcessorHarness();

  async function run(
    judge: { client: SceneVisionClient; compare?: jest.Mock },
    options: {
      plan?: ReturnType<typeof sign>;
      env?: Record<string, string>;
      painted?: string[];
      metrics?: Record<string, unknown>;
    } = {},
  ) {
    const { scene } = await h.readyScene();
    if (options.painted) {
      const current = await h.versionOf(scene.currentVersionId as string);
      await h.dataSource.manager.update(
        'template_scene_versions',
        { id: current.id },
        { metrics: { ...current.metrics, paintedText: options.painted } },
      );
    }
    const fresh = await h.sceneOf(scene.id);
    const queued = await h.queueRedraw(fresh, {
      plan: options.plan ?? sign(),
      request: 'coloca uma placa com a frase "Promoção de Páscoa"',
    });
    const { provider, edit } = h.fakeProvider(() => h.okResult(0.1));
    await h.processorWith(provider, options.env, judge.client).process(h.job(scene.id, queued.id));
    const messages = await h.dataSource.manager.find(TemplateSceneMessage, {
      where: { sceneId: scene.id, versionId: queued.id, role: 'assistant' },
    });
    const version = await h.versionOf(queued.id);
    return { scene, version, edit, reply: messages[0]?.content ?? '', judge };
  }

  it('Texto certo: uma só chamada de imagem, e o chat diz que conferiu letra por letra', async () => {
    const { version, edit, reply } = await run(judgeReading([ASKED]));
    expect(edit).toHaveBeenCalledTimes(1);
    expect(version.status).toBe('ready');
    expect(reply).toContain(`Conferi o texto letra por letra: “${ASKED}”.`);
    expect(version.metrics.paintedText).toEqual([ASKED]);
    expect(judgeOf(version)).toBe('sim');
  });

  it('Texto errado e refeito com sucesso: a segunda parte da mesma base, com a linha de correção', async () => {
    const { scene, version, edit, reply, judge } = await run(
      judgeReading(['Promocão de Páscoa', ASKED]),
    );
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[1][0].prompt).toContain(
      'A previous attempt rendered the text as “Promocão de Páscoa”. It must read exactly “Promoção de Páscoa”.',
    );
    expect(Buffer.compare(edit.mock.calls[0][0].image, edit.mock.calls[1][0].image)).toBe(0);
    expect(judge.compare).toHaveBeenCalledTimes(2);
    expect(version.status).toBe('ready');
    expect(reply).toContain('Conferi o texto letra por letra');
    expect(reply).not.toContain('saiu diferente');
    expect((await h.sceneOf(scene.id)).currentVersionId).toBe(version.id);
    const check = version.metrics.textCheck as { attempts: unknown[]; applied: number };
    expect(check.applied).toBe(2);
    expect(check.attempts).toHaveLength(2);
    // Refação do texto também custa: duas imagens (0,1 cada) e dois juízes, os quatro registrados.
    expect(version.metrics.calls).toHaveLength(4);
    expect(version.providerCostUsd).toBeGreaterThan(0.2);
  });

  it('Texto errado duas vezes: a segunda imagem vale, judge parcial, sem terceira chamada, e o chat diz a diferença', async () => {
    const { version, edit, reply } = await run(judgeReading(['Promocão de Páscoa']));
    expect(edit).toHaveBeenCalledTimes(2);
    expect(version.status).toBe('ready');
    expect(judgeOf(version)).toBe('parcial');
    expect(reply).toContain(
      'O texto na imagem saiu diferente do pedido. Pedi “Promoção de Páscoa” e li “Promocão de Páscoa”. Tentei duas vezes.',
    );
    expect(version.metrics.paintedText).toEqual([]);
  });

  it('Texto não encontrado: lido vazio nas duas imagens', async () => {
    const { reply, edit } = await run(judgeReading(['']));
    expect(edit).toHaveBeenCalledTimes(2);
    expect(reply).toContain('Não encontrei na imagem o texto “Promoção de Páscoa”.');
  });

  it('Limite impede a refação: a primeira vira a atual, sem segunda imagem, e o chat diz que não refez', async () => {
    const { version, edit, reply } = await run(judgeReading(['Promocão de Páscoa']), {
      env: { TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE: '2' },
    });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(version.status).toBe('ready');
    expect(reply).toContain(
      'Tentei uma vez e não refiz porque atingi o limite de chamadas deste pedido.',
    );
    expect(judgeOf(version)).toBe('parcial');
  });

  it('Juiz indisponível com texto pedido: aplica sem refação e diz que não conseguiu conferir o texto', async () => {
    const failing = { client: { compare: jest.fn().mockRejectedValue(new Error('x')) } };
    const { version, edit, reply } = await run(failing as { client: SceneVisionClient });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(version.status).toBe('ready');
    expect(reply).toContain('Não consegui conferir o texto; veja se ficou como pediu.');
  });

  it('Texto já pintado conferido em outro pedido: a refação acontece, com a mesma regra, e é a única', async () => {
    const { edit, reply } = await run(judgeReading(['Promoçao de Páscoa', 'Promoçao de Páscoa']), {
      plan: sign([]),
      painted: [ASKED],
    });
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[0][0].prompt).toContain('Keep the text already painted');
    expect(edit.mock.calls[1][0].prompt).toContain(
      'A previous attempt rendered the text as “Promoçao de Páscoa”',
    );
    expect(reply).toContain('Tentei duas vezes.');
  });

  it('o texto já pintado que sumiu (o cliente tirou a placa) não é erro nem refação', async () => {
    const { version, edit, reply } = await run(judgeReading(['']), {
      plan: sign([]),
      painted: [ASKED],
    });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(reply).not.toContain('saiu diferente');
    expect(version.metrics.paintedText).toEqual([]);
  });

  it('o texto da rodada que tem exact_text vazio e sem pintado não pede leitura', async () => {
    const { judge, version } = await run(judgeReading([null]), { plan: sign([]) });
    expect(version.metrics.textCheck).toBeUndefined();
    const prompt = (judge.compare?.mock.calls[0] as unknown as Array<{ prompt: string }>)[0].prompt;
    expect(prompt).toContain('Texto esperado na imagem: nenhum.');
  });
});
