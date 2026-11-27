import { APIConnectionTimeoutError } from 'openai';
import { openAiError } from '../../ai/utils/openai-chat.testutil';
import type { StructureAiConfig } from '../config/structure-ai.config';
import { exampleAiRequest } from '../domain/structure-ai-request.testutil';
import { STRUCTURE_SUGGESTION_INSTRUCTIONS } from '../prompts/structure-suggestion.prompt';
import { REAL_CONFIG } from '../services/flyer-pro-structure-suggestion.service.testutil';
import { RealFlyerProStructureAi } from './flyer-pro-structure-ai.real';
import {
  fakeResponsesClient,
  outputWith,
  responsesResult,
  USAGE,
  VALID_OUTPUT,
  validResult,
} from './flyer-pro-structure-ai.testutil';

const OPTIONS = { timeoutMs: 25_000 };

/** Uma seção válida da saída, com campos trocados ou acrescidos. */
const sectionWith = (over: Record<string, unknown>) => ({
  id: 's1',
  page: null,
  reason: '',
  items: null,
  itemsReason: '',
  ...over,
});

function makeReal(outcome?: unknown, config: Partial<StructureAiConfig> = {}) {
  const { client, create } = fakeResponsesClient(outcome);
  return { provider: new RealFlyerProStructureAi({ ...REAL_CONFIG, ...config }, client), create };
}

type CallBody = {
  model: string;
  instructions: string;
  input: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
  text: { format: { type: string; name: string; strict: boolean; schema: object } };
  [key: string]: unknown;
};
const bodyOf = (create: jest.Mock) => create.mock.calls[0][0] as CallBody;

describe('RealFlyerProStructureAi: o corpo da chamada a /responses', () => {
  it('confere com o snapshot do corpo e das opções', async () => {
    const { provider, create } = makeReal();
    await provider.suggest(exampleAiRequest(), OPTIONS);
    expect(create.mock.calls[0]).toMatchSnapshot();
  });

  it('gpt-6-luna com os padrões: instruções, DADOS em input, schema estrito, store false e sem previous_response_id', async () => {
    const { provider, create } = makeReal();
    await provider.suggest(exampleAiRequest(), OPTIONS);

    const body = bodyOf(create);
    expect(body.model).toBe('gpt-6-luna');
    expect(body.instructions).toBe(STRUCTURE_SUGGESTION_INSTRUCTIONS);
    expect(body.input).toHaveLength(1);
    expect(body.input[0].role).toBe('user');
    expect(body.input[0].content[0].type).toBe('input_text');
    expect(body.input[0].content[0].text.startsWith('DADOS\n')).toBe(true);
    expect(body.text.format).toMatchObject({
      type: 'json_schema',
      name: 'flyer_pro_structure_suggestion',
      strict: true,
    });
    expect(body.store).toBe(false);
    expect(body).not.toHaveProperty('previous_response_id');
  });

  it('parâmetros do helper: reasoning low e 4.000 tokens de saída, sem temperature, max_tokens nem max_completion_tokens; prazo e sem repetição', async () => {
    const { provider, create } = makeReal();
    await provider.suggest(exampleAiRequest(), OPTIONS);

    const body = bodyOf(create);
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.max_output_tokens).toBe(4000);
    for (const field of ['temperature', 'max_tokens', 'max_completion_tokens']) {
      expect(body).not.toHaveProperty(field);
    }
    expect(create.mock.calls[0][1]).toEqual({ timeout: 25_000, maxRetries: 0 });
  });

  it('Schema no corpo: o schema fechado, com additionalProperties false nos cinco objetos', async () => {
    const { provider, create } = makeReal();
    await provider.suggest(exampleAiRequest(), OPTIONS);

    const schema = bodyOf(create).text.format.schema as {
      additionalProperties: boolean;
      properties: {
        campaign: object;
        sections: { items: object };
        heroes: { items: object };
        unsuggest: { items: object };
      };
    };
    const { campaign, sections, heroes, unsuggest } = schema.properties;
    for (const object of [schema, campaign, sections.items, heroes.items, unsuggest.items]) {
      expect(object).toMatchObject({ additionalProperties: false });
    }
  });

  it('o modelo, o esforço e o prazo vêm da configuração e da chamada', async () => {
    const { provider, create } = makeReal(validResult(), {
      model: 'gpt-6.1-terra',
      effort: 'medium',
    });
    const result = await provider.suggest(exampleAiRequest(), { ...OPTIONS, timeoutMs: 1000 });

    expect(bodyOf(create)).toMatchObject({
      model: 'gpt-6.1-terra',
      reasoning: { effort: 'medium' },
    });
    expect(create.mock.calls[0][1]).toEqual({ timeout: 1000, maxRetries: 0 });
    expect(result.model).toBe('gpt-6.1-terra');
  });

  it('esforço none leva a temperatura de 0,2', async () => {
    const { provider, create } = makeReal(validResult(), { effort: 'none' });
    await provider.suggest(exampleAiRequest(), OPTIONS);
    expect(bodyOf(create)).toMatchObject({ reasoning: { effort: 'none' }, temperature: 0.2 });
  });
});

