import { Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { ChatCallSpec } from '../config/openai-chat-params';

export const SPEC: ChatCallSpec = {
  model: 'gpt-6-luna',
  effort: 'low',
  temperature: 0,
  timeoutMs: 30_000,
  legacyMaxTokens: 2048,
  maxCompletionTokens: 8192,
};

export function setup() {
  const create = jest.fn();
  const openai = { chat: { completions: { create } } } as unknown as OpenAI;
  const logger = new Logger('teste');
  const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  return { create, openai, logger, log, warn, error };
}

/** Objeto JSON da linha de log que começa com `prefix`. */
export function logged(spy: jest.SpyInstance, prefix: string): Record<string, unknown> {
  const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith(prefix));
  if (!line) throw new Error(`linha "${prefix}" não encontrada`);
  return JSON.parse(line.slice(prefix.length));
}

export const MESSAGES = [{ role: 'user' as const, content: 'oi' }];
