import { APIConnectionTimeoutError } from 'openai';
import {
  chatResponse,
  installFakeOpenAi,
  openAiError,
  sentTo,
  spyOnLogger,
} from '../../ai/utils/openai-chat.testutil';
import { CAROUSEL_OFFERS } from '../domain/__fixtures__/mc-offer-carousel.fixtures';
import { fixturePieceDocument } from '../domain/__fixtures__/mc-piece.fixtures';
import { MC_PIPELINE_V2 } from '../domain/mc-quality';
import { McProjectStatus, McStepStatus } from '../domain/mc-state-machines';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';
import { McScriptProcessor } from './mc-script.processor';
import { newScriptProcessor, SCRIPT_STEP_ID } from './mc-script.processor.testutil';

/**
 * Chamada do diretor nos quatro formatos (change 42, task 1.10): uma função só pelo cliente do SDK, com a família
 * do modelo, prazo, repetição só de taxa e 5xx e a mesma mensagem de falha. Cliente simulado, nenhuma chamada paga.
 */
type DirectorFormat = 'v1' | 'v2' | 'talking_art' | 'offer_carousel' | 'offer_piece';

const TERRA = 'gpt-6.1-terra';
const PRODUCTS = [{ name: 'Café Pilão', price: '12,90' }];

const PROJECTS: Record<DirectorFormat, Record<string, unknown>> = {
  v1: base({ options: { musicEnabled: false, captionsEnabled: false, products: PRODUCTS } }),
  v2: base({
    pipelineVersion: MC_PIPELINE_V2,
    options: { musicEnabled: false, captionsEnabled: false, products: PRODUCTS },
  }),
  talking_art: base({
    format: 'talking_art',
    pipelineVersion: MC_PIPELINE_V2,
    aspectRatio: '9:16',
    options: { musicEnabled: false, captionsEnabled: false, products: CAROUSEL_OFFERS.slice(0, 4) },
  }),
  offer_carousel: base({
    format: 'offer_carousel',
    pipelineVersion: MC_PIPELINE_V2,
    options: { musicEnabled: false, captionsEnabled: false, products: CAROUSEL_OFFERS.slice(0, 4) },
  }),
  offer_piece: base({
    format: 'offer_piece',
    pipelineVersion: MC_PIPELINE_V2,
    aspectRatio: '9:16',
    options: { musicEnabled: false, captionsEnabled: false, products: PRODUCTS },
    pieceId: 'piece-1',
    pieceSnapshot: fixturePieceDocument(),
  }),
};

function base(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'p1',
    userId: 'u1',
    kitId: 'k1',
    tier: 'economico',
    briefing: 'Ofertas da semana',
    targetDurationS: 20,
    reservedCredits: 0,
    consumedCredits: 0,
    ...extra,
  };
}

/** A resposta do provedor de cada formato (o que o `json_schema` do diretor devolve). */
const REPLIES: Record<DirectorFormat, unknown> = {
  v1: {
    scenes: [
      { actionPrompt: 'Mascote acena', dialogue: 'Café Pilão a doze e noventa!', durationS: 6 },
    ],
  },
  v2: {
    scenes: [
      {
        sceneType: 'presenter',
        actionPrompt: 'Mascote acena',
        actionPromptEn: 'The mascot waves',
        initialFrame: 'Mascote na cozinha',
        initialFrameEn: 'The mascot in the kitchen',
        dialogue: 'Café Pilão a doze e noventa!',
        durationS: 6,
        productIndex: 0,
      },
    ],
  },
  talking_art: {
    narration:
      'Chegou a hora das ofertas! Arroz por vinte e quatro reais e noventa centavos. Corre pra loja!',
    citedOfferIndexes: [0],
  },
  offer_carousel: {
    opening: 'Chegou a hora das ofertas!',
    offerLines: [0, 1, 2, 3].map((offerIndex) => ({
      offerIndex,
      text: `Oferta número ${offerIndex}!`,
    })),
    closing: 'Corre pro Mercadão!',
  },
  offer_piece: {
    opening: 'Olá! Ofertas de hoje!',
    offerLines: [0, 1, 2].map((offerIndex) => ({ offerIndex, text: `Item número ${offerIndex}!` })),
    closing: 'Corre pra cá!',
  },
};

/** Nome do `json_schema` de cada formato (o mesmo de antes da change). */
const SCHEMA_NAMES: Record<DirectorFormat, string> = {
  v1: 'roteiro_comercial',
  v2: 'roteiro_comercial_v2',
  talking_art: 'fala_arte_que_fala',
  offer_carousel: 'falas_ofertas_em_sequencia',
  offer_piece: 'falas_ofertas_em_sequencia',
};

const FORMATS = Object.keys(PROJECTS) as DirectorFormat[];

