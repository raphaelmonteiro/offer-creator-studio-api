import { buildChatCompletionParams, ChatCallSpec, isGpt6Family } from './openai-chat-params';
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
