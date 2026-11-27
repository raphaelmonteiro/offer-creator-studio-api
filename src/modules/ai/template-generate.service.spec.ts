import { AI_RESPONSE_FORMATS } from './schemas/ai-response.schemas';
import {
  buildTemplateGenerate,
  buildTemplateGenerateWithImages,
  CONFIGURATION_ANSWER,
  FORMAT,
  PLACEHOLDER_ANSWER,
  USER_MESSAGES,
} from './template-text-services.testutil';
import { logged } from './utils/ai-product-chat.testutil';
import { chatResponse, openAiError, sentTo } from './utils/openai-chat.testutil';

describe('TemplateGenerateService (chat da configuração do template)', () => {
  it('Configuração do template em Luna: esforço low, teto da família nova e saída estrita, sem temperature nem max_tokens', async () => {
    const { service, create } = buildTemplateGenerate();
    create.mockResolvedValueOnce(CONFIGURATION_ANSWER);

    const result = await service.generateTemplate(FORMAT, USER_MESSAGES);

    expect(result.assistantMessage).toBe('Pronto');
    expect(result.imagesGenerated).toBe(false);
    const { body, options } = sentTo(create);
    expect(body).toEqual({
      model: 'gpt-6-luna',
      reasoning_effort: 'low',
      max_completion_tokens: 16_000,
      response_format: AI_RESPONSE_FORMATS.templateConfiguration,
      messages: expect.any(Array),
    });
    expect(options).toEqual({ timeout: 120_000, maxRetries: 0 });
  });

  it('Configuração do template de volta ao modelo de hoje: max_tokens 4000, sem temperature', async () => {
    const { service, create } = buildTemplateGenerate({ OPENAI_TEXT_MODEL: 'gpt-4o' });
    create.mockResolvedValueOnce(CONFIGURATION_ANSWER);

    await service.generateTemplate(FORMAT, USER_MESSAGES);

    const { body, options } = sentTo(create);
    expect(body).toEqual({
      model: 'gpt-4o',
      max_tokens: 4000,
      response_format: AI_RESPONSE_FORMATS.templateConfiguration,
      messages: expect.any(Array),
    });
    expect(options).toEqual({ timeout: 120_000, maxRetries: 0 });
  });

  it('Placeholder do Gerar template no 2.6: uma chamada de imagem com o modelo novo, 1024x1024, jpeg e fundo opaco', async () => {
    const { service, create, images } = buildTemplateGenerateWithImages();
    create.mockResolvedValueOnce(PLACEHOLDER_ANSWER);

    const result = await service.generateTemplate(FORMAT, USER_MESSAGES);

    expect(result.imagesGenerated).toBe(true);
    expect(images.generateImage).toHaveBeenCalledTimes(1);
    expect(images.generateImage.mock.calls[0][0]).toEqual({
      feature: 'template-generate.placeholder-image',
      prompt: 'maçã vermelha',
      size: '1024x1024',
      assetKind: 'template',
      mode: 'final',
      model: 'gpt-image-2.6-sunburst',
      outputFormat: 'jpeg',
      outputCompression: 85,
      background: 'opaque',
    });
  });

  it('Limite de taxa no Gerar template: uma única chamada ao provedor e o erro sobe', async () => {
    const { service, create } = buildTemplateGenerate();
    create.mockRejectedValue(openAiError(429, 'rate limit', 'rate_limit_exceeded'));

    await expect(service.generateTemplate(FORMAT, USER_MESSAGES)).rejects.toThrow('rate limit');

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('Resposta fora do schema continua com nova tentativa, cada uma com o seu prazo', async () => {
    const { service, create, logs } = buildTemplateGenerate({
      OPENAI_STRUCTURED_RESPONSE_RETRY_ATTEMPTS: '1',
    });
    create
      .mockResolvedValueOnce(chatResponse({ content: '{"assistantMessage": 1}' }))
      .mockResolvedValueOnce(CONFIGURATION_ANSWER);

    await service.generateTemplate(FORMAT, USER_MESSAGES);

    expect(create).toHaveBeenCalledTimes(2);
    expect(sentTo(create, 1).options).toEqual({ timeout: 120_000, maxRetries: 0 });
    const messages = sentTo(create, 1).body.messages as Array<{ role: string; content: string }>;
    expect(messages[messages.length - 1].content).toContain('The previous response was invalid');
    expect(logged(logs.warn, 'Structured response retry ')).toMatchObject({
      feature: 'template-generate.configuration',
      attempt: 1,
      model: 'gpt-6-luna',
    });
  });

  it('Resposta vazia sem nova tentativa: o erro cita a IA, não um modelo', async () => {
    const { service, create } = buildTemplateGenerate({
      OPENAI_STRUCTURED_RESPONSE_RETRY_ATTEMPTS: '0',
    });
    create.mockResolvedValueOnce(chatResponse({ content: null }));

    await expect(service.generateTemplate(FORMAT, USER_MESSAGES)).rejects.toThrow(
      'Resposta vazia da IA',
    );
  });

  it('Configuração do template em Luna: o log traz o consumidor, o modelo e o custo de US$ 0,0021', async () => {
    const { service, create, logs } = buildTemplateGenerate();
    create.mockResolvedValueOnce({
      ...CONFIGURATION_ANSWER,
      usage: { prompt_tokens: 6000, completion_tokens: 3000 },
    });

    await service.generateTemplate(FORMAT, USER_MESSAGES);

    expect(logged(logs.log, 'AI operation finished ')).toMatchObject({
      feature: 'template-generate.configuration',
      model: 'gpt-6-luna',
      estimatedCostUsd: 0.0021,
    });
  });

  it('Resposta cortada pelo teto deixa o aviso com o motivo truncated', async () => {
    const { service, create, logs } = buildTemplateGenerate({
      OPENAI_STRUCTURED_RESPONSE_RETRY_ATTEMPTS: '0',
    });
    create.mockResolvedValueOnce(
      chatResponse({ content: '{"assistantMessage":"x', finishReason: 'length' }),
    );

    await expect(service.generateTemplate(FORMAT, USER_MESSAGES)).rejects.toThrow();

    expect(logged(logs.warn, 'AI response invalid ')).toMatchObject({
      feature: 'template-generate.configuration',
      model: 'gpt-6-luna',
      reason: 'truncated',
    });
  });
});
