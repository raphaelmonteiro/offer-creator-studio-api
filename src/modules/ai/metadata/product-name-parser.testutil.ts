import { ProductNameParserService } from './product-name-parser.service';
import { TaxonomyService } from './taxonomy/taxonomy.service';
import {
  chatResponse,
  fakeConfig,
  installFakeOpenAi,
  spyOnLogger,
} from '../utils/openai-chat.testutil';

export function build(env: Record<string, string> = {}) {
  const taxonomy = { promptList: () => '101|Mercearia > Arroz' } as unknown as TaxonomyService;
  const service = new ProductNameParserService(
    fakeConfig({ OPENAI_API_KEY: 'sk-teste', ...env }),
    taxonomy,
  );
  const create = installFakeOpenAi(service);
  const logs = spyOnLogger(service);
  return { service, create, logs };
}

/** Resposta que devolve uma ficha mínima válida para cada nome do pedido. */
export function answerEach(count: number) {
  return chatResponse({
    content: JSON.stringify({
      results: Array.from({ length: count }, (_, i) => ({
        title: `PRODUTO ${i}`,
        fieldConfidence: { title: 0.9 },
      })),
    }),
  });
}

export const NAMES = (count: number, prefix = 'ARROZ') =>
  Array.from({ length: count }, (_, i) => ({ name: `${prefix} ${i}` }));
