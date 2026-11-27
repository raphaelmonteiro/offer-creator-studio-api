import {
  buildChatCompletionParams,
  buildResponsesParams,
  ChatCallSpec,
  isGpt6Family,
  ResponsesCallSpec,
} from './openai-chat-params';
import {
  categorizationCeiling,
  GALLERY_VISION_CEILING,
  NAME_PARSER_CEILING,
  SPELLCHECK_CEILING,
  TRANSLATION_CEILING,
} from './openai-product-ceilings';

function spec(overrides: Partial<ChatCallSpec> = {}): ChatCallSpec {
  return {
    model: 'gpt-6-luna',
    effort: 'low',
    temperature: 0,
    timeoutMs: 30_000,
    legacyMaxTokens: 2048,
    maxCompletionTokens: 8192,
    ...overrides,
  };
}

describe('isGpt6Family', () => {
  it.each(['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6-astra'])('%s é da família nova', (model) => {
    expect(isGpt6Family(model)).toBe(true);
  });

  it.each(['gpt-4o', 'gpt-4o-mini', 'gpt-5-mini', 'o3', 'gpt-x6'])(
    '%s é da família de hoje',
    (model) => {
      expect(isGpt6Family(model)).toBe(false);
    },
  );
});

describe('buildChatCompletionParams, família gpt-6', () => {
  it('esforço low: max_completion_tokens e reasoning_effort, sem temperature nem max_tokens', () => {
    const { body } = buildChatCompletionParams(spec({ effort: 'low', temperature: 0.1 }));
    expect(body).toStrictEqual({
      model: 'gpt-6-luna',
      max_completion_tokens: 8192,
      reasoning_effort: 'low',
    });
  });

  it('esforço none: leva temperature, e continua sem max_tokens', () => {
    const { body } = buildChatCompletionParams(spec({ effort: 'none', temperature: 0 }));
    expect(body).toStrictEqual({
      model: 'gpt-6-luna',
      max_completion_tokens: 8192,
      reasoning_effort: 'none',
      temperature: 0,
    });
  });

  it('esforço medium: reasoning_effort medium, sem temperature nem max_tokens', () => {
    const { body } = buildChatCompletionParams(spec({ effort: 'medium', temperature: 0.1 }));
    expect(body).toStrictEqual({
      model: 'gpt-6-luna',
      max_completion_tokens: 8192,
      reasoning_effort: 'medium',
    });
  });

  it('esforço none com temperature 0.1 leva o valor pedido', () => {
    const { body } = buildChatCompletionParams(spec({ effort: 'none', temperature: 0.1 }));
    expect(body.temperature).toBe(0.1);
  });

  it('o Terra recebe os mesmos parâmetros da família', () => {
    const { body } = buildChatCompletionParams(spec({ model: 'gpt-6.1-terra', effort: 'low' }));
    expect(body.model).toBe('gpt-6.1-terra');
    expect(body.reasoning_effort).toBe('low');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });
});

describe('buildChatCompletionParams, família de hoje', () => {
  it.each(['low', 'none', 'medium'] as const)(
    'esforço %s: só max_tokens e temperature, sem reasoning_effort nem max_completion_tokens',
    (effort) => {
      const { body } = buildChatCompletionParams(
        spec({ model: 'gpt-4o', effort, temperature: 0.1, legacyMaxTokens: 8000 }),
      );
      expect(body).toStrictEqual({ model: 'gpt-4o', max_tokens: 8000, temperature: 0.1 });
    },
  );

  it('modelo fora das duas famílias conhecidas (gpt-5-mini) recebe os parâmetros de hoje', () => {
    const { body } = buildChatCompletionParams(spec({ model: 'gpt-5-mini' }));
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body.max_tokens).toBe(2048);
    expect(body.temperature).toBe(0);
  });
});

