import { ImageZone } from '../domain/scene-director-schema';
import { directorPlan } from '../testing/scene-director-fixtures';
import { SceneProviderError } from '../providers/scene-image-provider';
import { runNextRound, runTextRound } from '../testing/scene-text-round';
import { judgePromptOf, visionReadings } from '../testing/scene-vision-fake';
import { useProcessorHarness } from '../testing/scene-processor-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { judgeOf } from '../services/scene-views';

const PROMO = 'Promoção de Páscoa';
const FRETE = 'Frete grátis';
const OFERTA = 'Oferta de Páscoa';
const END = 'Never invent or add text, prices or logos. No other text, no logo, no watermark.';

const plan = (exact: string[], zone: ImageZone = 'whole') => {
  const base = directorPlan({
    turn_kind: 'pedido_item',
    will_change_image: true,
    what_to_change: 'Add one modest wooden sign',
    exact_text: exact,
  });
  return {
    ...base,
    image: { ...(base.image as object), region: { zone, side: null } },
  } as ReturnType<typeof directorPlan>;
};
const read = (...pairs: Array<[string, string]>) =>
  pairs.map(([pedido, lido]) => ({ pedido, lido }));

describeIfSceneDb('Texto pintado: zona, bloco 8 e conferência (banco chroma_x_e2e)', () => {
  jest.setTimeout(60_000);
  const h = useProcessorHarness();
  const lastLine = (prompt: string) => prompt.trim().split('\n').pop();

  describe('Bloco 8 com o texto a manter (R65)', () => {
    it('Texto novo em outra zona mantém o pintado', async () => {
      const painted = [{ text: PROMO, zone: 'footer' }];
      const judge = visionReadings([read([FRETE, FRETE], [PROMO, PROMO])]);
      const { edit, version } = await runTextRound(h, judge, {
        plan: plan([FRETE], 'header'),
        request: 'coloca "Frete grátis" no topo',
        painted,
      });
      const prompt = edit.mock.calls[0][0].prompt;
      expect(prompt).toContain(`Line 1: “${FRETE}”`);
      expect(prompt).toContain(
        `Keep the text already painted on the image exactly as it is, in the same place:\n“${PROMO}”`,
      );
      expect(prompt.indexOf(`“${FRETE}”`)).toBeLessThan(prompt.indexOf(`“${PROMO}”`));
      expect(lastLine(prompt)).toBe(END);
      expect(version.metrics.paintedText).toEqual([
        { text: FRETE, zone: 'header' },
        { text: PROMO, zone: 'footer' },
      ]);
    });

    it('Troca na mesma zona substitui o pintado', async () => {
      const judge = visionReadings([read([OFERTA, OFERTA])]);
      const { edit, version } = await runTextRound(h, judge, {
        plan: plan([OFERTA], 'footer'),
        request: 'troca o texto da placa para "Oferta de Páscoa"',
        painted: [{ text: PROMO, zone: 'footer' }],
      });
      const prompt = edit.mock.calls[0][0].prompt;
      expect(prompt).not.toContain(PROMO);
      expect(prompt).not.toContain('Keep the text already painted');
      expect(version.metrics.paintedText).toEqual([{ text: OFERTA, zone: 'footer' }]);
    });

    it('Linha herdada de outra zona, ou sem zona gravada, é mantida', async () => {
      const judge = visionReadings([read([OFERTA, OFERTA], [PROMO, PROMO], [FRETE, FRETE])]);
      const { edit, version } = await runTextRound(h, judge, {
        plan: plan([OFERTA], 'footer'),
        painted: [PROMO, { text: FRETE, zone: 'header' }],
      });
      const prompt = edit.mock.calls[0][0].prompt;
      expect(prompt).toContain(`“${PROMO}”\n“${FRETE}”`);
      expect(version.metrics.paintedText).toEqual([
        { text: OFERTA, zone: 'footer' },
        { text: PROMO },
        { text: FRETE, zone: 'header' },
      ]);
    });

    it('A linha herdada repetida pela rodada vale uma vez, com a zona da rodada', async () => {
      const judge = visionReadings([read([PROMO, PROMO], [FRETE, FRETE])]);
      const { edit, version } = await runTextRound(h, judge, {
        plan: plan([PROMO, FRETE], 'footer'),
        painted: [{ text: PROMO, zone: 'footer' }],
      });
      expect(edit.mock.calls[0][0].prompt).not.toContain('Keep the text already painted');
      expect(version.metrics.paintedText).toEqual([
        { text: PROMO, zone: 'footer' },
        { text: FRETE, zone: 'footer' },
      ]);
    });

    it('Sem texto novo mantém o pintado, e o bloco termina em "No other text"', async () => {
      const judge = visionReadings([read([PROMO, PROMO])]);
      const { edit, version } = await runTextRound(h, judge, {
        plan: plan([], 'footer'),
        request: 'coloca mais margaridas no rodapé',
        painted: [{ text: PROMO, zone: 'footer' }],
      });
      const prompt = edit.mock.calls[0][0].prompt;
      expect(prompt).toContain(`Line 1: “${PROMO}”`);
      expect(prompt).not.toContain('No text, no letters');
      expect(lastLine(prompt)).toBe(END);
      expect(version.metrics.paintedText).toEqual([{ text: PROMO, zone: 'footer' }]);
    });

    it('A marcação decide a zona: a caixa no topo substitui só o texto do topo', async () => {
      const judge = visionReadings([read([OFERTA, OFERTA], [PROMO, PROMO])]);
      const { scene } = await h.readyScene();
      const current = await h.versionOf(scene.currentVersionId as string);
      await h.dataSource.manager.update(
        'template_scene_versions',
        { id: current.id },
        {
          metrics: {
            ...current.metrics,
            paintedText: [
              { text: PROMO, zone: 'footer' },
              { text: FRETE, zone: 'header' },
            ],
          },
        },
      );
      const queued = await h.queueRedraw(await h.sceneOf(scene.id), {
        plan: plan([OFERTA], 'marked'),
        request: 'troca o texto de cima para "Oferta de Páscoa"',
        overrides: { requestedRegion: { x: 0.1, y: 0.02, w: 0.8, h: 0.05 } },
      });
      const { provider, edit } = h.fakeProvider(() => h.okResult(0.1));
      await h.processorWith(provider, undefined, judge.client).process(h.job(scene.id, queued.id));
      const prompt = edit.mock.calls[0][0].prompt;
      expect(prompt).toContain(`“${PROMO}”`);
      expect(prompt).not.toContain(FRETE);
      expect((await h.versionOf(queued.id)).metrics.paintedText).toEqual([
        { text: OFERTA, zone: 'header' },
        { text: PROMO, zone: 'footer' },
      ]);
    });
  });

  describe('Conferência do já pintado numa rodada com texto novo (R65)', () => {
    it('Texto já pintado conferido numa rodada com texto novo: duas linhas esperadas, uma só refação', async () => {
      const judge = visionReadings([
        read([FRETE, FRETE], [PROMO, 'Promoçao de Páscoa']),
        read([FRETE, FRETE], [PROMO, PROMO]),
      ]);
      const { edit, version, reply } = await runTextRound(h, judge, {
        plan: plan([FRETE], 'header'),
        request: 'coloca "Frete grátis" no topo',
        painted: [{ text: PROMO, zone: 'footer' }],
      });
      expect(judgePromptOf(judge.compare, 0)).toContain(FRETE);
      expect(judgePromptOf(judge.compare, 0)).toContain(PROMO);
      expect(edit).toHaveBeenCalledTimes(2);
      expect(judge.compare).toHaveBeenCalledTimes(2);
      expect(edit.mock.calls[1][0].prompt).toContain(
        `A previous attempt rendered the text as “Promoçao de Páscoa”. It must read exactly “${PROMO}”.`,
      );
      expect(reply).toContain('Conferi o texto letra por letra');
      expect(version.metrics.paintedText).toEqual([
        { text: FRETE, zone: 'header' },
        { text: PROMO, zone: 'footer' },
      ]);
    });
  });

  describe('Juiz sem leitura: a linha pedida fica marcada como não conferida (PV-94)', () => {
    const unavailable = () => ({
      client: { compare: jest.fn().mockRejectedValue(new Error('x')) },
    });

    it('a linha enviada ao modelo fica em paintedText com unchecked, e a rodada seguinte a mantém', async () => {
      const first = await runTextRound(h, unavailable() as never, {
        plan: plan([PROMO], 'footer'),
      });
      expect(first.version.metrics.paintedText).toEqual([
        { text: PROMO, zone: 'footer', unchecked: true },
      ]);

      const judge = visionReadings([read([PROMO, PROMO])]);
      const next = await runNextRound(h, judge, {
        sceneId: first.sceneId,
        options: { plan: plan([], 'footer') },
      });
      const prompt = next.edit.mock.calls[0][0].prompt;
      expect(prompt).toContain(`Line 1: “${PROMO}”`);
      expect(prompt).not.toContain('No text, no letters');
      expect(judgePromptOf(judge.compare)).toContain(PROMO);
      expect(next.version.metrics.paintedText).toEqual([{ text: PROMO, zone: 'footer' }]);
    });

    it('a linha herdada não conferida segue não conferida enquanto o juiz não a lê', async () => {
      const { version } = await runTextRound(h, unavailable() as never, {
        plan: plan([], 'footer'),
        painted: [{ text: PROMO, zone: 'footer', unchecked: true }],
      });
      expect(version.metrics.paintedText).toEqual([
        { text: PROMO, zone: 'footer', unchecked: true },
      ]);
    });
  });

  describe('Falha do provedor e limite na refação (rodada 6)', () => {
    const WRONG = 'Promocão de Páscoa';

    it('Falha do provedor na refação: a primeira imagem vale, judge parcial, custo registrado', async () => {
      const judge = visionReadings([read([PROMO, WRONG])]);
      const { scene, version, edit, reply } = await runTextRound(h, judge, {
        plan: plan([PROMO]),
        provider: (_input, call) =>
          call === 0
            ? h.okResult(0.1)
            : Promise.reject(new SceneProviderError('PROVIDER_ERROR', 'caiu', 0.02)),
      });
      expect(edit).toHaveBeenCalledTimes(2);
      expect(version.status).toBe('ready');
      expect((await h.sceneOf(scene.id)).currentVersionId).toBe(version.id);
      expect(judgeOf(version)).toBe('parcial');
      expect(reply).toContain(`Pedi “${PROMO}” e li “${WRONG}”`);
      expect(reply).toContain('Tentei refazer, mas a segunda tentativa falhou.');
      const check = version.metrics.textCheck as {
        attempts: Array<Record<string, unknown>>;
        applied: number;
      };
      expect(check.applied).toBe(1);
      expect(check.attempts).toHaveLength(2);
      expect(check.attempts[1]).toMatchObject({
        attempt: 2,
        failed: true,
        errorCode: 'PROVIDER_ERROR',
      });
      const calls = version.metrics.calls as Array<{ kind: string; status: string }>;
      expect(calls.map((call) => `${call.kind}:${call.status}`)).toEqual([
        'edit:done',
        'vision:done',
        'edit:failed',
      ]);
      expect(version.metrics.paintedText).toEqual([]);
    });

    it('Limite impede a segunda conferência: a segunda imagem vale, sem segundo juiz, e o chat diz que não conferiu', async () => {
      const judge = visionReadings([read([PROMO, WRONG])]);
      const { version, edit, reply } = await runTextRound(h, judge, {
        plan: plan([PROMO], 'footer'),
        env: { TEMPLATE_SCENE_MAX_PAID_CALLS_PER_MESSAGE: '3' },
      });
      expect(edit).toHaveBeenCalledTimes(2);
      expect(judge.compare).toHaveBeenCalledTimes(1);
      expect(version.status).toBe('ready');
      expect(judgeOf(version)).toBeNull();
      expect(reply).not.toContain('Conferi o texto');
      expect(reply).toContain(
        `Refiz a imagem porque o texto saiu diferente do pedido, mas não conferi a segunda tentativa: atingi o limite de chamadas deste pedido. Veja se o texto ficou “${PROMO}”.`,
      );
      expect(version.metrics.paintedText).toEqual([
        { text: PROMO, zone: 'footer', unchecked: true },
      ]);
    });

    it('Segundo juiz com saída inválida: aplica a segunda e diz que não conseguiu conferir, sem falar de limite', async () => {
      const first = visionReadings([read([PROMO, WRONG])]);
      const compare = jest
        .fn()
        .mockResolvedValueOnce(await first.compare())
        .mockRejectedValue(new Error('x'));
      const { version, reply } = await runTextRound(
        h,
        { client: { compare } },
        { plan: plan([PROMO]) },
      );
      expect(version.status).toBe('ready');
      expect(reply).toContain('não consegui conferir a segunda tentativa');
      expect(reply).not.toContain('limite');
      expect(reply).not.toContain('Conferi o texto');
    });
  });
});
