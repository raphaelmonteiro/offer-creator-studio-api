import { Logger } from '@nestjs/common';

/** Apoio dos testes das cinco features de IA de produto: cliente simulado, sem nenhuma chamada real à OpenAI. */
export interface FakeUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export function chatResponse(
  options: { content?: string | null; finishReason?: string; usage?: FakeUsage | null } = {},
) {
  const { content = '{}', finishReason = 'stop', usage } = options;
  return {
    choices: [{ message: { content }, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

/** Erro como o do SDK da OpenAI (`status` e `code`). */
export function openAiError(status: number, message = 'erro do provedor', code?: string) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

/** Troca o cliente real do serviço por um simulado (o serviço guarda o SDK em `openai`). */
export function installFakeOpenAi(service: object): jest.Mock {
  const create = jest.fn();
  (service as { openai: unknown }).openai = { chat: { completions: { create } } };
  return create;
}

export interface LoggerSpies {
  log: jest.SpyInstance;
  warn: jest.SpyInstance;
  error: jest.SpyInstance;
  /** Texto de cada linha registrada em `log`, `warn` e `error`. */
  lines: () => string[];
}

/** Captura (e silencia) o log do serviço. */
export function spyOnLogger(service: object): LoggerSpies {
  const logger = (service as { logger: Logger }).logger;
  const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  const lines = () =>
    [log, warn, error].flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
  return { log, warn, error, lines };
}