describe('buildChatCompletionParams, ponto sem teto ou sem temperatura hoje (change 42)', () => {
  const semTeto = (overrides: Partial<ChatCallSpec> = {}) =>
    spec({ legacyMaxTokens: undefined, ...overrides });
  const semTemperatura = (overrides: Partial<ChatCallSpec> = {}) =>
    spec({ temperature: undefined, ...overrides });

  it('família de hoje sem teto (layout social, diretor, derivação): leva temperature e não leva max_tokens', () => {
    const { body } = buildChatCompletionParams(semTeto({ model: 'gpt-4o', temperature: 0.3 }));
    expect(body).toStrictEqual({ model: 'gpt-4o', temperature: 0.3 });
  });

  it('família de hoje sem temperature (configuração do template): leva max_tokens e não leva temperature', () => {
    const { body } = buildChatCompletionParams(
      semTemperatura({ model: 'gpt-4o', legacyMaxTokens: 4000 }),
    );
    expect(body).toStrictEqual({ model: 'gpt-4o', max_tokens: 4000 });
  });

  it('família de hoje sem teto e sem temperature: só o modelo', () => {
    const { body } = buildChatCompletionParams(
      semTeto({ model: 'gpt-4o', temperature: undefined }),
    );
    expect(body).toStrictEqual({ model: 'gpt-4o' });
  });

  it('família gpt-6 sempre leva max_completion_tokens, mesmo sem o teto de hoje', () => {
    const { body } = buildChatCompletionParams(
      semTeto({ effort: 'low', maxCompletionTokens: 9000 }),
    );
    expect(body).toStrictEqual({
      model: 'gpt-6-luna',
      max_completion_tokens: 9000,
      reasoning_effort: 'low',
    });
  });

  it('família gpt-6 com esforço none e sem temperature (traduções do kit): não leva temperature', () => {
    const { body } = buildChatCompletionParams(semTemperatura({ effort: 'none' }));
    expect(body).toStrictEqual({
      model: 'gpt-6-luna',
      max_completion_tokens: 8192,
      reasoning_effort: 'none',
    });
    expect(body).not.toHaveProperty('temperature');
  });

  it('família gpt-6 com esforço none e temperature 0 (derivação de cena): leva temperature 0', () => {
    const { body } = buildChatCompletionParams(spec({ effort: 'none', temperature: 0 }));
    expect(body.temperature).toBe(0);
  });

  it('família gpt-6 com esforço low e temperature do ponto: não leva temperature', () => {
    const { body } = buildChatCompletionParams(spec({ effort: 'low', temperature: 0.4 }));
    expect(body).not.toHaveProperty('temperature');
  });

  it('o prazo e a ausência de repetição valem sem teto e sem temperatura', () => {
    const { options } = buildChatCompletionParams(
      spec({
        model: 'gpt-4o',
        legacyMaxTokens: undefined,
        temperature: undefined,
        timeoutMs: 45_000,
      }),
    );
    expect(options).toStrictEqual({ maxRetries: 0, timeout: 45_000 });
  });
});

describe('buildChatCompletionParams, opções de requisição', () => {
  it.each(['gpt-6-luna', 'gpt-4o-mini'])('%s: prazo da feature e sem repetição do SDK', (model) => {
    const { options } = buildChatCompletionParams(spec({ model, timeoutMs: 10_000 }));
    expect(options).toStrictEqual({ maxRetries: 0, timeout: 10_000 });
  });
});

describe('corpo de hoje, campo a campo, para as cinco features', () => {
  const cases: Array<[string, ChatCallSpec, Record<string, unknown>]> = [
    [
      'ortografia',
      spec({ model: 'gpt-4o', effort: 'low', temperature: 0, ...SPELLCHECK_CEILING }),
      { model: 'gpt-4o', max_tokens: 2048, temperature: 0 },
    ],
    [
      'categorização (40 itens)',
      spec({ model: 'gpt-4o-mini', effort: 'none', temperature: 0, ...categorizationCeiling(40) }),
      { model: 'gpt-4o-mini', max_tokens: 3900, temperature: 0 },
    ],
    [
      'leitura do nome',
      spec({ model: 'gpt-4o-mini', effort: 'low', temperature: 0.1, ...NAME_PARSER_CEILING }),
      { model: 'gpt-4o-mini', max_tokens: 8000, temperature: 0.1 },
    ],
    [
      'leitura da foto',
      spec({ model: 'gpt-4o-mini', effort: 'low', temperature: 0.1, ...GALLERY_VISION_CEILING }),
      { model: 'gpt-4o-mini', max_tokens: 900, temperature: 0.1 },
    ],
    [
      'tradução',
      spec({ model: 'gpt-4o-mini', effort: 'none', temperature: 0, ...TRANSLATION_CEILING }),
      { model: 'gpt-4o-mini', max_tokens: 32, temperature: 0 },
    ],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    expect(buildChatCompletionParams(input).body).toStrictEqual(expected);
  });
});

