import { ConfigService } from '@nestjs/config';
import { SpellCheckService } from './spell-check.service';
import { AI_RESPONSE_FORMATS } from './schemas/ai-response.schemas';
import { SPELLCHECK_SYSTEM_PROMPT } from './prompts/spellcheck.prompts';
import { chatResponse, openAiError, spyOnLogger } from './utils/openai-chat.testutil';
import { answer, build, CORRECTION, products } from './spell-check.service.testutil';

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
