import { SceneVisionClient } from '../providers/scene-vision-client';
import { visionReadings } from '../testing/scene-vision-fake';
import { runTextRound, TextRoundOptions } from '../testing/scene-text-round';
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
const judgeReading = (reads: Array<string | null>, extra: Record<string, unknown> = {}) =>
  visionReadings(
    reads.map((lido) => (lido === null ? [] : [{ pedido: ASKED, lido }])),
    extra,
  );

describeIfSceneDb('Texto pintado conferido letra por letra (banco chroma_x_e2e)', () => {
  jest.setTimeout(60_000);
  const h = useProcessorHarness();

  const run = (
    judge: { client: SceneVisionClient; compare?: jest.Mock },
    options: Partial<TextRoundOptions> & { env?: Record<string, string> } = {},
  ) => runTextRound(h, judge, { plan: sign(), ...options }).then((round) => ({ ...round, judge }));

  it('Texto certo: uma só chamada de imagem, e o chat diz que conferiu letra por letra', async () => {
    const { version, edit, reply } = await run(judgeReading([ASKED]));
    expect(edit).toHaveBeenCalledTimes(1);
    expect(version.status).toBe('ready');
    expect(reply).toContain(`Conferi o texto letra por letra: “${ASKED}”.`);
    expect(version.metrics.paintedText).toEqual([{ text: ASKED, zone: 'whole' }]);
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

  describe('Camadas no mesmo turno da imagem (D-55)', () => {
    const TEXT_LAYER = {
      id: 'txt-1',
      kind: 'text' as const,
      name: 'Texto 1',
      x: 0.5,
      y: 0.92,
      w: 0.6,
      aspect: 5,
      rotation: 0,
      z: 1,
      text: ASKED,
    };

    it('Plano com imagem e camada: a versão nova traz a imagem e a camada de texto, no lugar do plano', async () => {
      const plan = directorPlan({
        turn_kind: 'pedido_item',
        will_change_image: true,
        what_to_change: 'Add a modest wooden sign',
        layer_ops: [
          {
            op: 'set_text',
            layer: null,
            text: { value: ASKED, placement: 'none' },
            position: { side: 'right', zone: 'footer' },
            replace: false,
          },
        ],
      });
      const { version, reply } = await run(judgeReading([ASKED]), { plan });
      expect(version.status).toBe('ready');
      expect(version.elements.map((e) => e.kind)).toContain('text');
      expect(version.elements.find((e) => e.kind === 'text')?.x).toBeCloseTo(0.66, 2);
      expect(reply).toContain(
        'Coloquei a frase “Promoção de Páscoa” como camada de texto no rodapé, à direita.',
      );
    });

    it('Plano com imagem e camada: se a imagem falha, nenhuma camada é criada, e o chat diz', async () => {
      const { scene } = await h.readyScene();
      const queued = await h.queueRedraw(await h.sceneOf(scene.id), {
        plan: directorPlan({
          turn_kind: 'pedido_item',
          will_change_image: true,
          what_to_change: 'Add a modest wooden sign',
          layer_ops: [
            {
              op: 'set_text',
              layer: null,
              text: { value: ASKED, placement: 'none' },
              position: null,
              replace: false,
            },
          ],
        }),
        request: 'coloca a placa',
      });
      const { provider } = h.fakeProvider(() => Promise.reject(new Error('falhou')));
      await h.processorWith(provider).process(h.job(scene.id, queued.id));
      const version = await h.versionOf(queued.id);
      expect(version.status).toBe('failed');
      expect(version.elements).toEqual([]);
      const last = (await h.messagesOf(scene.id)).filter((m) => m.role === 'assistant').pop();
      expect(last?.content).toContain('Nenhuma camada foi alterada.');
    });

    it('Pintar a frase que é camada: a versão nova não tem mais a camada, e a anterior a mantém para o "volta"', async () => {
      const { scene } = await h.readyScene();
      const parentId = scene.currentVersionId as string;
      await h.dataSource.manager.update(
        'template_scene_versions',
        { id: parentId },
        { elements: [TEXT_LAYER] },
      );
      const queued = await h.queueRedraw(await h.sceneOf(scene.id), {
        plan: sign(),
        request: 'eu queria um efeito como se tivesse sido escrito na madeira',
      });
      const { provider } = h.fakeProvider(() => h.okResult(0.1));
      await h
        .processorWith(provider, undefined, judgeReading([ASKED]).client)
        .process(h.job(scene.id, queued.id));
      const version = await h.versionOf(queued.id);
      expect(version.status).toBe('ready');
      expect(version.elements.filter((e) => e.kind === 'text')).toEqual([]);
      expect((await h.versionOf(parentId)).elements.map((e) => e.id)).toEqual(['txt-1']);
    });
  });
});