describe('tetos de saída da família gpt-6 (D-7)', () => {
  it('todos maiores que os de hoje', () => {
    for (const ceiling of [
      SPELLCHECK_CEILING,
      NAME_PARSER_CEILING,
      GALLERY_VISION_CEILING,
      TRANSLATION_CEILING,
      categorizationCeiling(40),
    ]) {
      expect(ceiling.maxCompletionTokens).toBeGreaterThan(ceiling.legacyMaxTokens);
    }
  });

  it('categorização: lote de 40 passa de 3.900; qualquer tamanho de lote fica acima do de hoje', () => {
    expect(categorizationCeiling(40).legacyMaxTokens).toBe(3900);
    expect(categorizationCeiling(40).maxCompletionTokens).toBeGreaterThan(3900);
    for (const items of [1, 2, 10, 40, 41, 100, 500]) {
      const { legacyMaxTokens, maxCompletionTokens } = categorizationCeiling(items);
      expect(maxCompletionTokens).toBeGreaterThan(legacyMaxTokens);
    }
  });

  it('categorização: o teto de hoje continua min(4096, 300 + 90n)', () => {
    expect(categorizationCeiling(1).legacyMaxTokens).toBe(390);
    expect(categorizationCeiling(500).legacyMaxTokens).toBe(4096);
  });
});

describe('buildResponsesParams, a forma de /responses', () => {
  const responses = (overrides: Partial<ResponsesCallSpec> = {}): ResponsesCallSpec => ({
    model: 'gpt-6-luna',
    effort: 'low',
    temperature: 0.2,
    timeoutMs: 25_000,
    maxOutputTokens: 4000,
    ...overrides,
  });

  it('sugestão de estrutura no padrão: max_output_tokens e reasoning low, sem temperature, max_tokens nem max_completion_tokens', () => {
    const { body, options } = buildResponsesParams(responses());
    expect(body).toStrictEqual({
      model: 'gpt-6-luna',
      max_output_tokens: 4000,
      reasoning: { effort: 'low' },
    });
    expect(options).toStrictEqual({ maxRetries: 0, timeout: 25_000 });
  });

  it('família gpt-6 com esforço none: reasoning none e temperature 0.2', () => {
    const { body } = buildResponsesParams(responses({ effort: 'none' }));
    expect(body).toStrictEqual({
      model: 'gpt-6-luna',
      max_output_tokens: 4000,
      reasoning: { effort: 'none' },
      temperature: 0.2,
    });
  });

  it('família gpt-6 com esforço medium: reasoning medium e nenhuma temperature', () => {
    const { body } = buildResponsesParams(responses({ effort: 'medium' }));
    expect(body.reasoning).toStrictEqual({ effort: 'medium' });
    expect(body).not.toHaveProperty('temperature');
  });

  it('esforço low com temperatura informada pelo chamador: a temperature não vai no corpo', () => {
    const { body } = buildResponsesParams(responses({ effort: 'low', temperature: 0.7 }));
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it.each(['low', 'none', 'medium'] as const)(
    'modelo fora da família gpt-6 (gpt-4o-mini), esforço %s: max_output_tokens e temperature, sem reasoning',
    (effort) => {
      const { body } = buildResponsesParams(responses({ model: 'gpt-4o-mini', effort }));
      expect(body).toStrictEqual({
        model: 'gpt-4o-mini',
        max_output_tokens: 4000,
        temperature: 0.2,
      });
    },
  );

  it('o Terra recebe a mesma forma da família, e o prazo da feature vale em qualquer modelo', () => {
    const terra = buildResponsesParams(responses({ model: 'gpt-6.1-terra', timeoutMs: 10_000 }));
    expect(terra.body.reasoning).toStrictEqual({ effort: 'low' });
    expect(terra.options).toStrictEqual({ maxRetries: 0, timeout: 10_000 });
    const legacy = buildResponsesParams(responses({ model: 'gpt-4o', timeoutMs: 7_000 }));
    expect(legacy.options).toStrictEqual({ maxRetries: 0, timeout: 7_000 });
  });
});
