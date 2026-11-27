import { Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { ImageIntentCategory } from '../schemas/ai-response.schemas';
import {
  buildImageIntentClassification,
  classifyImageIntent,
  getFallbackImageIntent,
  ImageIntentContext,
  ImageIntentRuntime,
} from './image-intent';
import { chatResponse, openAiError, sentTo } from './openai-chat.testutil';

/**
 * Intenção da imagem do template (change 42, task 1.19): a regra que estava copiada nos dois serviços, agora num
 * módulo só. Cliente simulado, nenhuma chamada paga.
 */
type Flags = [generate: boolean, edit: boolean, layer: boolean, preserve: boolean];

const context = (extra: Partial<ImageIntentContext> = {}): ImageIntentContext => ({
  feature: 'template-image.intent',
  userMessage: 'troque o texto do título',
  hasExistingImage: false,
  hasReferenceImages: false,
  ...extra,
});

const flagsOf = (intent: ReturnType<typeof buildImageIntentClassification>): Flags => [
  intent.shouldGenerateImage,
  intent.shouldEditExistingImage,
  intent.shouldUseLayerFlow,
  intent.shouldPreserveExistingImage,
];

describe('image-intent — regra por categoria (buildImageIntentClassification)', () => {
  const sem = {};
  const comImagem = { hasExistingImage: true };
  const comReferencia = { hasReferenceImages: true };
  const comCamadas = { hasCurrentLayers: true };

  // [gerar, editar a existente, fluxo de camadas, preservar], na ordem de `Flags`
  const table: Array<[ImageIntentCategory, Array<[string, Partial<ImageIntentContext>, Flags]>]> = [
    [
      'text_change',
      [
        ['sem nada', sem, [true, false, false, false]],
        ['com imagem', comImagem, [false, false, false, true]],
        ['com referência', comReferencia, [true, false, false, false]],
        ['com camadas', comCamadas, [false, false, false, true]],
      ],
    ],
    [
      'layout_change',
      [
        ['sem nada', sem, [true, false, false, false]],
        ['com imagem', comImagem, [false, false, false, true]],
        ['com camadas', comCamadas, [false, false, false, true]],
      ],
    ],
    [
      'add_layer_element',
      [
        ['sem nada', sem, [true, false, true, false]],
        ['com imagem', comImagem, [true, true, true, false]],
        ['com referência', comReferencia, [true, true, true, false]],
        ['com camadas', comCamadas, [true, false, true, false]],
      ],
    ],
    [
      'replace_layer_element',
      [
        ['sem nada', sem, [true, false, true, false]],
        ['com imagem', comImagem, [true, true, true, false]],
        ['com referência', comReferencia, [true, true, true, false]],
      ],
    ],
    [
      'targeted_edit',
      [
        ['sem nada', sem, [true, false, false, false]],
        ['com imagem', comImagem, [false, true, false, false]],
        ['com referência', comReferencia, [true, false, false, false]],
        ['com camadas', comCamadas, [true, false, false, false]],
      ],
    ],
    [
      'style_variation',
      [
        ['sem nada', sem, [true, false, false, false]],
        ['com imagem', comImagem, [false, true, false, false]],
        ['com referência', comReferencia, [false, true, false, false]],
        ['com camadas', comCamadas, [true, false, false, false]],
      ],
    ],
    [
      'new_full_image',
      [
        ['sem nada', sem, [true, false, false, false]],
        ['com imagem', comImagem, [true, false, false, false]],
        ['com referência', comReferencia, [true, false, false, false]],
      ],
    ],
  ];

  describe.each(table)('%s', (category, cases) => {
    it.each(cases)('%s', (_name, extra, expected) => {
      const intent = buildImageIntentClassification(category, 0.8, context(extra), 'porque sim');
      expect(flagsOf(intent)).toEqual(expected);
      expect(intent).toMatchObject({ category, confidence: 0.8, reason: 'porque sim' });
    });
  });

  it('categoria fora da lista vale new_full_image, com a confiança e o motivo recebidos', () => {
    const intent = buildImageIntentClassification(
      'outra_coisa' as ImageIntentCategory,
      0.7,
      context({ hasExistingImage: true }),
      'x',
    );
    expect(intent).toMatchObject({ category: 'new_full_image', confidence: 0.7, reason: 'x' });
    expect(flagsOf(intent)).toEqual([true, false, false, false]);
  });
});

describe('image-intent — fallback de regra (getFallbackImageIntent)', () => {
  it('com imagem: edição pontual; só com referência: variação de estilo; sem nada: imagem nova', () => {
    expect(getFallbackImageIntent(context({ hasExistingImage: true })).category).toBe(
      'targeted_edit',
    );
    expect(getFallbackImageIntent(context({ hasReferenceImages: true })).category).toBe(
      'style_variation',
    );
    expect(getFallbackImageIntent(context()).category).toBe('new_full_image');
  });

  it('camadas atuais sem imagem não mudam a categoria; confiança 0 e motivo fallback', () => {
    const intent = getFallbackImageIntent(context({ hasCurrentLayers: true }));
    expect(intent).toMatchObject({ category: 'new_full_image', confidence: 0, reason: 'fallback' });
  });
});

describe('image-intent — classificação pelo modelo (classifyImageIntent)', () => {
  const create = jest.fn();
  let logger: Logger;
  let lines: () => string[];
  const runtime = (
    models: Partial<ImageIntentRuntime['models']> = {},
    openai: OpenAI | null = { chat: { completions: { create } } } as unknown as OpenAI,
  ): ImageIntentRuntime => ({
    openai,
    logger,
    models: { fastTextModel: 'gpt-6-luna', structuredResponseRetryAttempts: 0, ...models },
  });
  const answer = (category: string, confidence: number) =>
    chatResponse({ content: JSON.stringify({ category, confidence, reason: 'r' }) });

  beforeEach(() => {
    create.mockReset();
    logger = new Logger('teste');
    const spies = [
      jest.spyOn(logger, 'log').mockImplementation(() => undefined),
      jest.spyOn(logger, 'warn').mockImplementation(() => undefined),
      jest.spyOn(logger, 'error').mockImplementation(() => undefined),
    ];
    lines = () => spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
  });

  it('sem cliente da OpenAI devolve o fallback e não chama nada', async () => {
    const intent = await classifyImageIntent(
      runtime({}, null),
      context({ hasExistingImage: true }),
    );
    expect(intent).toMatchObject({ category: 'targeted_edit', reason: 'fallback' });
    expect(create).not.toHaveBeenCalled();
  });

  it('em Luna: esforço none, temperature 0, teto da família nova, prazo próprio e o json_schema da intenção', async () => {
    create.mockResolvedValue(answer('text_change', 0.9));
    const intent = await classifyImageIntent(
      runtime(),
      context({ hasExistingImage: true, hasCurrentLayers: true }),
    );

    const { body, options } = sentTo(create);
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      reasoning_effort: 'none',
      temperature: 0,
      max_completion_tokens: 1024,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'image_intent_classification_v1' },
      },
    });
    expect(body).not.toHaveProperty('max_tokens');
    expect(options).toEqual({ maxRetries: 0, timeout: 20_000 });
    const user = (body.messages as Array<{ role: string; content: string }>)[1];
    expect(JSON.parse(user.content)).toEqual({
      message: 'troque o texto do título',
      hasExistingImage: true,
      hasReferenceImages: false,
      hasCurrentLayers: true,
    });
    expect(intent).toMatchObject({
      category: 'text_change',
      confidence: 0.9,
      reason: 'r',
      shouldPreserveExistingImage: true,
    });
    expect(
      lines().some(
        (line) => line.startsWith('Image intent') && line.includes('"status":"classified"'),
      ),
    ).toBe(true);
  });

  it('volta ao modelo de hoje: o corpo de hoje (max_tokens 300, temperature 0, sem esforço), com o modelo da configuração', async () => {
    create.mockResolvedValue(answer('new_full_image', 0.9));
    await classifyImageIntent(runtime({ fastTextModel: 'gpt-4o-mini' }), context());

    const { body } = sentTo(create);
    expect(body).toMatchObject({ model: 'gpt-4o-mini', max_tokens: 300, temperature: 0 });
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('confiança abaixo de 0,55 vale o fallback; exatamente 0,55 vale a classificação', async () => {
    create.mockResolvedValueOnce(answer('text_change', 0.54));
    const low = await classifyImageIntent(runtime(), context({ hasExistingImage: true }));
    expect(low).toMatchObject({ category: 'targeted_edit', reason: 'fallback' });
    expect(lines().some((line) => line.includes('"status":"low-confidence-fallback"'))).toBe(true);

    create.mockResolvedValueOnce(answer('text_change', 0.55));
    const edge = await classifyImageIntent(runtime(), context({ hasExistingImage: true }));
    expect(edge).toMatchObject({ category: 'text_change', confidence: 0.55 });
  });

  it('falha do provedor devolve o fallback e deixa o aviso com o consumidor', async () => {
    create.mockRejectedValue(openAiError(500, 'indisponível'));
    const intent = await classifyImageIntent(
      runtime(),
      context({ feature: 'template-layers.intent', hasReferenceImages: true }),
    );

    expect(intent).toMatchObject({ category: 'style_variation', reason: 'fallback' });
    const warn = lines().find((line) => line.startsWith('Image intent classification failed'));
    expect(warn).toContain('"feature":"template-layers.intent"');
    expect(warn).toContain('indisponível');
  });

  it('resposta fora do schema cai no fallback; com OPENAI_STRUCTURED_RESPONSE_RETRY_ATTEMPTS=1 a segunda chamada pede a correção', async () => {
    create.mockResolvedValue(
      chatResponse({ content: '{"category":"inexistente","confidence":2}' }),
    );
    const failed = await classifyImageIntent(runtime(), context());
    expect(failed.reason).toBe('fallback');
    expect(create).toHaveBeenCalledTimes(1);

    create.mockReset();
    create
      .mockResolvedValueOnce(chatResponse({ content: 'não é json' }))
      .mockResolvedValueOnce(answer('layout_change', 0.8));
    const retried = await classifyImageIntent(
      runtime({ structuredResponseRetryAttempts: 1 }),
      context(),
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(retried.category).toBe('layout_change');
    const correction = (sentTo(create, 1).body.messages as Array<{ content: string }>).at(-1)!;
    expect(correction.content).toContain('previous response was invalid');
  });
});
