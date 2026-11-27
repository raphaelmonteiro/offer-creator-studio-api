import { AI_RESPONSE_FORMATS } from './schemas/ai-response.schemas';
import {
  buildTemplateLayers,
  COMPOSITION_ANSWER,
  INTENT_ANSWER,
} from './template-text-services.testutil';
import { chatResponse, sentTo } from './utils/openai-chat.testutil';

const FORMAT = {
  type: 'folheto-20x27',
  printWidthCm: 20,
  printHeightCm: 27,
  headerHeightCm: 6,
  footerHeightCm: 4,
};
const REFERENCE = 'data:image/png;base64,iVBORw0KGgo=';
const WITH_REFERENCE = [{ role: 'user' as const, content: 'Fundo azul', images: [REFERENCE] }];
const NO_REFERENCE = [{ role: 'user' as const, content: 'Fundo azul' }];
const [INTENT, VISION, COMPOSITION] = [0, 1, 2];

type Built = ReturnType<typeof buildTemplateLayers>;

/** Intenção, leitura da referência e composição, nessa ordem. */
function answerAll({ create }: Built) {
  create
    .mockResolvedValueOnce(INTENT_ANSWER)
    .mockResolvedValueOnce(chatResponse({ content: 'Estilo: azul' }))
    .mockResolvedValueOnce(COMPOSITION_ANSWER);
}

describe('TemplateLayersGeneratorService (chat do template em camadas)', () => {
  it('Padrão novo: intenção (none), leitura da referência (low, sem temperature) e composição (low) com teto e prazo do ponto', async () => {
    const built = buildTemplateLayers();
    answerAll(built);

    const result = await built.service.generateTemplateLayers(FORMAT, WITH_REFERENCE);

    expect(result.assistantMessage).toBe('Camadas prontas');
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
        max_completion_tokens: 3000,
        messages: expect.any(Array),
      },
      options: { timeout: 60_000, maxRetries: 0 },
    });
    expect(sentTo(create, COMPOSITION)).toEqual({
      body: {
        model: 'gpt-6-luna',
        reasoning_effort: 'low',
        max_completion_tokens: 8000,
        response_format: AI_RESPONSE_FORMATS.templateLayersComposition,
        messages: expect.any(Array),
      },
      options: { timeout: 90_000, maxRetries: 0 },
    });
  });

  it('Volta ao modelo de hoje: o corpo dos três pontos é o de hoje, campo a campo', async () => {
    const built = buildTemplateLayers({
      OPENAI_TEXT_MODEL: 'gpt-4o',
      OPENAI_FAST_TEXT_MODEL: 'gpt-4o-mini',
    });
    answerAll(built);

    await built.service.generateTemplateLayers(FORMAT, WITH_REFERENCE);

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
      max_tokens: 400,
      messages: expect.any(Array),
    });
    expect(bodyOf(COMPOSITION)).toEqual({
      model: 'gpt-4o',
      max_tokens: 1000,
      temperature: 0.4,
      response_format: AI_RESPONSE_FORMATS.templateLayersComposition,
      messages: expect.any(Array),
    });
  });

  it('Resposta fora do schema continua com nova tentativa, cada uma com o seu prazo', async () => {
    const built = buildTemplateLayers({ OPENAI_STRUCTURED_RESPONSE_RETRY_ATTEMPTS: '1' });
    built.create
      .mockResolvedValueOnce(INTENT_ANSWER)
      .mockResolvedValueOnce(chatResponse({ content: '{"palette": 1}' }))
      .mockResolvedValueOnce(COMPOSITION_ANSWER);

    const result = await built.service.generateTemplateLayers(FORMAT, NO_REFERENCE);

    expect(result.assistantMessage).toBe('Camadas prontas');
    expect(built.create).toHaveBeenCalledTimes(3);
    expect(sentTo(built.create, 1).options).toEqual({ timeout: 90_000, maxRetries: 0 });
    expect(sentTo(built.create, 2).options).toEqual({ timeout: 90_000, maxRetries: 0 });
    const retryMessages = sentTo(built.create, 2).body.messages as Array<{ content: string }>;
    expect(retryMessages[retryMessages.length - 1].content).toContain(
      'Validation error: A IA retornou composição inválida',
    );
  });
});
