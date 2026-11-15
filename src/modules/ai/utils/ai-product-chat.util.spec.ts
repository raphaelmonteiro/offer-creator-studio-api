import { Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { ChatCallSpec } from '../config/openai-chat-params';
import { callProductChat } from './ai-product-chat.util';
import { chatResponse, openAiError } from './openai-chat.testutil';

const SPEC: ChatCallSpec = {
  model: 'gpt-6-luna',
  effort: 'low',
  temperature: 0,
  timeoutMs: 30_000,
  legacyMaxTokens: 2048,
  maxCompletionTokens: 8192,
};

function setup() {
  const create = jest.fn();
  const openai = { chat: { completions: { create } } } as unknown as OpenAI;
  const logger = new Logger('teste');
  const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  return { create, openai, logger, log, warn, error };
}

/** Objeto JSON da linha de log que começa com `prefix`. */
function logged(spy: jest.SpyInstance, prefix: string): Record<string, unknown> {
  const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith(prefix));
  if (!line) throw new Error(`linha "${prefix}" não encontrada`);
  return JSON.parse(line.slice(prefix.length));
}

const MESSAGES = [{ role: 'user' as const, content: 'oi' }];

describe('callProductChat, uso e custo no log (U0.7)', () => {
  const COST_ENV = ['OPENAI_COST_TEXT_INPUT_1M_USD', 'OPENAI_COST_TEXT_OUTPUT_1M_USD'];
  afterEach(() => COST_ENV.forEach((key) => delete process.env[key]));

  it('Luna com 1.000 de entrada e 200 de saída: feature, modelo, tokens e custo de US$ 0,0002', async () => {
    const { create, openai, logger, log } = setup();
    create.mockResolvedValue(
      chatResponse({ content: '{}', usage: { prompt_tokens: 1000, completion_tokens: 200 } }),
    );

    await callProductChat({
      openai,
      logger,
      feature: 'spell-check.batch',
      spec: SPEC,
      messages: MESSAGES,
    });

    expect(logged(log, 'AI operation finished ')).toMatchObject({
      feature: 'spell-check.batch',
      model: 'gpt-6-luna',
      inputTokens: 1000,
      outputTokens: 200,
      estimatedCostUsd: 0.0002,
      costEstimated: true,
    });
  });

  it('Terra: o custo sai da tabela (2.000 de entrada e 300 de saída = US$ 0,0035)', async () => {
    const { create, openai, logger, log } = setup();
    create.mockResolvedValue(
      chatResponse({ content: '{}', usage: { prompt_tokens: 2000, completion_tokens: 300 } }),
    );

    await callProductChat({
      openai,
      logger,
      feature: 'image-metadata.extract',
      spec: { ...SPEC, model: 'gpt-6.1-terra' },
      messages: MESSAGES,
    });

    expect(logged(log, 'AI operation finished ').estimatedCostUsd).toBe(0.0035);
  });

  it('gpt-4o, sem preço na tabela: a chamada acontece, os tokens saem e o custo é nulo, nunca zero', async () => {
    const { create, openai, logger, log } = setup();
    create.mockResolvedValue(
      chatResponse({ content: '{}', usage: { prompt_tokens: 1000, completion_tokens: 200 } }),
    );

    await callProductChat({
      openai,
      logger,
      feature: 'spell-check.batch',
      spec: { ...SPEC, model: 'gpt-4o' },
      messages: MESSAGES,
    });

    const line = logged(log, 'AI operation finished ');
    expect(create).toHaveBeenCalledTimes(1);
    expect(line).toMatchObject({ model: 'gpt-4o', inputTokens: 1000, outputTokens: 200 });
    expect(line.estimatedCostUsd).toBeNull();
    expect(line.costEstimated).toBe(false);
  });

  it('com OPENAI_COST_TEXT_* definido, o modelo sem preço continua com custo nulo', async () => {
    process.env.OPENAI_COST_TEXT_INPUT_1M_USD = '2.5';
    process.env.OPENAI_COST_TEXT_OUTPUT_1M_USD = '10';
    const { create, openai, logger, log } = setup();
    create.mockResolvedValue(
      chatResponse({ content: '{}', usage: { prompt_tokens: 1000, completion_tokens: 200 } }),
    );

    await callProductChat({
      openai,
      logger,
      feature: 'spell-check.batch',
      spec: { ...SPEC, model: 'gpt-4o' },
      messages: MESSAGES,
    });

    expect(logged(log, 'AI operation finished ').estimatedCostUsd).toBeNull();
  });

  it('com OPENAI_COST_TEXT_* definido, o Luna ainda custa pela tabela, não pela variável', async () => {
    process.env.OPENAI_COST_TEXT_INPUT_1M_USD = '2.5';
    process.env.OPENAI_COST_TEXT_OUTPUT_1M_USD = '10';
    const { create, openai, logger, log } = setup();
    create.mockResolvedValue(
      chatResponse({ content: '{}', usage: { prompt_tokens: 1000, completion_tokens: 200 } }),
    );

    await callProductChat({
      openai,
      logger,
      feature: 'spell-check.batch',
      spec: SPEC,
      messages: MESSAGES,
    });

    expect(logged(log, 'AI operation finished ').estimatedCostUsd).toBe(0.0002);
  });

  it('resposta sem usage: custo nulo, sem tokens', async () => {
    const { create, openai, logger, log } = setup();
    create.mockResolvedValue(chatResponse({ content: '{}' }));

    await callProductChat({
      openai,
      logger,
      feature: 'spell-check.batch',
      spec: SPEC,
      messages: MESSAGES,
    });

    const line = logged(log, 'AI operation finished ');
    expect(line.estimatedCostUsd).toBeNull();
    expect(line.inputTokens).toBeUndefined();
  });

  it('falha antes do usage: só a linha de falha, sem custo nem tokens', async () => {
    const { create, openai, logger, log, error } = setup();
    create.mockRejectedValue(openAiError(500, 'falha'));

    await expect(
      callProductChat({
        openai,
        logger,
        feature: 'spell-check.batch',
        spec: SPEC,
        messages: MESSAGES,
      }),
    ).rejects.toThrow('falha');

    const failed = logged(error, 'AI operation failed ');
    expect(failed).toMatchObject({
      feature: 'spell-check.batch',
      model: 'gpt-6-luna',
      status: 'error',
    });
    expect(failed).not.toHaveProperty('estimatedCostUsd');
    expect(failed).not.toHaveProperty('inputTokens');
    expect(
      log.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith('AI operation finished')),
    ).toBe(false);
  });

  it('o identificador de leitura vai nas linhas de início, fim, falha e aviso', async () => {
    const { create, openai, logger, log, warn, error } = setup();
    create
      .mockResolvedValueOnce(
        chatResponse({ content: '{}', usage: { prompt_tokens: 5, completion_tokens: 5 } }),
      )
      .mockResolvedValueOnce(chatResponse({ content: '', finishReason: 'length' }))
      .mockRejectedValueOnce(openAiError(500, 'falha'));
    const base = {
      openai,
      logger,
      feature: 'image-metadata.extract',
      spec: SPEC,
      messages: MESSAGES,
      correlationId: 'leitura-1',
    };

    await callProductChat({ ...base, mode: 'low' });
    await callProductChat({ ...base, mode: 'high' });
    await callProductChat({ ...base, mode: 'high' }).catch(() => undefined);

    expect(logged(log, 'AI operation started ').correlationId).toBe('leitura-1');
    expect(logged(log, 'AI operation finished ').correlationId).toBe('leitura-1');
    expect(logged(warn, 'AI response invalid ').correlationId).toBe('leitura-1');
    expect(logged(error, 'AI operation failed ').correlationId).toBe('leitura-1');
  });

  it('sem identificador, as linhas não trazem o campo', async () => {
    const { create, openai, logger, log } = setup();
    create.mockResolvedValue(chatResponse({ content: '{}' }));
    await callProductChat({
      openai,
      logger,
      feature: 'spell-check.batch',
      spec: SPEC,
      messages: MESSAGES,
    });
    expect(logged(log, 'AI operation finished ')).not.toHaveProperty('correlationId');
  });
});

