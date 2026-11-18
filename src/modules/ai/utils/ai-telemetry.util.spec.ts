import { Logger } from '@nestjs/common';
import { withAiLogging } from './ai-telemetry.util';

function finishedLine(logger: Logger): Record<string, unknown> {
  const spy = logger.log as unknown as jest.SpyInstance;
  const line = spy.mock.calls
    .map((c) => String(c[0]))
    .find((l) => l.startsWith('AI operation finished '));
  return JSON.parse(String(line).slice('AI operation finished '.length));
}

describe('withAiLogging, chamadas fora das cinco features de produto', () => {
  afterEach(() => {
    delete process.env.OPENAI_COST_TEXT_INPUT_1M_USD;
    delete process.env.OPENAI_COST_TEXT_OUTPUT_1M_USD;
  });

  it('sem `pricing`, o custo continua pela estimativa genérica das variáveis OPENAI_COST_TEXT_*', async () => {
    process.env.OPENAI_COST_TEXT_INPUT_1M_USD = '2.5';
    process.env.OPENAI_COST_TEXT_OUTPUT_1M_USD = '10';
    const logger = new Logger('teste');
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);

    await withAiLogging(
      logger,
      { feature: 'outra-feature', endpoint: 'chat.completions', model: 'gpt-4o' },
      async () => ({ usage: { prompt_tokens: 1000, completion_tokens: 200 } }),
    );

    expect(finishedLine(logger)).toMatchObject({
      estimatedCostUsd: 0.0045,
      costEstimated: true,
      costSource: 'OPENAI_COST_TEXT_INPUT_1M_USD,OPENAI_COST_TEXT_OUTPUT_1M_USD',
    });
  });

  it('sem `pricing` e sem as variáveis, nenhum custo estimado (como hoje)', async () => {
    const logger = new Logger('teste');
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);

    await withAiLogging(
      logger,
      { feature: 'outra-feature', endpoint: 'chat.completions', model: 'gpt-4o' },
      async () => ({ usage: { prompt_tokens: 1000, completion_tokens: 200 } }),
    );

    const line = finishedLine(logger);
    expect(line.costEstimated).toBe(false);
    expect(line).not.toHaveProperty('estimatedCostUsd');
  });

  it('o campo `pricing` não vai para o log', async () => {
    const logger = new Logger('teste');
    const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);

    await withAiLogging(
      logger,
      { feature: 'f', endpoint: 'chat.completions', model: 'gpt-6-luna', pricing: 'table' },
      async () => ({}),
    );

    const started = String(log.mock.calls[0][0]).slice('AI operation started '.length);
    expect(JSON.parse(started)).not.toHaveProperty('pricing');
    expect(finishedLine(logger)).not.toHaveProperty('pricing');
  });

  it('finishedFields entra só na linha finished, lido depois da operação; started e failed não o levam', async () => {
    const logger = new Logger('teste');
    const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    let discarded = 0;
    const context = {
      feature: 'f',
      endpoint: 'responses',
      model: 'gpt-6-luna',
      finishedFields: () => ({ discarded }),
    };

    await withAiLogging(logger, context, async () => {
      discarded = 2;
      return {};
    });
    await expect(
      withAiLogging(logger, context, async () => {
        throw new Error('falhou');
      }),
    ).rejects.toThrow('falhou');

    expect(finishedLine(logger)).toMatchObject({ discarded: 2, status: 'success' });
    expect(String(log.mock.calls[0][0])).not.toContain('discarded');
    expect(String(error.mock.calls[0][0])).not.toContain('discarded');
    expect(String(error.mock.calls[0][0])).not.toContain('finishedFields');
  });

  it('sem finishedFields, a linha finished tem os mesmos campos de antes', async () => {
    const logger = new Logger('teste');
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);

    await withAiLogging(
      logger,
      { feature: 'f', endpoint: 'chat.completions', model: 'gpt-6-luna', pricing: 'table' },
      async () => ({ usage: { prompt_tokens: 100, completion_tokens: 10 } }),
    );

    expect(Object.keys(finishedLine(logger)).sort()).toEqual(
      [
        'costEstimated',
        'costSource',
        'durationMs',
        'endpoint',
        'estimatedCostUsd',
        'feature',
        'inputTokens',
        'model',
        'outputTokens',
        'provider',
        'status',
        'totalTokens',
      ].sort(),
    );
  });
});
