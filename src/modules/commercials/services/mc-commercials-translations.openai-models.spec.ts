import { Logger } from '@nestjs/common';
import { APIConnectionTimeoutError } from 'openai';
import {
  chatResponse,
  fakeConfig,
  openAiError,
  sentTo,
  stubSdkChatCreate,
} from '../../ai/utils/openai-chat.testutil';
import { McSceneDerived, McScript, McScriptScene } from '../domain/mc-types';
import { McKitCandidatesService } from './mc-kit-candidates.service';
import { McKitsService } from './mc-kits.service';
import { McTranslationService } from './mc-translation.service';

/**
 * As três traduções dos comerciais (change 42, task 1.12): modelo de OPENAI_FAST_TEXT_MODEL, esforço `none`, teto e
 * prazo por ponto, e a derivação de cena pelo SDK. Cliente simulado, nenhuma chamada paga.
 */
const LUNA = 'gpt-6-luna';
const KIT = { id: 'kit-1', userId: 'u1' };

describe('traduções dos comerciais — modelo e parâmetros por família (42, 1.12)', () => {
  const originalKitProvider = process.env.MC_KIT_PROVIDER;
  const originalTranslationProvider = process.env.MC_TRANSLATION_PROVIDER;
  const config: Record<string, string> = {};
  let create: jest.Mock;
  let appendEvent: jest.Mock;

  beforeEach(() => {
    for (const key of Object.keys(config)) delete config[key];
    config.OPENAI_API_KEY = 'sk-test';
    process.env.MC_KIT_PROVIDER = 'gemini';
    process.env.MC_TRANSLATION_PROVIDER = 'openai';
    appendEvent = jest.fn().mockResolvedValue(undefined);
    create = stubSdkChatCreate();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const [key, value] of [
      ['MC_KIT_PROVIDER', originalKitProvider],
      ['MC_TRANSLATION_PROVIDER', originalTranslationProvider],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** Os serviços sem o resto das dependências: só o que a chamada da tradução lê. */
  const dependencies = () => ({
    config: fakeConfig(config),
    logger: new Logger('teste'),
    commercials: { appendEvent },
    dataSource: { transaction: (cb: (m: unknown) => unknown) => cb({ increment: jest.fn() }) },
  });
  const candidates = () =>
    Object.assign(
      Object.create(McKitCandidatesService.prototype),
      dependencies(),
    ) as McKitCandidatesService;
  const kits = () =>
    Object.assign(Object.create(McKitsService.prototype), dependencies()) as unknown as {
      requestSheetTranslation(kit: object, desc: object, apiKey: string): Promise<unknown>;
    };
  const translation = () => new McTranslationService(fakeConfig(config));

  const costDetail = () => appendEvent.mock.calls[0][1].detail as Record<string, unknown>;

  describe('ajuste do kit (translateAdjustments)', () => {
    it('Luna: esforço none, teto da família nova, sem temperature e com o prazo próprio', async () => {
      create.mockResolvedValue(chatResponse({ content: 'less childish' }));
      await expect(candidates().translateAdjustments('menos infantil', KIT)).resolves.toBe(
        'less childish',
      );

      const { body, options } = sentTo(create);
      expect(body).toMatchObject({
        model: LUNA,
        reasoning_effort: 'none',
        max_completion_tokens: 1200,
      });
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('max_tokens');
      expect(options).toEqual({ maxRetries: 0, timeout: 30_000 });
    });

    it('volta a gpt-4o-mini: o corpo de hoje (max_tokens 300, sem temperature, sem esforço)', async () => {
      config.OPENAI_FAST_TEXT_MODEL = 'gpt-4o-mini';
      create.mockResolvedValue(chatResponse({ content: 'less childish' }));
      await candidates().translateAdjustments('menos infantil', KIT);

      const { body } = sentTo(create);
      expect(body).toMatchObject({ model: 'gpt-4o-mini', max_tokens: 300 });
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('max_completion_tokens');
    });

    it('variável vazia ou só com espaços vale o padrão, nunca um modelo vazio', async () => {
      create.mockResolvedValue(chatResponse({ content: 'x' }));
      for (const value of ['', '   ']) {
        config.OPENAI_FAST_TEXT_MODEL = value;
        await candidates().translateAdjustments('menos infantil', KIT);
      }
      expect(sentTo(create, 0).body.model).toBe(LUNA);
      expect(sentTo(create, 1).body.model).toBe(LUNA);
    });

    it('o custo gravado vem do modelo efetivo da resposta em Luna (snapshot datado casa pelo prefixo)', async () => {
      create.mockResolvedValue({
        ...chatResponse({
          content: 'less childish',
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        }),
        model: 'gpt-6-luna-2026-10-01',
      });
      await candidates().translateAdjustments('menos infantil', KIT);

      // 1.000 × 0,10/1M + 500 × 0,50/1M
      expect(costDetail()).toMatchObject({ model: 'gpt-6-luna-2026-10-01', requestedModel: LUNA });
      expect(costDetail().costUsd).toBeCloseTo(0.00035, 8);
    });
  });

  describe('ficha do kit (requestSheetTranslation)', () => {
    const DESC = { traits: ['capybara'], accessories: [], doNots: ['x'], style: '3D' };
    const SHEET = { traits: ['capivara'], accessories: [], doNots: ['x'], style: '3D' };

    it('Tradução sem temperatura hoje: Luna com esforço none, sem temperature, teto da família nova e o mesmo json_schema', async () => {
      create.mockResolvedValue(chatResponse({ content: JSON.stringify(SHEET) }));
      await expect(kits().requestSheetTranslation(KIT, DESC, 'sk-test')).resolves.toEqual(SHEET);

      const { body, options } = sentTo(create);
      expect(body).toMatchObject({
        model: LUNA,
        reasoning_effort: 'none',
        max_completion_tokens: 3600,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'kit_sheet_translation', strict: true },
        },
      });
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('max_tokens');
      expect(options).toEqual({ maxRetries: 0, timeout: 30_000 });
    });

    it('volta a gpt-4o-mini: o corpo de hoje (max_tokens 900, sem temperature, sem esforço)', async () => {
      config.OPENAI_FAST_TEXT_MODEL = 'gpt-4o-mini';
      create.mockResolvedValue(chatResponse({ content: JSON.stringify(SHEET) }));
      await kits().requestSheetTranslation(KIT, DESC, 'sk-test');

      const { body } = sentTo(create);
      expect(body).toMatchObject({ model: 'gpt-4o-mini', max_tokens: 900 });
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('max_completion_tokens');
    });

    it('variável vazia vale o padrão e o custo sai do modelo efetivo, nulo fora da tabela', async () => {
      config.OPENAI_FAST_TEXT_MODEL = ' ';
      create.mockResolvedValue({
        ...chatResponse({
          content: JSON.stringify(SHEET),
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
        model: 'gpt-6-luna-2026-10-01',
      });
      await kits().requestSheetTranslation(KIT, DESC, 'sk-test');
      expect(sentTo(create).body.model).toBe(LUNA);
      expect(costDetail().costUsd).toBeCloseTo(0.000035, 9);

      appendEvent.mockClear();
      config.OPENAI_FAST_TEXT_MODEL = 'gpt-5-mini';
      create.mockResolvedValue({
        ...chatResponse({
          content: JSON.stringify(SHEET),
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
        model: 'gpt-5-mini-2026-01-01',
      });
      await kits().requestSheetTranslation(KIT, DESC, 'sk-test');
      expect(costDetail().costUsd).toBeNull();
    });
  });

  describe('derivação PT → EN de cena (McTranslationService)', () => {
    const scene = (extra: Partial<McScriptScene> = {}): McScriptScene =>
      ({
        idx: 0,
        sceneId: 's1',
        actionPrompt: 'O mascote acena',
        initialFrame: 'Mascote na cozinha',
        durationS: 6,
        dialogue: null,
        ...extra,
      }) as McScriptScene;
    const script = (...scenes: McScriptScene[]) => ({ version: 1, scenes }) as unknown as McScript;
    const derive = async (...scenes: McScriptScene[]): Promise<McSceneDerived[]> =>
      (await translation().deriveScript(script(...scenes))).script.scenes.map((s) => s.derived!);
    const reply = {
      initialFrameEn: 'The mascot in the kitchen',
      actionPromptEn: 'The mascot waves',
    };

    it('Derivação nova: Luna com esforço none, temperature 0, teto, prazo e json_schema; provider openai:<modelo>', async () => {
      create.mockResolvedValue(chatResponse({ content: JSON.stringify(reply) }));
      const [derived] = await derive(scene());

      const { body, options } = sentTo(create);
      expect(body).toMatchObject({
        model: LUNA,
        reasoning_effort: 'none',
        temperature: 0,
        max_completion_tokens: 1024,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'scene_translation', strict: true },
        },
      });
      expect(body).not.toHaveProperty('max_tokens');
      expect(options).toEqual({ maxRetries: 0, timeout: 30_000 });
      expect(derived).toMatchObject({
        lang: 'en',
        provider: 'openai:gpt-6-luna',
        initialFrameEn: 'The mascot in the kitchen',
        actionPromptEn: 'The mascot waves',
      });
    });

    it('volta a gpt-4o-mini: o corpo de hoje (temperature 0, sem teto, sem esforço) e provider openai:gpt-4o-mini', async () => {
      config.OPENAI_FAST_TEXT_MODEL = 'gpt-4o-mini';
      create.mockResolvedValue(chatResponse({ content: JSON.stringify(reply) }));
      const [derived] = await derive(scene());

      const { body } = sentTo(create);
      expect(body).toMatchObject({ model: 'gpt-4o-mini', temperature: 0 });
      expect(body).not.toHaveProperty('max_tokens');
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(derived.provider).toBe('openai:gpt-4o-mini');
    });

    it('variável vazia vale o padrão', async () => {
      config.OPENAI_FAST_TEXT_MODEL = '  ';
      create.mockResolvedValue(chatResponse({ content: JSON.stringify(reply) }));
      await derive(scene());
      expect(sentTo(create).body.model).toBe(LUNA);
    });

    it('Cena com derivação feita antes: o sourceHash igual reaproveita a derivação de gpt-4o-mini, sem chamada', async () => {
      create.mockResolvedValue(chatResponse({ content: JSON.stringify(reply) }));
      const [first] = await derive(scene());
      const previous = { ...first, provider: 'openai:gpt-4o-mini' };
      create.mockClear();

      const result = await translation().deriveScript(script(scene({ derived: previous })));
      expect(create).not.toHaveBeenCalled();
      expect(result.translated).toBe(0);
      expect(result.script.scenes[0].derived).toBe(previous);
    });

    it('Prazo estourado na derivação de cena: uma única chamada e a cena recebe o fallback pt explícito', async () => {
      create.mockRejectedValue(new APIConnectionTimeoutError());
      const [derived] = await derive(scene());

      expect(create).toHaveBeenCalledTimes(1);
      expect(derived).toMatchObject({
        lang: 'pt',
        provider: 'openai:fallback_pt',
        initialFrameEn: null,
        actionPromptEn: null,
      });
    });

    it('5xx repete uma vez e grava a derivação; conta sem crédito não repete e cai no fallback pt', async () => {
      const transient = Object.assign(openAiError(503, 'ocupado'), {
        headers: { 'retry-after-ms': '0' },
      });
      create
        .mockRejectedValueOnce(transient)
        .mockResolvedValueOnce(chatResponse({ content: JSON.stringify(reply) }));
      const [derived] = await derive(scene());
      expect(create).toHaveBeenCalledTimes(2);
      expect(derived.lang).toBe('en');

      create.mockReset();
      create.mockRejectedValue(openAiError(429, 'sem saldo', 'insufficient_quota'));
      const [failed] = await derive(scene());
      expect(create).toHaveBeenCalledTimes(1);
      expect(failed.provider).toBe('openai:fallback_pt');
    });

    it('sem chave ou com o provider mock não chama o SDK', async () => {
      delete config.OPENAI_API_KEY;
      const [noKey] = await derive(scene());
      expect(noKey.provider).toBe('openai:fallback_pt');

      config.OPENAI_API_KEY = 'sk-test';
      process.env.MC_TRANSLATION_PROVIDER = 'mock';
      const [mock] = await derive(scene());
      expect(mock.provider).toBe('mock');
      expect(create).not.toHaveBeenCalled();
    });
  });
});
