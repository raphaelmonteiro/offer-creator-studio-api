import { openAiError } from '../../ai/utils/openai-chat.testutil';
import { rawSection } from '../domain/structure-suggestion-sanitize.testutil';
import { EMPTY_RAW_SUGGESTION, PICANHA_ID } from '../domain/structure-suggestion.testutil';
import { RealFlyerProStructureAi } from '../providers/flyer-pro-structure-ai.real';
import {
  outputWith,
  responsesResult,
  validResult,
} from '../providers/flyer-pro-structure-ai.testutil';
import {
  bodyOf,
  DOCUMENT_ID,
  makeRealSuggestionService,
  makeSuggestionService,
  REAL_CONFIG,
} from './flyer-pro-structure-suggestion.service.testutil';

/** As três seções do exemplo na ordem do pedido, sem página, para a resposta que não muda nada. */
const orderOfExample = () => [rawSection('s1'), rawSection('s2'), rawSection('s3')];

describe('FlyerProStructureSuggestionService com o provedor real (cliente simulado)', () => {
  it('200 com source ai, o modelo configurado e a versão 2 do prompt, sem tokens nem custo na resposta', async () => {
    const { service, create } = makeRealSuggestionService();

    const view = await service.suggest(DOCUMENT_ID, bodyOf());

    expect(view).toMatchObject({
      source: 'ai',
      model: 'gpt-6-luna',
      promptVersion: 2,
      noChange: false,
    });
    expect(JSON.stringify(view)).not.toMatch(/usage|tokens|costUsd|estimatedCostUsd/);
    expect(view.sections.map((section) => [section.id, section.page])).toEqual([
      ['cat:Carnes', 1],
      ['cat:Hortifruti', null],
      ['cat:Bebidas', 2],
    ]);
    expect(view.heroes.map((hero) => hero.itemId)).toEqual([PICANHA_ID]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('o corpo enviado pelo serviço tem o modelo, store false e o schema estrito, sem previous_response_id', async () => {
    const { service, create } = makeRealSuggestionService();
    await service.suggest(DOCUMENT_ID, bodyOf());

    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'gpt-6-luna',
      store: false,
      reasoning: { effort: 'medium' },
      max_output_tokens: 16_000,
      text: {
        format: { type: 'json_schema', name: 'flyer_pro_structure_suggestion', strict: true },
      },
    });
    expect(create.mock.calls[0][0]).not.toHaveProperty('previous_response_id');
    expect(create.mock.calls[0][1]).toEqual({ timeout: 60_000, maxRetries: 0 });
  });

  it('id inventado pelo modelo (seção s7 e destaque p42) sai no saneamento, com UNKNOWN_SECTION e UNKNOWN_ITEM', async () => {
    const output = {
      ...EMPTY_RAW_SUGGESTION,
      sections: [rawSection('s7'), rawSection('s2', 1, 'abre'), rawSection('s1'), rawSection('s3')],
      heroes: [{ item: 'p42', size: '2x1', reason: '' }],
    };
    const { service } = makeRealSuggestionService(responsesResult(JSON.stringify(output)));

    const view = await service.suggest(DOCUMENT_ID, bodyOf());

    expect(view.discarded).toEqual([
      { kind: 'section', code: 'UNKNOWN_SECTION' },
      { kind: 'hero', code: 'UNKNOWN_ITEM' },
    ]);
    expect(view.heroes).toEqual([]);
  });

  it.each([
    ['Campanha de desconto', { kind: 'discount', label: 'Black Friday' }, 'Black Friday'],
    ['Campanha de categoria', { kind: 'category', label: 'Churrasco' }, 'Churrasco'],
  ])(
    '%s: a campanha lida chega na resposta, sem mudar o noChange',
    async (_name, campaign, label) => {
      const output = { ...EMPTY_RAW_SUGGESTION, campaign, sections: orderOfExample() };
      const { service } = makeRealSuggestionService(responsesResult(JSON.stringify(output)));

      const view = await service.suggest(DOCUMENT_ID, bodyOf());

      expect(view.campaign).toEqual({ kind: campaign.kind, label });
      expect(view.noChange).toBe(true);
    },
  );

  it.each([
    ['kind none', { kind: 'none', label: '' }],
    ['rótulo só de espaços', { kind: 'discount', label: '   ' }],
  ])('Sem campanha: %s vira campaign null, sem entrada em discarded', async (_name, campaign) => {
    const output = { ...EMPTY_RAW_SUGGESTION, campaign, sections: orderOfExample() };
    const { service } = makeRealSuggestionService(responsesResult(JSON.stringify(output)));

    const view = await service.suggest(DOCUMENT_ID, bodyOf());

    expect(view.campaign).toBeNull();
    expect(view.discarded).toEqual([]);
  });

  it('sem chave: 422 DISABLED com NO_API_KEY, o cliente não é chamado e o pedido não conta no teto', async () => {
    const made = makeSuggestionService({
      config: REAL_CONFIG,
      port: new RealFlyerProStructureAi(REAL_CONFIG, null),
    });

    await expect(made.service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({
      status: 422,
      response: { code: 'FLYER_PRO_STRUCTURE_AI_DISABLED', details: { reason: 'NO_API_KEY' } },
    });
    expect(made.limiter.checkHourly(DOCUMENT_ID, 1)).toBeNull();
    expect(made.limiter.tryAcquire(DOCUMENT_ID, 1000)).toHaveProperty('token');
  });

  it('modelo sem preço na tabela (gpt-4o-mini): 422 DISABLED com MODEL_PRICE_UNKNOWN e o cliente não é chamado', async () => {
    const { service, create } = makeRealSuggestionService(validResult(), { model: 'gpt-4o-mini' });

    await expect(service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({
      status: 422,
      response: { details: { reason: 'MODEL_PRICE_UNKNOWN' } },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('o provedor simulado não depende de chave nem de preço: com gpt-4o-mini e sem chave responde 200 source mock', async () => {
    const { service } = makeSuggestionService({
      config: { provider: 'mock', model: 'gpt-4o-mini' },
    });

    await expect(service.suggest(DOCUMENT_ID, bodyOf())).resolves.toMatchObject({ source: 'mock' });
  });

  it.each([
    [
      'saída fora do schema (campo a mais "pages")',
      responsesResult(outputWith({ pages: 3 })),
      'INVALID_OUTPUT',
    ],
    [
      'saída no formato da versão 1',
      responsesResult('{"summary":"","sections":[],"heroes":[]}'),
      'INVALID_OUTPUT',
    ],
    [
      'página a mais na saída (pageCount na raiz)',
      responsesResult(outputWith({ pageCount: 3 })),
      'INVALID_OUTPUT',
    ],
    [
      'divisão de seção na saída (split na seção s2)',
      responsesResult(outputWith({ sections: [{ ...rawSection('s2'), split: 2 }] })),
      'INVALID_OUTPUT',
    ],
    [
      'tipo de campanha fora da lista',
      responsesResult(outputWith({ campaign: { kind: 'natal', label: 'Natal' } })),
      'INVALID_OUTPUT',
    ],
    ['status incomplete', responsesResult('{}', { status: 'incomplete' }), 'INVALID_OUTPUT'],
    ['erro 500', openAiError(500), 'PROVIDER_ERROR'],
    [
      '429 insufficient_quota',
      openAiError(429, 'sem saldo', 'insufficient_quota'),
      'PROVIDER_ERROR',
    ],
  ])(
    '%s: 503, o cliente é chamado uma vez só e a falha não conta no teto',
    async (_name, outcome, reason) => {
      const { service, create, limiter } = makeRealSuggestionService(outcome);

      await expect(service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({
        status: 503,
        response: { code: 'FLYER_PRO_STRUCTURE_AI_FAILED', details: { reason } },
      });

      expect(create).toHaveBeenCalledTimes(1);
      expect(limiter.checkHourly(DOCUMENT_ID, 1)).toBeNull();
    },
  );

  describe('prazo', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('o cliente que não responde dentro do prazo é 503 TIMEOUT, chamado uma vez só', async () => {
      const { service, create } = makeRealSuggestionService(undefined, { timeoutMs: 1000 });
      create.mockImplementation(() => new Promise(() => undefined));

      const pending = service.suggest(DOCUMENT_ID, bodyOf());
      const outcome = expect(pending).rejects.toMatchObject({
        status: 503,
        response: { details: { reason: 'TIMEOUT' } },
      });
      await jest.advanceTimersByTimeAsync(1000);
      await outcome;

      expect(create).toHaveBeenCalledTimes(1);
    });
  });
});
