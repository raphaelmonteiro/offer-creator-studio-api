import { ConfigService } from '@nestjs/config';
import { SpellCheckService } from './spell-check.service';
import { chatResponse, installFakeOpenAi, spyOnLogger } from './utils/openai-chat.testutil';

/** Apoio dos testes da ortografia: serviço real com o cliente da OpenAI simulado. */
export function build(env: Record<string, string> = {}) {
  const service = new SpellCheckService(new ConfigService({ OPENAI_API_KEY: 'sk-teste', ...env }));
  const create = installFakeOpenAi(service);
  const logs = spyOnLogger(service);
  return { service, create, logs };
}

export function products(count: number, prefix = 'p') {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, name: `Produto ${i}` }));
}

export const CORRECTION = {
  corrections: [{ productId: 'p-0', field: 'name', original: 'Produto 0', suggestion: 'Produto' }],
};

export function answer(body: unknown = { corrections: [] }) {
  return chatResponse({ content: JSON.stringify(body) });
}
