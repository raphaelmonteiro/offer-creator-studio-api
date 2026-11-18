import { openAiError, spyOnLogger } from '../../ai/utils/openai-chat.testutil';
import { RealFlyerProStructureAi } from '../providers/flyer-pro-structure-ai.real';
import {
  fakeResponsesClient,
  responsesResult,
  USAGE,
  validResult,
} from '../providers/flyer-pro-structure-ai.testutil';
import {
  bodyOf,
  CONFIG,
  DOCUMENT_ID,
  documentRow,
  makeSuggestionService,
} from './flyer-pro-structure-suggestion.service.testutil';

const REAL = { ...CONFIG, provider: 'real' as const };

/** O serviço com o provedor real sobre o cliente simulado e o log do serviço capturado. */
function makeLogged(outcome?: unknown) {
  const { client } = fakeResponsesClient(outcome);
  const made = makeSuggestionService({
    config: REAL,
    port: new RealFlyerProStructureAi(REAL, client),
  });
  return { ...made, spies: spyOnLogger(made.service) };
}

/** A linha `AI operation <phase>` do log, já como objeto. */
function lineOf(lines: string[], phase: 'started' | 'finished' | 'failed') {
  const prefix = `AI operation ${phase} `;
  const matching = lines.filter((line) => line.startsWith(prefix));
  expect(matching).toHaveLength(1);
  return JSON.parse(matching[0].slice(prefix.length)) as Record<string, unknown>;
}

/** Uma saída válida com a seção `s7` e o destaque `p42` inventados: o saneamento tira 2 coisas. */
const inventedOutput = responsesResult(
  JSON.stringify({
    summary: '',
    sections: [
      { id: 's7', page: null, reason: '' },
      { id: 's2', page: 1, reason: '' },
      { id: 's1', page: null, reason: '' },
      { id: 's3', page: null, reason: '' },
    ],
    heroes: [{ item: 'p42', size: '2x1', reason: '' }],
  }),
  { usage: USAGE },
);

describe('FlyerProStructureSuggestionService: uso e custo no log (provedor real)', () => {
  it('a linha finished traz a feature, o modelo, os tokens, o custo pela tabela, o suggestionId e a contagem de discarded', async () => {
    const { service, spies } = makeLogged(inventedOutput);

    const view = await service.suggest(DOCUMENT_ID, bodyOf());

    expect(view.discarded).toHaveLength(2);
    expect(lineOf(spies.lines(), 'finished')).toMatchObject({
      feature: 'flyer-pro.structure-suggestion',
      endpoint: 'responses',
      model: 'gpt-6-luna',
      status: 'success',
      inputTokens: 3700,
      outputTokens: 2800,
      totalTokens: 6500,
      costEstimated: true,
      estimatedCostUsd: 0.00177,
      costSource: 'pricing-table',
      correlationId: view.suggestionId,
      discarded: 2,
    });
  });

  it('com nada tirado no saneamento, discarded é 0', async () => {
    const { service, spies } = makeLogged(validResult());

    await service.suggest(DOCUMENT_ID, bodyOf());

    expect(lineOf(spies.lines(), 'finished')).toMatchObject({ discarded: 0 });
  });

  it('a linha started leva a feature, o modelo e o suggestionId, e nenhum campo de contagem', async () => {
    const { service, spies } = makeLogged(validResult());

    const view = await service.suggest(DOCUMENT_ID, bodyOf());

    const started = lineOf(spies.lines(), 'started');
    expect(started).toMatchObject({
      feature: 'flyer-pro.structure-suggestion',
      model: 'gpt-6-luna',
      correlationId: view.suggestionId,
    });
    expect(started).not.toHaveProperty('discarded');
  });

  it('a falha do provedor deixa a linha failed com a feature, o modelo e o mesmo suggestionId do 503', async () => {
    const { service, spies } = makeLogged(openAiError(500));

    const failure = await service.suggest(DOCUMENT_ID, bodyOf()).catch((error) => error);

    const { suggestionId } = failure.getResponse().details;
    const failed = lineOf(spies.lines(), 'failed');
    expect(failed).toMatchObject({
      feature: 'flyer-pro.structure-suggestion',
      model: 'gpt-6-luna',
      status: 'error',
      correlationId: suggestionId,
      error: 'HTTP 500',
    });
    expect(failed).not.toHaveProperty('discarded');
    expect(spies.lines().some((line) => line.startsWith('AI operation finished'))).toBe(false);
  });

  it.each([
    ['saída fora do schema', responsesResult('{"sections":"x"}')],
    ['falta de cota', openAiError(429, 'sem saldo', 'insufficient_quota')],
  ])('%s também deixa a linha failed com o suggestionId do 503', async (_name, outcome) => {
    const { service, spies } = makeLogged(outcome);

    const failure = await service.suggest(DOCUMENT_ID, bodyOf()).catch((error) => error);

    expect(lineOf(spies.lines(), 'failed')).toMatchObject({
      correlationId: failure.getResponse().details.suggestionId,
    });
  });

  it('o log nunca traz a chave nem o texto do prompt e dos dados', async () => {
    const { service, spies } = makeLogged(inventedOutput);
    await service.suggest(DOCUMENT_ID, bodyOf());
    const failing = makeLogged(openAiError(500));
    await failing.service.suggest(DOCUMENT_ID, bodyOf()).catch(() => undefined);

    const text = [...spies.lines(), ...failing.spies.lines()].join('\n');
    for (const forbidden of [
      'sk-',
      'OPENAI_API_KEY',
      'DADOS',
      'PICANHA',
      'diagramador',
      'instructions',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('FlyerProStructureSuggestionService: o simulado não escreve linha de IA', () => {
  it('nem no 200 nem na falha', async () => {
    const ok = makeSuggestionService();
    const okSpies = spyOnLogger(ok.service);
    await ok.service.suggest(DOCUMENT_ID, bodyOf());
    const failing = makeSuggestionService({ document: documentRow({ name: '#ia-falha' }) });
    const failingSpies = spyOnLogger(failing.service);
    await failing.service.suggest(DOCUMENT_ID, bodyOf()).catch(() => undefined);

    expect([...okSpies.lines(), ...failingSpies.lines()]).toEqual([]);
  });
});