describe('McScriptProcessor — chamada do diretor (42, 1.10)', () => {
  const originalProvider = process.env.MC_SCRIPT_PROVIDER;
  const config: Record<string, string> = {};
  let harness: ReturnType<typeof newScriptProcessor>;
  let processor: McScriptProcessor;
  let create: jest.Mock;
  let logs: ReturnType<typeof spyOnLogger>;

  /** Monta o processador do formato com o cliente simulado respondendo `replies` na ordem. */
  function setUp(format: DirectorFormat, ...replies: unknown[]): void {
    harness = newScriptProcessor({ project: PROJECTS[format], tradeName: 'Mercadão', config });
    processor = harness.processor;
    create = installFakeOpenAi(processor);
    logs = spyOnLogger(processor);
    for (const reply of replies) {
      create.mockImplementationOnce(() =>
        reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply),
      );
    }
  }

  const ok = (format: DirectorFormat) => chatResponse({ content: JSON.stringify(REPLIES[format]) });

  /** Mensagem gravada no step quando o job falha. */
  function stepFailure(): string {
    const call = harness.transitions.casTransition.mock.calls.find(
      (args) => args[1] === McStep && args[4] === McStepStatus.FAILED,
    );
    return (call?.[5] as { errorMessage: string }).errorMessage;
  }

  beforeEach(() => {
    for (const key of Object.keys(config)) delete config[key];
    config.OPENAI_API_KEY = 'sk-test';
    process.env.MC_SCRIPT_PROVIDER = 'openai';
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.MC_SCRIPT_PROVIDER;
    else process.env.MC_SCRIPT_PROVIDER = originalProvider;
  });

  describe.each(FORMATS)('formato %s', (format) => {
    it('Diretor em Terra: esforço low, teto da família nova, o mesmo json_schema e sem temperature', async () => {
      setUp(format, ok(format));
      await processor.process({ stepId: SCRIPT_STEP_ID });

      expect(create).toHaveBeenCalledTimes(1);
      const { body, options } = sentTo(create);
      expect(body).toMatchObject({
        model: TERRA,
        reasoning_effort: 'low',
        max_completion_tokens: 16_000,
        response_format: {
          type: 'json_schema',
          json_schema: { name: SCHEMA_NAMES[format], strict: true },
        },
      });
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('max_tokens');
      expect(options).toEqual({ maxRetries: 0, timeout: 100_000 });
    });

    it('volta a gpt-4o: o corpo de hoje (temperature 0.7, sem teto, sem esforço)', async () => {
      config.MC_DIRECTOR_MODEL = 'gpt-4o';
      setUp(format, ok(format));
      await processor.process({ stepId: SCRIPT_STEP_ID });

      const { body, options } = sentTo(create);
      expect(body).toMatchObject({ model: 'gpt-4o', temperature: 0.7 });
      expect(body).not.toHaveProperty('max_tokens');
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(options).toEqual({ maxRetries: 0, timeout: 100_000 });
    });

    it('grava o roteiro do formato com a resposta do provedor', async () => {
      setUp(format, ok(format));
      await processor.process({ stepId: SCRIPT_STEP_ID });

      expect(harness.manager.update).toHaveBeenCalledWith(
        McProject,
        { id: 'p1' },
        expect.objectContaining({ script: expect.any(Object) }),
      );
      expect(harness.saved()).toMatchObject(SAVED[format]);
    });
  });

  it('o diretor não herda OPENAI_TEXT_MODEL, e variável vazia ou só com espaços vale o padrão', async () => {
    config.OPENAI_TEXT_MODEL = 'gpt-4o';
    config.MC_DIRECTOR_MODEL = '   ';
    setUp('v2', ok('v2'));
    await processor.process({ stepId: SCRIPT_STEP_ID });
    expect(sentTo(create).body.model).toBe(TERRA);

    config.MC_DIRECTOR_MODEL = '';
    setUp('v1', ok('v1'));
    await processor.process({ stepId: SCRIPT_STEP_ID });
    expect(sentTo(create).body.model).toBe(TERRA);
  });

  it('Conta sem crédito no diretor: uma única chamada e o projeto falha com script_failed', async () => {
    setUp('v2', openAiError(429, 'You exceeded your current quota', 'insufficient_quota'));
    await processor.process({ stepId: SCRIPT_STEP_ID });

    expect(create).toHaveBeenCalledTimes(1);
    expect(stepFailure()).toBe('script_failed: OpenAI HTTP 429: You exceeded your current quota');
    const projectPatch = harness.transitions.casTransition.mock.calls.find(
      (args) => args[1] === McProject && args[4] === McProjectStatus.FAILED,
    )?.[5] as { errorCode: string };
    expect(projectPatch.errorCode).toBe('script_failed');
  });

  it.each([
    ['503 (erro temporário)', 503, undefined],
    ['429 de limite de taxa', 429, 'rate_limit_exceeded'],
  ])(
    'Erro temporário no diretor, %s: a segunda chamada sai depois da espera e o roteiro é gravado',
    async (_name, status, code) => {
      const transient = Object.assign(openAiError(status, 'Servidor ocupado', code), {
        headers: { 'retry-after-ms': '0' },
      });
      setUp('v2', transient, ok('v2'));
      await processor.process({ stepId: SCRIPT_STEP_ID });

      expect(create).toHaveBeenCalledTimes(2);
      expect(harness.saved().scenes).toHaveLength(1);
    },
  );

  it('Falha do diretor: 400 não repete, a mensagem é a de sempre e o log traz o consumidor e o modelo, sem custo', async () => {
    setUp('v2', openAiError(400, 'Invalid schema'));
    await processor.process({ stepId: SCRIPT_STEP_ID });

    expect(create).toHaveBeenCalledTimes(1);
    expect(stepFailure()).toBe('script_failed: OpenAI HTTP 400: Invalid schema');
    const failed = logs.lines().find((line) => line.startsWith('AI operation failed'));
    expect(failed).toContain('"feature":"commercials.director"');
    expect(failed).toContain(`"model":"${TERRA}"`);
    expect(failed).not.toContain('estimatedCostUsd');
  });

  it('prazo estourado: o SDK sinaliza o prazo, o erro transitório é repetido e a falha traz a mensagem dele', async () => {
    jest.useFakeTimers();
    try {
      const timeout = new APIConnectionTimeoutError();
      setUp('v2', timeout, timeout, timeout);
      const running = processor.process({ stepId: SCRIPT_STEP_ID });
      await jest.runAllTimersAsync();
      await running;
    } finally {
      jest.useRealTimers();
    }
    expect(create).toHaveBeenCalledTimes(3);
    expect(stepFailure()).toBe('script_failed: Request timed out.');
  });

  it('Diretor em Terra: o log de fim traz o custo pela tabela; em gpt-4o o custo é nulo, nunca zero', async () => {
    const usage = { prompt_tokens: 3000, completion_tokens: 2000 };
    setUp('v2', chatResponse({ content: JSON.stringify(REPLIES.v2), usage }));
    await processor.process({ stepId: SCRIPT_STEP_ID });
    // 3000 × 1,00/1M + 2000 × 5,00/1M
    expect(finishedLine()).toContain('"estimatedCostUsd":0.013');

    config.MC_DIRECTOR_MODEL = 'gpt-4o';
    setUp('v2', chatResponse({ content: JSON.stringify(REPLIES.v2), usage }));
    await processor.process({ stepId: SCRIPT_STEP_ID });
    expect(finishedLine()).toContain('"estimatedCostUsd":null');
  });

  it('resposta cortada pelo teto de saída falha com mensagem própria e deixa o aviso no log', async () => {
    setUp('v2', chatResponse({ content: '{"scenes":[{"actionPr', finishReason: 'length' }));
    await processor.process({ stepId: SCRIPT_STEP_ID });

    expect(stepFailure()).toBe('script_failed: resposta do OpenAI cortada pelo teto de saída');
    expect(logs.lines().some((line) => line.includes('"reason":"truncated"'))).toBe(true);
  });

  it('resposta sem conteúdo falha como sempre', async () => {
    setUp('v2', chatResponse({ content: null }));
    await processor.process({ stepId: SCRIPT_STEP_ID });
    expect(stepFailure()).toBe('script_failed: resposta do OpenAI sem conteúdo');
  });

  it('sem OPENAI_API_KEY falha como sempre, sem chamada', async () => {
    delete config.OPENAI_API_KEY;
    setUp('v2');
    await processor.process({ stepId: SCRIPT_STEP_ID });

    expect(create).not.toHaveBeenCalled();
    expect(stepFailure()).toBe('script_failed: OPENAI_API_KEY ausente');
  });

  function finishedLine(): string {
    return logs.lines().find((line) => line.startsWith('AI operation finished')) ?? '';
  }
});