describe('callProductChat, resposta vazia ou cortada (D-16)', () => {
  it.each([
    ['vazia', chatResponse({ content: '' }), 'empty'],
    ['só com espaços', chatResponse({ content: '  \n' }), 'empty'],
    ['sem conteúdo', chatResponse({ content: null }), 'empty'],
    ['cortada pelo teto', chatResponse({ content: '{"a":', finishReason: 'length' }), 'truncated'],
  ])('%s: aviso com a feature, o modelo e o motivo', async (_name, response, reason) => {
    const { create, openai, logger, warn } = setup();
    create.mockResolvedValue(response);

    await callProductChat({
      openai,
      logger,
      feature: 'product-name-parser.batch',
      spec: SPEC,
      messages: MESSAGES,
    });

    expect(logged(warn, 'AI response invalid ')).toEqual({
      feature: 'product-name-parser.batch',
      model: 'gpt-6-luna',
      reason,
    });
  });

  it('resposta válida e completa não gera aviso', async () => {
    const { create, openai, logger, warn } = setup();
    create.mockResolvedValue(chatResponse({ content: '{"ok":true}' }));
    await callProductChat({
      openai,
      logger,
      feature: 'product-name-parser.batch',
      spec: SPEC,
      messages: MESSAGES,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('entrega os parâmetros pela família e o formato de saída ao cliente', async () => {
    const { create, openai, logger } = setup();
    create.mockResolvedValue(chatResponse({ content: '{}' }));
    await callProductChat({
      openai,
      logger,
      feature: 'x',
      spec: SPEC,
      messages: MESSAGES,
      responseFormat: { type: 'json_object' },
    });
    expect(create).toHaveBeenCalledWith(
      {
        model: 'gpt-6-luna',
        max_completion_tokens: 8192,
        reasoning_effort: 'low',
        messages: MESSAGES,
        response_format: { type: 'json_object' },
      },
      { maxRetries: 0, timeout: 30_000 },
    );
  });
});
