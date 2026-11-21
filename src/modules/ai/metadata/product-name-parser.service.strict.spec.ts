import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { AiUsageCollector } from '../utils/ai-usage';
import { chatResponse, openAiError } from '../utils/openai-chat.testutil';
import { answerEach, build, NAMES } from './product-name-parser.testutil';

describe('ProductNameParserService, modo estrito (change 28)', () => {
  it.each([
    ['429 de limite de taxa', openAiError(429, 'rate limit', 'rate_limit_exceeded')],
    ['500', openAiError(500)],
    ['503', openAiError(503)],
    ['falha de conexão', new APIConnectionError({ message: 'socket hang up' })],
    ['prazo estourado', new APIConnectionTimeoutError()],
  ])('%s lança TransientProviderError', async (_, error) => {
    const { service, create } = build();
    create.mockRejectedValue(error);

    await expect(service.parseNames(NAMES(2), { strict: true })).rejects.toBeInstanceOf(
      TransientProviderError,
    );
  });

  it('conta sem crédito: uma única chamada e TerminalProviderError', async () => {
    const { service, create } = build();
    create.mockRejectedValue(openAiError(429, 'sem saldo', 'insufficient_quota'));

    await expect(service.parseNames(NAMES(2), { strict: true })).rejects.toBeInstanceOf(
      TerminalProviderError,
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403])('%s lança TerminalProviderError', async (status) => {
    const { service, create } = build();
    create.mockRejectedValue(openAiError(status));

    await expect(service.parseNames(NAMES(1), { strict: true })).rejects.toBeInstanceOf(
      TerminalProviderError,
    );
  });

  it('segundo lote de 8 falha: lança, e o primeiro lote fica no cache para a próxima chamada', async () => {
    const { service, create } = build();
    create
      .mockResolvedValueOnce(answerEach(8))
      .mockRejectedValueOnce(openAiError(503))
      .mockResolvedValueOnce(answerEach(8));

    await expect(service.parseNames(NAMES(16), { strict: true })).rejects.toBeInstanceOf(
      TransientProviderError,
    );
    const again = await service.parseNames(NAMES(16), { strict: true });

    expect(create).toHaveBeenCalledTimes(3);
    expect(again.every((metadata) => metadata !== null)).toBe(true);
  });

  it('JSON inválido com a opção: não lança e devolve nulos', async () => {
    const { service, create } = build();
    create.mockResolvedValue(chatResponse({ content: 'isto não é JSON' }));

    expect(await service.parseNames(NAMES(1), { strict: true })).toEqual([null]);
  });

  it('leitor desligado com a opção: não lança e não chama a OpenAI', async () => {
    const { service, create } = build({ AI_NAME_PARSER_ENABLED: 'false' });

    expect(await service.parseNames(NAMES(2), { strict: true })).toEqual([null, null]);
    expect(create).not.toHaveBeenCalled();
  });

  it('sem a opção, a mesma falha devolve os nulos de hoje, sem exceção', async () => {
    const { service, create } = build();
    create.mockRejectedValue(openAiError(503));

    expect(await service.parseNames(NAMES(2))).toEqual([null, null]);
  });

  it('só o pedido de uso (importador da DotCompany): nulos de hoje e o uso soma só as chamadas concluídas', async () => {
    const { service, create } = build();
    create.mockRejectedValue(openAiError(503));
    const usage = new AiUsageCollector();

    expect(await service.parseNames(NAMES(2), { usage })).toEqual([null, null]);
    expect(usage.snapshot()).toMatchObject({ calls: 0 });
  });

  describe('log da falha nos dois modos', () => {
    it.each([
      ['com a opção', { strict: true }],
      ['sem a opção', {}],
    ])('%s: a linha de falha da chamada sai e nenhuma traz a chave', async (_, options) => {
      const { service, create, logs } = build();
      create.mockRejectedValue(openAiError(400));

      await service.parseNames(NAMES(1), options).catch(() => undefined);

      const lines = logs.lines();
      expect(lines.some((line) => line.includes('AI operation failed'))).toBe(true);
      expect(lines.some((line) => line.includes('product-name-parser.batch'))).toBe(true);
      expect(lines.some((line) => line.includes('sk-teste'))).toBe(false);
    });
  });
});
