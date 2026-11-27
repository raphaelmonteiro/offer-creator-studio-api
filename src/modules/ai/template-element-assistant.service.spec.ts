import { AI_RESPONSE_FORMATS } from './schemas/ai-response.schemas';
import {
  ACTIONS_ANSWER,
  buildTemplateElement,
  FORMAT,
  USER_MESSAGES,
} from './template-text-services.testutil';
import { chatResponse, openAiError, sentTo } from './utils/openai-chat.testutil';

const run = (service: ReturnType<typeof buildTemplateElement>['service']) =>
  service.generateTemplateElement(FORMAT, 'header', USER_MESSAGES);

describe('TemplateElementAssistantService (chat das ações do elemento)', () => {
  it('Ações do elemento em Luna: esforço low, teto da família nova e saída estrita', async () => {
    const { service, create } = buildTemplateElement();
    create.mockResolvedValueOnce(ACTIONS_ANSWER);

    const result = await run(service);

    expect(result).toEqual({ assistantMessage: 'Feito', actions: [] });
    const { body, options } = sentTo(create);
    expect(body).toEqual({
      model: 'gpt-6-luna',
      reasoning_effort: 'low',
      max_completion_tokens: 8000,
      response_format: AI_RESPONSE_FORMATS.templateElementActions,
      messages: expect.any(Array),
    });
    expect(options).toEqual({ timeout: 90_000, maxRetries: 0 });
  });

  it('Ações do elemento de volta ao modelo de hoje: max_tokens 2000, sem temperature', async () => {
    const { service, create } = buildTemplateElement({ OPENAI_TEXT_MODEL: 'gpt-4o' });
    create.mockResolvedValueOnce(ACTIONS_ANSWER);

    await run(service);

    expect(sentTo(create).body).toEqual({
      model: 'gpt-4o',
      max_tokens: 2000,
      response_format: AI_RESPONSE_FORMATS.templateElementActions,
      messages: expect.any(Array),
    });
  });

  it('Limite de taxa: uma única chamada ao provedor', async () => {
    const { service, create } = buildTemplateElement();
    create.mockRejectedValue(openAiError(429, 'rate limit', 'rate_limit_exceeded'));

    await expect(run(service)).rejects.toThrow('rate limit');

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('Resposta fora do schema tem nova tentativa com o pedido de correção', async () => {
    const { service, create } = buildTemplateElement({
      OPENAI_STRUCTURED_RESPONSE_RETRY_ATTEMPTS: '1',
    });
    create
      .mockResolvedValueOnce(chatResponse({ content: '{"actions": "x"}' }))
      .mockResolvedValueOnce(ACTIONS_ANSWER);

    await run(service);

    expect(create).toHaveBeenCalledTimes(2);
    const messages = sentTo(create, 1).body.messages as Array<{ content: string }>;
    expect(messages[messages.length - 1].content).toContain(
      'Validation error: Estrutura inválida retornada pela IA',
    );
  });

  it('Pedido repetido: cada pedido faz a sua chamada e as duas respostas têm a forma de hoje', async () => {
    const { service, create } = buildTemplateElement();
    create.mockResolvedValue(ACTIONS_ANSWER);

    const first = await run(service);
    const second = await run(service);

    expect(create).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first);
  });
});
