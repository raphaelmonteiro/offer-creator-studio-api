import { ConfigService } from '@nestjs/config';
import { SpellCheckService } from './spell-check.service';
import { AI_RESPONSE_FORMATS } from './schemas/ai-response.schemas';
import { SPELLCHECK_SYSTEM_PROMPT } from './prompts/spellcheck.prompts';
import {
  chatResponse,
  installFakeOpenAi,
  openAiError,
  spyOnLogger,
} from './utils/openai-chat.testutil';

function build(env: Record<string, string> = {}) {
  const service = new SpellCheckService(new ConfigService({ OPENAI_API_KEY: 'sk-teste', ...env }));
  const create = installFakeOpenAi(service);
  const logs = spyOnLogger(service);
  return { service, create, logs };
}

function products(count: number, prefix = 'p') {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, name: `Produto ${i}` }));
}

const CORRECTION = {
  corrections: [{ productId: 'p-0', field: 'name', original: 'Produto 0', suggestion: 'Produto' }],
};

function answer(body: unknown = { corrections: [] }) {
  return chatResponse({ content: JSON.stringify(body) });
}

describe('SpellCheckService', () => {
  describe('parâmetros da chamada', () => {
    it('padrão novo: gpt-6-luna, max_completion_tokens, reasoning_effort low, sem temperature nem max_tokens', async () => {
      const { service, create } = build();
      create.mockResolvedValue(answer(CORRECTION));

      const result = await service.spellCheck(products(3));

      expect(result).toEqual({ corrections: CORRECTION.corrections });
      expect(create).toHaveBeenCalledTimes(1);
      const [body, options] = create.mock.calls[0];
      expect(body).toStrictEqual({
        model: 'gpt-6-luna',
        max_completion_tokens: 8192,
        reasoning_effort: 'low',
        response_format: AI_RESPONSE_FORMATS.spellCheck,
        messages: [
          { role: 'system', content: SPELLCHECK_SYSTEM_PROMPT },
          { role: 'user', content: expect.stringContaining('"productId": "p-0"') },
        ],
      });
      expect(options).toStrictEqual({ maxRetries: 0, timeout: 30_000 });
    });

    it('com OPENAI_SPELLCHECK_MODEL=gpt-4o o corpo é o de hoje', async () => {
      const { service, create } = build({ OPENAI_SPELLCHECK_MODEL: 'gpt-4o' });
      create.mockResolvedValue(answer());

      await service.spellCheck(products(2));

      const [body, options] = create.mock.calls[0];
      expect(body).toStrictEqual({
        model: 'gpt-4o',
        max_tokens: 2048,
        temperature: 0,
        response_format: AI_RESPONSE_FORMATS.spellCheck,
        messages: [
          { role: 'system', content: SPELLCHECK_SYSTEM_PROMPT },
          { role: 'user', content: expect.any(String) },
        ],
      });
      expect(options).toStrictEqual({ maxRetries: 0, timeout: 30_000 });
    });

    it('OPENAI_TEXT_MODEL e OPENAI_TIMEOUT_MS não mudam a chamada', async () => {
      const { service, create } = build({
        OPENAI_TEXT_MODEL: 'gpt-4o',
        OPENAI_TIMEOUT_MS: '180000',
      });
      create.mockResolvedValue(answer());

      await service.spellCheck(products(1));

      expect(create.mock.calls[0][0].model).toBe('gpt-6-luna');
      expect(create.mock.calls[0][1].timeout).toBe(30_000);
    });

    it('prazo ajustado pela variável', async () => {
      const { service, create } = build({ OPENAI_SPELLCHECK_TIMEOUT_MS: '12000' });
      create.mockResolvedValue(answer());
      await service.spellCheck(products(1));
      expect(create.mock.calls[0][1].timeout).toBe(12_000);
    });
  });

  describe('teto de chamadas em paralelo', () => {
    function trackPeak(create: jest.Mock) {
      const state = { running: 0, peak: 0, calls: 0 };
      create.mockImplementation(async () => {
        state.calls += 1;
        state.running += 1;
        state.peak = Math.max(state.peak, state.running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        state.running -= 1;
        return answer();
      });
      return state;
    }

    it('78 produtos só com nome: 8 lotes e nunca mais de 4 em andamento', async () => {
      const { service, create } = build();
      const state = trackPeak(create);

      await service.spellCheck(products(78));

      expect(state.calls).toBe(8);
      expect(state.peak).toBe(4);
    });

    it('as correções dos 8 lotes voltam, na ordem dos lotes', async () => {
      const { service, create } = build();
      create.mockImplementation(async (body: { messages: Array<{ content: string }> }) => {
        const first = /"productId": "p-(\d+)"/.exec(body.messages[1].content)![1];
        return answer({
          corrections: [{ productId: `p-${first}`, field: 'name', original: 'a', suggestion: 'b' }],
        });
      });

      const result = await service.spellCheck(products(78));

      expect(result.corrections.map((c) => c.productId)).toEqual([
        'p-0',
        'p-10',
        'p-20',
        'p-30',
        'p-40',
        'p-50',
        'p-60',
        'p-70',
      ]);
    });

    it('revisão pequena: uma só chamada', async () => {
      const { service, create } = build();
      const state = trackPeak(create);
      await service.spellCheck(products(3));
      expect(state.calls).toBe(1);
      expect(state.peak).toBe(1);
    });

    it('AI_SPELLCHECK_CONCURRENCY=8: os 8 lotes ao mesmo tempo, nunca mais de 8', async () => {
      const { service, create } = build({ AI_SPELLCHECK_CONCURRENCY: '8' });
      const state = trackPeak(create);
      await service.spellCheck(products(78));
      expect(state.calls).toBe(8);
      expect(state.peak).toBe(8);
    });

    it.each(['0', 'abc', '-3', ''])('valor inválido (%p) no teto vale 4', async (invalid) => {
      const { service, create } = build({ AI_SPELLCHECK_CONCURRENCY: invalid });
      const state = trackPeak(create);
      await service.spellCheck(products(78));
      expect(state.peak).toBe(4);
    });

    it('duas revisões ao mesmo tempo: cada uma mantém no máximo 4 em andamento', async () => {
      const { service, create } = build();
      const running: Record<string, number> = { A: 0, B: 0 };
      const peak: Record<string, number> = { A: 0, B: 0 };
      create.mockImplementation(async (body: { messages: Array<{ content: string }> }) => {
        const review = body.messages[1].content.includes('"productId": "A-') ? 'A' : 'B';
        running[review] += 1;
        peak[review] = Math.max(peak[review], running[review]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running[review] -= 1;
        return answer();
      });

      await Promise.all([
        service.spellCheck(products(78, 'A')),
        service.spellCheck(products(78, 'B')),
      ]);

      expect(peak).toEqual({ A: 4, B: 4 });
      expect(create).toHaveBeenCalledTimes(16);
    });

    it('um lote que falha: a revisão rejeita e os lotes que faltavam não são enviados', async () => {
      const { service, create } = build();
      let call = 0;
      create.mockImplementation(async () => {
        call += 1;
        if (call === 6) throw openAiError(500, 'falha do lote 6');
        await new Promise((resolve) => setTimeout(resolve, 5));
        return answer();
      });

      await expect(service.spellCheck(products(78))).rejects.toThrow('falha do lote 6');
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(create.mock.calls.length).toBeLessThanOrEqual(8);
    });
  });

  describe('liga e desliga', () => {
    it('flag ausente: a revisão é feita', async () => {
      const { service, create } = build();
      create.mockResolvedValue(answer());
      await expect(service.spellCheck(products(1))).resolves.toEqual({ corrections: [] });
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('AI_SPELLCHECK_ENABLED=true: a revisão é feita', async () => {
      const { service, create } = build({ AI_SPELLCHECK_ENABLED: 'true' });
      create.mockResolvedValue(answer());
      await service.spellCheck(products(1));
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('AI_SPELLCHECK_ENABLED=false: rejeita e não chama a OpenAI, também no pedido repetido', async () => {
      const { service, create } = build({ AI_SPELLCHECK_ENABLED: 'false' });

      const first = await service.spellCheck(products(3)).catch((e: Error) => e.message);
      const second = await service.spellCheck(products(3)).catch((e: Error) => e.message);

      expect(first).toMatch(/AI_SPELLCHECK_ENABLED=false/);
      expect(second).toBe(first);
      expect(create).not.toHaveBeenCalled();
    });

    it('sem a chave da OpenAI: rejeita sem chamar', async () => {
      const service = new SpellCheckService(new ConfigService({}));
      spyOnLogger(service);
      await expect(service.spellCheck(products(1))).rejects.toThrow('OPENAI_API_KEY');
    });
  });

  describe('falhas', () => {
    it('429 de limite de taxa: uma só chamada para o lote, a revisão rejeita e o log traz AI operation failed', async () => {
      const { service, create, logs } = build();
      create.mockRejectedValue(openAiError(429, 'Rate limit reached', 'rate_limit_exceeded'));

      await expect(service.spellCheck(products(3))).rejects.toThrow('Rate limit reached');

      expect(create).toHaveBeenCalledTimes(1);
      const failed = logs.error.mock.calls.map((c) => String(c[0]));
      expect(failed).toHaveLength(1);
      expect(failed[0]).toContain('AI operation failed');
      expect(failed[0]).toContain('"feature":"spell-check.batch"');
      expect(failed[0]).toContain('"model":"gpt-6-luna"');
    });

    it('resposta fora do schema: segunda chamada com o pedido de correção, cada uma com o seu prazo', async () => {
      const { service, create } = build();
      create
        .mockResolvedValueOnce(chatResponse({ content: '{"corrections": "nao-e-lista"}' }))
        .mockResolvedValueOnce(answer(CORRECTION));

      const result = await service.spellCheck(products(1));

      expect(result.corrections).toHaveLength(1);
      expect(create).toHaveBeenCalledTimes(2);
      expect(create.mock.calls[0][1]).toStrictEqual({ maxRetries: 0, timeout: 30_000 });
      expect(create.mock.calls[1][1]).toStrictEqual({ maxRetries: 0, timeout: 30_000 });
      const retryMessages = create.mock.calls[1][0].messages;
      expect(retryMessages).toHaveLength(3);
      expect(retryMessages[2].content).toContain('previous response was invalid');
    });

    it('OPENAI_STRUCTURED_RESPONSE_RETRY_ATTEMPTS=0: sem segunda chamada', async () => {
      const { service, create } = build({ OPENAI_STRUCTURED_RESPONSE_RETRY_ATTEMPTS: '0' });
      create.mockResolvedValue(chatResponse({ content: 'não é json' }));
      await expect(service.spellCheck(products(1))).rejects.toThrow();
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('resposta vazia: aviso no log com a feature, o modelo e o motivo', async () => {
      const { service, create, logs } = build({ OPENAI_STRUCTURED_RESPONSE_RETRY_ATTEMPTS: '0' });
      create.mockResolvedValue(chatResponse({ content: '', finishReason: 'length' }));

      await expect(service.spellCheck(products(1))).rejects.toThrow('Resposta vazia da IA');

      const warning = logs.warn.mock.calls.map((c) => String(c[0])).find((l) => /invalid/.test(l));
      expect(warning).toContain('"feature":"spell-check.batch"');
      expect(warning).toContain('"model":"gpt-6-luna"');
      expect(warning).toContain('"reason":"truncated"');
    });

    it('resposta válida não gera aviso nem linha de falha', async () => {
      const { service, create, logs } = build();
      create.mockResolvedValue(answer(CORRECTION));
      await service.spellCheck(products(2));
      expect(logs.warn).not.toHaveBeenCalled();
      expect(logs.error).not.toHaveBeenCalled();
    });
  });
});
