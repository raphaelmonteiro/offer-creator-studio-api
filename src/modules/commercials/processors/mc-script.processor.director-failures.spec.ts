import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import { chatResponse, openAiError, sentTo } from '../../ai/utils/openai-chat.testutil';
import {
  directorRig,
  finishedLine,
  okReply,
  projectErrorCode,
  stepFailure,
  TERRA,
  useOpenAiDirectorEnv,
} from './mc-script.processor.director.testutil';
import { SCRIPT_STEP_ID } from './mc-script.processor.testutil';

/**
 * Repetição e falha da chamada do diretor (change 42, task 1.10; R4 da rodada 1 dividiu o arquivo do diretor): conta
 * sem crédito, erro temporário, recusa, rede e prazo, resposta cortada ou vazia e o custo no log. Cliente simulado,
 * nenhuma chamada paga.
 */
describe('McScriptProcessor — falhas e repetição do diretor (42, 1.10)', () => {
  const config: Record<string, string> = {};
  useOpenAiDirectorEnv(config);

  it('Conta sem crédito no diretor: uma única chamada e o projeto falha com script_failed', async () => {
    const { harness, processor, create } = directorRig(
      'v2',
      config,
      openAiError(429, 'You exceeded your current quota', 'insufficient_quota'),
    );
    await processor.process({ stepId: SCRIPT_STEP_ID });

    expect(create).toHaveBeenCalledTimes(1);
    expect(stepFailure(harness)).toBe(
      'script_failed: OpenAI HTTP 429: You exceeded your current quota',
    );
    expect(projectErrorCode(harness)).toBe('script_failed');
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
      const { harness, processor, create } = directorRig('v2', config, transient, okReply('v2'));
      await processor.process({ stepId: SCRIPT_STEP_ID });

      expect(create).toHaveBeenCalledTimes(2);
      expect(harness.saved().scenes).toHaveLength(1);
    },
  );

  it('Falha do diretor: 400 não repete, a mensagem é a de sempre e o log traz o consumidor e o modelo, sem custo', async () => {
    const { harness, processor, create, logs } = directorRig(
      'v2',
      config,
      openAiError(400, 'Invalid schema'),
    );
    await processor.process({ stepId: SCRIPT_STEP_ID });

    expect(create).toHaveBeenCalledTimes(1);
    expect(stepFailure(harness)).toBe('script_failed: OpenAI HTTP 400: Invalid schema');
    const failed = logs.lines().find((line) => line.startsWith('AI operation failed'));
    expect(failed).toContain('"feature":"commercials.director"');
    expect(failed).toContain(`"model":"${TERRA}"`);
    expect(failed).not.toContain('estimatedCostUsd');
  });

  it.each([
    ['prazo estourado', () => new APIConnectionTimeoutError(), 'script_failed: Request timed out.'],
    ['rede caída', () => new APIConnectionError({}), 'script_failed: Connection error.'],
  ])(
    '%s: uma única chamada, sem repetir, e a falha traz a mensagem do SDK',
    async (_name, error, message) => {
      const { harness, processor, create } = directorRig('v2', config, error());
      await processor.process({ stepId: SCRIPT_STEP_ID });

      expect(create).toHaveBeenCalledTimes(1);
      expect(stepFailure(harness)).toBe(message);
    },
  );

  it('Diretor em Terra: o log de fim traz o custo pela tabela; em gpt-4o o custo é nulo, nunca zero', async () => {
    const usage = { prompt_tokens: 3000, completion_tokens: 2000 };
    const content = okReply('v2').choices[0].message.content;
    const terra = directorRig('v2', config, chatResponse({ content, usage }));
    await terra.processor.process({ stepId: SCRIPT_STEP_ID });
    // 3000 × 1,00/1M + 2000 × 5,00/1M
    expect(finishedLine(terra.logs)).toContain('"estimatedCostUsd":0.013');

    config.MC_DIRECTOR_MODEL = 'gpt-4o';
    const legacy = directorRig('v2', config, chatResponse({ content, usage }));
    await legacy.processor.process({ stepId: SCRIPT_STEP_ID });
    expect(finishedLine(legacy.logs)).toContain('"estimatedCostUsd":null');
  });

  it('resposta cortada pelo teto de saída falha com mensagem própria e deixa o aviso no log', async () => {
    const { harness, processor, logs } = directorRig(
      'v2',
      config,
      chatResponse({ content: '{"scenes":[{"actionPr', finishReason: 'length' }),
    );
    await processor.process({ stepId: SCRIPT_STEP_ID });

    expect(stepFailure(harness)).toBe(
      'script_failed: resposta do OpenAI cortada pelo teto de saída',
    );
    expect(logs.lines().some((line) => line.includes('"reason":"truncated"'))).toBe(true);
  });

  it('resposta sem conteúdo falha como sempre', async () => {
    const { harness, processor } = directorRig('v2', config, chatResponse({ content: null }));
    await processor.process({ stepId: SCRIPT_STEP_ID });
    expect(stepFailure(harness)).toBe('script_failed: resposta do OpenAI sem conteúdo');
  });

  describe('prazo total de 100 s para tentativas e esperas (R2)', () => {
    const TOTAL_MS = 100_000;
    const rateLimited = (retryAfterS: string) =>
      Object.assign(openAiError(429, 'Rate limit', 'rate_limit_exceeded'), {
        headers: { 'retry-after': retryAfterS },
      });

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    /** A chamada que gasta `elapsedMs` do relógio antes de responder com `reply`. */
    const afterMs = (elapsedMs: number, reply: unknown) => () => {
      jest.advanceTimersByTime(elapsedMs);
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    };

    async function runUntilDone(processor: {
      process: (job: { stepId: string }) => Promise<void>;
    }) {
      const done = processor.process({ stepId: SCRIPT_STEP_ID });
      await jest.advanceTimersByTimeAsync(2 * TOTAL_MS);
      await done;
    }

    it('429 com retry-after de 60 s depois de 50 s: a espera não cabe, não há segunda chamada e a falha é a do provedor', async () => {
      const { harness, processor, create } = directorRig('v2', config);
      create.mockImplementationOnce(afterMs(50_000, rateLimited('60')));
      await runUntilDone(processor);

      expect(create).toHaveBeenCalledTimes(1);
      expect(stepFailure(harness)).toBe('script_failed: OpenAI HTTP 429: Rate limit');
    });

    it('503 depois de 95 s: o que sobra não dá para outra tentativa útil, sem segunda chamada', async () => {
      const { harness, processor, create } = directorRig('v2', config);
      create.mockImplementationOnce(afterMs(95_000, openAiError(503, 'Servidor ocupado')));
      await runUntilDone(processor);

      expect(create).toHaveBeenCalledTimes(1);
      expect(stepFailure(harness)).toBe('script_failed: OpenAI HTTP 503: Servidor ocupado');
    });

    it('429 com retry-after de 20 s depois de 50 s: a segunda chamada leva só o que resta do prazo (30 s) e termina em 100 s', async () => {
      const { harness, processor, create } = directorRig('v2', config);
      const startedAt = Date.now();
      let secondStartedAt = 0;
      create.mockImplementationOnce(afterMs(50_000, rateLimited('20')));
      create.mockImplementationOnce(() => {
        secondStartedAt = Date.now() - startedAt;
        return Promise.resolve(okReply('v2'));
      });
      await runUntilDone(processor);

      expect(create).toHaveBeenCalledTimes(2);
      expect(sentTo(create, 0).options.timeout).toBe(TOTAL_MS);
      const secondTimeout = sentTo(create, 1).options.timeout as number;
      expect(secondTimeout).toBe(30_000);
      expect(secondStartedAt + secondTimeout).toBeLessThanOrEqual(TOTAL_MS);
      expect(harness.saved().scenes).toHaveLength(1);
    });
  });
});
