import { ProductNameParserService } from './product-name-parser.service';
import { TaxonomyService } from './taxonomy/taxonomy.service';
import { AiUsageCollector } from '../utils/ai-usage';
import {
  chatResponse,
  fakeConfig,
  installFakeOpenAi,
  openAiError,
  spyOnLogger,
} from '../utils/openai-chat.testutil';

function build(env: Record<string, string> = {}) {
  const taxonomy = { promptList: () => '101|Mercearia > Arroz' } as unknown as TaxonomyService;
  const service = new ProductNameParserService(
    fakeConfig({ OPENAI_API_KEY: 'sk-teste', ...env }),
    taxonomy,
  );
  const create = installFakeOpenAi(service);
  const logs = spyOnLogger(service);
  return { service, create, logs };
}

/** Resposta que devolve uma ficha mínima válida para cada nome do pedido. */
function answerEach(count: number) {
  return chatResponse({
    content: JSON.stringify({
      results: Array.from({ length: count }, (_, i) => ({
        title: `PRODUTO ${i}`,
        fieldConfidence: { title: 0.9 },
      })),
    }),
  });
}

const NAMES = (count: number, prefix = 'ARROZ') =>
  Array.from({ length: count }, (_, i) => ({ name: `${prefix} ${i}` }));

describe('ProductNameParserService', () => {
  it('padrão novo: gpt-6-luna, esforço low, max_completion_tokens, json_object, sem temperature nem max_tokens', async () => {
    const { service, create } = build();
    create.mockResolvedValue(answerEach(2));

    const result = await service.parseNames(NAMES(2));

    expect(result.map((r) => r?.title)).toEqual(['PRODUTO 0', 'PRODUTO 1']);
    expect(create).toHaveBeenCalledTimes(1);
    const [body, options] = create.mock.calls[0];
    expect(body).toStrictEqual({
      model: 'gpt-6-luna',
      max_completion_tokens: 16_000,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: expect.stringContaining('normalizador de catálogo') },
        { role: 'user', content: expect.stringContaining('1. "ARROZ 0"') },
      ],
    });
    expect(options).toStrictEqual({ maxRetries: 0, timeout: 60_000 });
  });

  it('com OPENAI_NAME_PARSER_MODEL=gpt-4o-mini: temperature 0.1 e max_tokens 8000, como hoje, sem reasoning_effort', async () => {
    const { service, create } = build({ OPENAI_NAME_PARSER_MODEL: 'gpt-4o-mini' });
    create.mockResolvedValue(answerEach(1));

    await service.parseNames(NAMES(1));

    const [body, options] = create.mock.calls[0];
    expect(body).toStrictEqual({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      max_tokens: 8000,
      response_format: { type: 'json_object' },
      messages: expect.any(Array),
    });
    expect(options).toStrictEqual({ maxRetries: 0, timeout: 60_000 });
  });

  it('OPENAI_FAST_TEXT_MODEL e OPENAI_TIMEOUT_MS não mudam a chamada', async () => {
    const { service, create } = build({
      OPENAI_FAST_TEXT_MODEL: 'gpt-4o-mini',
      OPENAI_TIMEOUT_MS: '180000',
    });
    create.mockResolvedValue(answerEach(1));
    await service.parseNames(NAMES(1));
    expect(create.mock.calls[0][0].model).toBe('gpt-6-luna');
    expect(create.mock.calls[0][1].timeout).toBe(60_000);
  });

  describe('versão gravada', () => {
    it('no padrão novo: diferente de name-parse-v1-2026-06 e com gpt-6-luna, no resultado e em modelVersion()', async () => {
      const { service, create } = build();
      create.mockResolvedValue(answerEach(1));

      const [parsed] = await service.parseNames(NAMES(1));

      expect(parsed?.modelVersion).toBe('name-parse-v2-2026-11:gpt-6-luna');
      expect(service.modelVersion()).toBe('name-parse-v2-2026-11:gpt-6-luna');
      expect(parsed?.modelVersion).not.toBe('name-parse-v1-2026-06');
    });

    it('na volta pela variável, a versão contém gpt-4o-mini', async () => {
      const { service, create } = build({ OPENAI_NAME_PARSER_MODEL: 'gpt-4o-mini' });
      create.mockResolvedValue(answerEach(1));

      const [parsed] = await service.parseNames(NAMES(1));

      expect(parsed?.modelVersion).toContain('gpt-4o-mini');
      expect(service.modelVersion()).toContain('gpt-4o-mini');
    });
  });

  describe('falhas e respostas inválidas', () => {
    it('parâmetro recusado (400): AI operation failed com a feature e o modelo, e o resultado é nulo', async () => {
      const { service, create, logs } = build();
      create.mockRejectedValue(openAiError(400, 'Unsupported parameter'));

      const result = await service.parseNames(NAMES(1));

      expect(result).toEqual([null]);
      const failed = logs.error.mock.calls.map((c) => String(c[0]));
      expect(failed[0]).toContain('AI operation failed');
      expect(failed[0]).toContain('"feature":"product-name-parser.batch"');
      expect(failed[0]).toContain('"model":"gpt-6-luna"');
    });

    it('prazo estourado: falha registrada e resultado nulo, sem segunda chamada para um nome só', async () => {
      const { service, create, logs } = build();
      create.mockRejectedValue(new Error('Request timed out.'));

      await expect(service.parseSingle({ name: 'ARROZ' })).resolves.toBeNull();

      expect(create).toHaveBeenCalledTimes(1);
      expect(String(logs.error.mock.calls[0][0])).toContain('AI operation failed');
    });

    it('JSON cortado pelo teto: aviso com a feature, o modelo e o motivo; depois o item a item', async () => {
      const { service, create, logs } = build();
      create
        .mockResolvedValueOnce(
          chatResponse({ content: '{"results":[{"title":"ARR', finishReason: 'length' }),
        )
        .mockResolvedValueOnce(answerEach(1))
        .mockResolvedValueOnce(answerEach(1));

      const result = await service.parseNames(NAMES(2));

      expect(create).toHaveBeenCalledTimes(3);
      expect(result.every((r) => r !== null)).toBe(true);
      const warnings = logs.warn.mock.calls.map((c) => String(c[0]));
      const truncated = warnings.find((l) => l.startsWith('AI response invalid'));
      expect(truncated).toContain('"feature":"product-name-parser.batch"');
      expect(truncated).toContain('"model":"gpt-6-luna"');
      expect(truncated).toContain('"reason":"truncated"');
      expect(warnings.some((l) => l.includes('tentando item a item'))).toBe(true);
    });

    it('resposta vazia: aviso com o motivo "empty" e resultado nulo', async () => {
      const { service, create, logs } = build();
      create.mockResolvedValue(chatResponse({ content: '' }));

      await expect(service.parseSingle({ name: 'ARROZ' })).resolves.toBeNull();

      const warning = logs.warn.mock.calls.map((c) => String(c[0])).find((l) => /invalid/.test(l));
      expect(warning).toContain('"reason":"empty"');
    });

    it('resposta válida não gera aviso nem linha de falha', async () => {
      const { service, create, logs } = build();
      create.mockResolvedValue(answerEach(1));
      await service.parseNames(NAMES(1));
      expect(logs.warn).not.toHaveBeenCalled();
      expect(logs.error).not.toHaveBeenCalled();
    });
  });

  describe('comportamento que não muda', () => {
    it('lotes de 8 nomes, em série', async () => {
      const { service, create } = build();
      create.mockImplementation(async (body: { messages: Array<{ content: string }> }) =>
        answerEach((body.messages[1].content.match(/^\d+\. "/gm) ?? []).length),
      );

      const result = await service.parseNames(NAMES(20));

      expect(create).toHaveBeenCalledTimes(3);
      expect(result).toHaveLength(20);
    });

    it('o mesmo nome duas vezes responde do cache, sem nova chamada', async () => {
      const { service, create } = build();
      create.mockResolvedValue(answerEach(2));

      await service.parseNames(NAMES(2));
      const again = await service.parseNames(NAMES(2));

      expect(create).toHaveBeenCalledTimes(1);
      expect(again.every((r) => r !== null)).toBe(true);
    });

    it('AI_NAME_PARSER_ENABLED=false: resultado nulo e nenhuma chamada', async () => {
      const { service, create } = build({ AI_NAME_PARSER_ENABLED: 'false' });
      expect(await service.parseNames(NAMES(2))).toEqual([null, null]);
      expect(create).not.toHaveBeenCalled();
    });

    it('sem a chave da OpenAI: resultado nulo e nenhuma chamada', async () => {
      const service = new ProductNameParserService(fakeConfig({}), {
        promptList: () => '',
      } as unknown as TaxonomyService);
      expect(await service.parseNames(NAMES(1))).toEqual([null]);
    });
  });
});

describe('ProductNameParserService, uso por invocação (U0.7)', () => {
  const tokens = { prompt_tokens: 1000, completion_tokens: 200 };
  const answerWithTokens = (count: number) => ({ ...answerEach(count), usage: tokens });

  it('2 lotes: soma os tokens e o custo das duas chamadas', async () => {
    const { service, create } = build();
    create.mockImplementation(async (body: { messages: Array<{ content: string }> }) =>
      answerWithTokens((body.messages[1].content.match(/^\d+\. "/gm) ?? []).length),
    );
    const usage = new AiUsageCollector();

    await service.parseNames(NAMES(16), { usage });

    expect(usage.snapshot()).toEqual({
      model: 'gpt-6-luna',
      models: ['gpt-6-luna'],
      calls: 2,
      inputTokens: 2000,
      outputTokens: 400,
      costUsd: 0.0004,
    });
  });

  it('nomes já lidos pelo processo (cache): nenhuma chamada, zero tokens e custo 0', async () => {
    const { service, create } = build();
    create.mockResolvedValue(answerWithTokens(8));
    await service.parseNames(NAMES(8));
    const usage = new AiUsageCollector();

    const again = await service.parseNames(NAMES(8), { usage });

    expect(create).toHaveBeenCalledTimes(1);
    expect(again.every((r) => r !== null)).toBe(true);
    expect(usage.snapshot()).toMatchObject({
      model: 'gpt-6-luna',
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it('AI_NAME_PARSER_ENABLED=false: resultado nulo e uso zero', async () => {
    const { service } = build({ AI_NAME_PARSER_ENABLED: 'false' });
    const usage = new AiUsageCollector();
    expect(await service.parseNames(NAMES(3), { usage })).toEqual([null, null, null]);
    expect(usage.snapshot()).toMatchObject({ calls: 0, inputTokens: 0, costUsd: 0 });
  });

  it('segundo lote falhou antes do usage: o uso soma só o primeiro', async () => {
    const { service, create, logs } = build();
    create
      .mockResolvedValueOnce(answerWithTokens(8))
      .mockRejectedValueOnce(openAiError(500, 'falha'));
    const usage = new AiUsageCollector();

    const result = await service.parseNames(NAMES(16), { usage });

    expect(result.slice(0, 8).every((r) => r !== null)).toBe(true);
    expect(result.slice(8).every((r) => r === null)).toBe(true);
    expect(usage.snapshot()).toMatchObject({ calls: 1, inputTokens: 1000, outputTokens: 200 });
    expect(logs.lines().some((l) => l.startsWith('AI operation failed'))).toBe(true);
  });

  it('item a item: soma a chamada do lote e as de cada item', async () => {
    const { service, create } = build();
    create
      .mockResolvedValueOnce({ ...chatResponse({ content: '' }), usage: tokens })
      .mockResolvedValue(answerWithTokens(1));
    const usage = new AiUsageCollector();

    await service.parseNames(NAMES(2), { usage });

    expect(usage.snapshot()).toMatchObject({ calls: 3, inputTokens: 3000, outputTokens: 600 });
  });

  it('quem não pede o uso (importador da DotCompany) recebe o resultado de hoje', async () => {
    const { service, create } = build();
    create.mockResolvedValue(answerWithTokens(2));
    const withUsage = await service.parseNames(NAMES(2), { usage: new AiUsageCollector() });
    const other = build();
    other.create.mockResolvedValue(answerWithTokens(2));
    expect(await other.service.parseNames(NAMES(2))).toEqual(withUsage);
  });

  it('parseSingle repassa o coletor', async () => {
    const { service, create } = build();
    create.mockResolvedValue(answerWithTokens(1));
    const usage = new AiUsageCollector();
    await service.parseSingle({ name: 'ARROZ' }, { usage });
    expect(usage.snapshot()).toMatchObject({ calls: 1, inputTokens: 1000 });
  });
});