describe('RealFlyerProStructureAi: a saída do modelo', () => {
  it('uma saída válida volta como a proposta bruta, com o modelo configurado e os tokens', async () => {
    const { provider, create } = makeReal();
    const result = await provider.suggest(exampleAiRequest(), OPTIONS);

    expect(result).toEqual({ suggestion: VALID_OUTPUT, model: 'gpt-6-luna', usage: USAGE });
    expect(provider.source).toBe('ai');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('sem usage na resposta, usage nulo', async () => {
    const { provider } = makeReal(responsesResult(JSON.stringify(VALID_OUTPUT), { usage: null }));
    expect((await provider.suggest(exampleAiRequest(), OPTIONS)).usage).toBeNull();
  });

  it('o corpo que lista mais de uma mensagem junta o texto, como o Diretor', async () => {
    const half = JSON.stringify(VALID_OUTPUT);
    const split = {
      status: 'completed',
      output: [
        { type: 'reasoning', content: [] },
        { type: 'message', content: [{ type: 'output_text', text: half.slice(0, 20) }] },
        { type: 'message', content: [{ type: 'output_text', text: half.slice(20) }] },
      ],
    };
    const { provider } = makeReal(split);
    expect((await provider.suggest(exampleAiRequest(), OPTIONS)).suggestion).toEqual(VALID_OUTPUT);
  });

  it.each([
    ['texto vazio', responsesResult('')],
    ['status incomplete', responsesResult(JSON.stringify(VALID_OUTPUT), { status: 'incomplete' })],
    ['resposta sem mensagem', { status: 'completed', output: [] }],
    ['texto que não é JSON', responsesResult('Claro! Aqui está a estrutura')],
    ['sections como texto', responsesResult('{"sections": "x"}')],
    ['campo a mais na raiz', responsesResult(outputWith({ pages: 3 }))],
    ['campo que falta na raiz', responsesResult('{"summary":"","sections":[]}')],
    ['saída no formato da versão 1', responsesResult('{"summary":"","sections":[],"heroes":[]}')],
    ['campo a mais numa seção', responsesResult(outputWith({ sections: [sectionWith({ x: 1 })] }))],
    [
      'page que não é inteiro',
      responsesResult(outputWith({ sections: [sectionWith({ page: 1.5 })] })),
    ],
    ['page em texto', responsesResult(outputWith({ sections: [sectionWith({ page: '1' })] }))],
    [
      'tamanho 3x3',
      responsesResult(outputWith({ heroes: [{ item: 'p01', size: '3x3', reason: '' }] })),
    ],
    [
      'destaque sem reason',
      responsesResult(outputWith({ heroes: [{ item: 'p01', size: '2x1' }] })),
    ],
    ['summary que não é texto', responsesResult(outputWith({ summary: 3 }))],
    ['JSON que é lista', responsesResult('[]')],
    ['JSON nulo', responsesResult('null')],
  ])('%s é INVALID_OUTPUT, e o cliente foi chamado uma vez só', async (_name, outcome) => {
    const { provider, create } = makeReal(outcome);

    await expect(provider.suggest(exampleAiRequest(), OPTIONS)).rejects.toMatchObject({
      name: 'StructureAiFailure',
      reason: 'INVALID_OUTPUT',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('RealFlyerProStructureAi: falha do provedor, sem repetir', () => {
  it.each([
    ['prazo do SDK', new APIConnectionTimeoutError(), 'TIMEOUT'],
    ['erro 500', openAiError(500), 'PROVIDER_ERROR'],
    [
      '429 insufficient_quota',
      openAiError(429, 'sem saldo', 'insufficient_quota'),
      'PROVIDER_ERROR',
    ],
    ['429 limite de taxa', openAiError(429, 'rate limit'), 'PROVIDER_ERROR'],
    ['erro qualquer', new Error('boom'), 'PROVIDER_ERROR'],
  ])('%s vira o motivo esperado e o cliente é chamado uma vez só', async (_name, error, reason) => {
    const { provider, create } = makeReal(error);

    await expect(provider.suggest(exampleAiRequest(), OPTIONS)).rejects.toMatchObject({
      name: 'StructureAiFailure',
      reason,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a mensagem do erro, que vai para a linha do log, traz a classificação (falta de cota)', async () => {
    const { provider } = makeReal(openAiError(429, 'sem saldo', 'insufficient_quota'));

    await expect(provider.suggest(exampleAiRequest(), OPTIONS)).rejects.toThrow(
      /insufficient_quota/,
    );
  });
});

describe('RealFlyerProStructureAi: indisponível por configuração', () => {
  it('sem cliente (sem chave) o motivo é NO_API_KEY, mesmo com modelo sem preço', () => {
    expect(new RealFlyerProStructureAi(REAL_CONFIG, null).unavailableReason()).toBe('NO_API_KEY');
    expect(
      new RealFlyerProStructureAi(
        { ...REAL_CONFIG, model: 'gpt-4o-mini' },
        null,
      ).unavailableReason(),
    ).toBe('NO_API_KEY');
  });

  it('com chave e modelo sem preço na tabela o motivo é MODEL_PRICE_UNKNOWN', () => {
    const { client } = fakeResponsesClient();
    expect(
      new RealFlyerProStructureAi(
        { ...REAL_CONFIG, model: 'gpt-4o-mini' },
        client,
      ).unavailableReason(),
    ).toBe('MODEL_PRICE_UNKNOWN');
  });

  it('com chave e modelo com preço (luna e terra) não há motivo', () => {
    const { client } = fakeResponsesClient();
    for (const model of ['gpt-6-luna', 'gpt-6.1-terra']) {
      expect(
        new RealFlyerProStructureAi({ ...REAL_CONFIG, model }, client).unavailableReason(),
      ).toBeNull();
    }
  });

  it('chamado sem cliente, falha sem rede', async () => {
    await expect(
      new RealFlyerProStructureAi(REAL_CONFIG, null).suggest(exampleAiRequest(), OPTIONS),
    ).rejects.toMatchObject({
      reason: 'PROVIDER_ERROR',
    });
  });
});
