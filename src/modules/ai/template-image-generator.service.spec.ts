import { AI_RESPONSE_FORMATS } from './schemas/ai-response.schemas';
import { buildTemplateImage, INTENT_ANSWER } from './template-text-services.testutil';
import { logged } from './utils/ai-product-chat.testutil';
import { chatResponse, openAiError, sentTo } from './utils/openai-chat.testutil';

const FORMAT = { type: 'folheto-20x27', printWidthCm: 20, printHeightCm: 27 };
const REFERENCE = 'data:image/png;base64,iVBORw0KGgo=';
const MESSAGES = [{ role: 'user' as const, content: 'Fundo azul', images: [REFERENCE] }];

type Built = ReturnType<typeof buildTemplateImage>;

/** Respostas na ordem das quatro chamadas de texto: intenção, leitura da referência, prompt e resposta. */
function answerAll({ create }: Built) {
  create
    .mockResolvedValueOnce(INTENT_ANSWER)
    .mockResolvedValueOnce(chatResponse({ content: 'Estilo: azul liso' }))
    .mockResolvedValueOnce(chatResponse({ content: 'A blue background' }))
    .mockResolvedValueOnce(chatResponse({ content: 'Template gerado!' }));
}

const run = (built: Built) => built.service.generateTemplateImage(FORMAT, MESSAGES);
const [INTENT, VISION, PROMPT, REPLY] = [0, 1, 2, 3];

describe('TemplateImageGeneratorService (chat do template por imagem)', () => {
  it('Padrão novo: cada um dos quatro pontos leva o esforço, o teto e o prazo do seu ponto', async () => {
    const built = buildTemplateImage();
    answerAll(built);

    const result = await run(built);

    expect(result.assistantMessage).toBe('Template gerado!');
    const { create } = built;
    expect(sentTo(create, INTENT)).toEqual({
      body: {
        model: 'gpt-6-luna',
        reasoning_effort: 'none',
        temperature: 0,
        max_completion_tokens: 1024,
        response_format: AI_RESPONSE_FORMATS.imageIntentClassification,
        messages: expect.any(Array),
      },
      options: { timeout: 20_000, maxRetries: 0 },
    });
    expect(sentTo(create, VISION)).toEqual({
      body: {
        model: 'gpt-6-luna',
        reasoning_effort: 'low',
        max_completion_tokens: 4096,
        messages: expect.any(Array),
      },
      options: { timeout: 60_000, maxRetries: 0 },
    });
    expect(sentTo(create, PROMPT)).toEqual({
      body: {
        model: 'gpt-6-luna',
        reasoning_effort: 'none',
        temperature: 0.2,
        max_completion_tokens: 2000,
        messages: expect.any(Array),
      },
      options: { timeout: 30_000, maxRetries: 0 },
    });
    expect(sentTo(create, REPLY)).toEqual({
      body: {
        model: 'gpt-6-luna',
        reasoning_effort: 'none',
        temperature: 0.7,
        max_completion_tokens: 600,
        messages: expect.any(Array),
      },
      options: { timeout: 20_000, maxRetries: 0 },
    });
  });

  it('Volta ao modelo de hoje: o corpo dos quatro pontos é o de hoje, campo a campo', async () => {
    const built = buildTemplateImage({
      OPENAI_TEXT_MODEL: 'gpt-4o',
      OPENAI_FAST_TEXT_MODEL: 'gpt-4o-mini',
    });
    answerAll(built);

    await run(built);

    const bodyOf = (index: number) => sentTo(built.create, index).body;
    expect(bodyOf(INTENT)).toEqual({
      model: 'gpt-4o-mini',
      max_tokens: 300,
      temperature: 0,
      response_format: AI_RESPONSE_FORMATS.imageIntentClassification,
      messages: expect.any(Array),
    });
    expect(bodyOf(VISION)).toEqual({
      model: 'gpt-4o',
      max_tokens: 700,
      temperature: 0.1,
      messages: expect.any(Array),
    });
    expect(bodyOf(PROMPT)).toEqual({
      model: 'gpt-4o',
      max_tokens: 500,
      temperature: 0.2,
      messages: expect.any(Array),
    });
    expect(bodyOf(REPLY)).toEqual({
      model: 'gpt-4o',
      max_tokens: 150,
      temperature: 0.7,
      messages: expect.any(Array),
    });
  });

  it('Intenção cai no fallback de hoje quando o provedor falha, e o fluxo segue com uma só chamada de intenção', async () => {
    const built = buildTemplateImage();
    built.create
      .mockRejectedValueOnce(openAiError(503, 'indisponível'))
      .mockResolvedValueOnce(chatResponse({ content: 'Estilo: azul liso' }))
      .mockResolvedValueOnce(chatResponse({ content: 'A blue background' }))
      .mockResolvedValueOnce(chatResponse({ content: 'Template gerado!' }));

    const result = await run(built);

    expect(result.imageUrl).toBe('/uploads/templates/x.png');
    expect(built.create).toHaveBeenCalledTimes(4);
    expect(built.images.editImage).toHaveBeenCalledTimes(1);
    expect(logged(built.logs.warn, 'Image intent classification failed ')).toMatchObject({
      feature: 'template-image.intent',
      error: 'indisponível',
    });
  });

  it('Resposta vazia do prompt: o fluxo para antes de gerar a imagem, como hoje', async () => {
    const built = buildTemplateImage();
    built.create
      .mockResolvedValueOnce(INTENT_ANSWER)
      .mockResolvedValueOnce(chatResponse({ content: 'Estilo' }))
      .mockResolvedValueOnce(chatResponse({ content: '   ' }));

    await expect(run(built)).rejects.toThrow('Falha ao traduzir prompt');

    expect(built.images.editImage).not.toHaveBeenCalled();
    expect(logged(built.logs.warn, 'AI response invalid ')).toMatchObject({
      feature: 'template-image.prompt',
      reason: 'empty',
    });
  });
});