/** O que o roteiro de cada formato traz para a resposta de `REPLIES` (montagem do domínio, igual à de antes). */
const SAVED: Record<DirectorFormat, Record<string, unknown>> = {
  v1: {
    version: 2,
    scenes: [
      {
        idx: 0,
        actionPrompt: 'Mascote acena',
        dialogue: 'Café Pilão a doze e noventa!',
        durationS: 6,
      },
    ],
    seal: { products: [{ name: 'Café Pilão', price: '12,90' }] },
    endcard: { storeName: 'Mercadão' },
  },
  v2: {
    version: 1,
    scenes: [
      { idx: 0, sceneType: 'presenter', dialogue: 'Café Pilão a doze e noventa!', durationS: 6 },
    ],
    endcard: { storeName: 'Mercadão' },
  },
  talking_art: {
    format: 'talking_art',
    narration:
      'Chegou a hora das ofertas! Arroz por vinte e quatro reais e noventa centavos. Corre pra loja!',
    citedOfferIds: ['of-arroz'],
    endcard: { storeName: 'Mercadão' },
  },
  offer_carousel: {
    format: 'offer_carousel',
    endcard: { storeName: 'Mercadão' },
  },
  offer_piece: {
    format: 'offer_piece',
    endcard: { storeName: 'Mercadão' },
  },
};
