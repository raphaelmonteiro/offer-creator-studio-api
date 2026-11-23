import { APIConnectionTimeoutError } from 'openai';
import { callProductChat } from './ai-product-chat.util';
import { MESSAGES, setup, SPEC } from './ai-product-chat.testutil';
import { AiUsageCollector } from './ai-usage';
import { chatResponse, openAiError } from './openai-chat.testutil';

describe('callProductChat, chamada abortada no meio e o custo do job (D-orq-1)', () => {
  const ANSWER = chatResponse({
    content: '{}',
    usage: { prompt_tokens: 1000, completion_tokens: 200 },
  });

  /** O coletor com uma chamada já concluída (US$ 0,0002) e a chamada seguinte, que o teste conduz. */
  async function afterOnePaidCall() {
    const { create, openai, logger } = setup();
    const usage = new AiUsageCollector();
    create.mockResolvedValueOnce(ANSWER);
    await callProductChat({ openai, logger, feature: 'f', spec: SPEC, messages: MESSAGES, usage });
    return { create, openai, logger, usage };
  }

  it('sinal abortado com a chamada em andamento: o custo do uso fica nulo, nunca a soma das concluídas', async () => {
    const { create, openai, logger, usage } = await afterOnePaidCall();
    const controller = new AbortController();
    create.mockImplementationOnce(
      (_body: unknown, options: { signal: AbortSignal }) =>
        new Promise((_, reject) =>
          options.signal.addEventListener('abort', () => reject(new Error('Request was aborted.'))),
        ),
    );
    const running = callProductChat({
      openai,
      logger,
      feature: 'f',
      spec: SPEC,
      messages: MESSAGES,
      usage,
      signal: controller.signal,
    });
    expect(usage.snapshot().costUsd).toBeNull();

    controller.abort();
    await expect(running).rejects.toThrow('Request was aborted.');

    expect(usage.snapshot()).toMatchObject({ calls: 2, costUsd: null });
  });

  it('prazo da própria chamada (timeout do SDK): o custo do uso fica nulo', async () => {
    const { create, openai, logger, usage } = await afterOnePaidCall();
    create.mockRejectedValueOnce(new APIConnectionTimeoutError());

    await expect(
      callProductChat({ openai, logger, feature: 'f', spec: SPEC, messages: MESSAGES, usage }),
    ).rejects.toBeInstanceOf(APIConnectionTimeoutError);

    expect(usage.snapshot()).toMatchObject({ calls: 2, costUsd: null });
  });

  it('503 do provedor, sem abortar: a chamada não entra e o custo da concluída segue conhecido', async () => {
    const { create, openai, logger, usage } = await afterOnePaidCall();
    create.mockRejectedValueOnce(openAiError(503));

    await expect(
      callProductChat({ openai, logger, feature: 'f', spec: SPEC, messages: MESSAGES, usage }),
    ).rejects.toBeDefined();

    expect(usage.snapshot()).toMatchObject({ calls: 1, costUsd: 0.0002 });
  });
});
