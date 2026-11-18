import { ProductCategorizationService } from '../../ai/product-categorization.service';
import { SpellCheckService } from '../../ai/spell-check.service';
import type { AiUsageCollector } from '../../ai/utils/ai-usage';
import {
  chatResponse,
  fakeConfig,
  installFakeOpenAi,
  spyOnLogger,
} from '../../ai/utils/openai-chat.testutil';
import type { ImageSearchAnswer } from '../domain/flyer-pro-enrich-image';
import { createEnrichPort } from '../providers/flyer-pro-enrich.factory';

/**
 * A porta do provedor real dos specs de banco do processador: a categorização e a ortografia são os serviços reais sobre
 * clientes da OpenAI simulados (respondem por nome de item), e a busca de fotos é um `findImages` simulado que devolve a
 * resposta combinada e entrega o uso da leitura do nome ao coletor, como o real faria. Nenhuma chamada paga.
 */

export const NO_ANSWER: ImageSearchAnswer = {
  matches: [],
  reviewCandidates: [],
  pending: [],
  eanStatus: [],
};

/** O uso de cada chamada simulada: 1000 tokens de entrada e 200 de saída valem US$ 0,0002 no modelo padrão. */
export const CALL_USAGE = { prompt_tokens: 1000, completion_tokens: 200 };
export const CALL_COST = 0.0002;

export interface RealPortOptions {
  env?: Record<string, string>;
  /** A categoria e a confiança que a IA devolve para o nome do item; o que não está aqui responde "Mercearia" com 0,9. */
  categories?: Record<string, { category: string; confidence: number }>;
  /** A correção de ortografia por nome do item. */
  fixes?: Record<string, string>;
  /** A resposta da busca de fotos para os itens do lote. */
  images?: (products: Array<{ id: string; name: string }>) => ImageSearchAnswer;
  /** A busca por nome está disponível (embedding ligado). */
  nameSearch?: boolean;
  /** Troca a resposta da ortografia: recebe o número da chamada (1, 2, ...) e pode lançar. */
  spellCall?: (call: number) => Promise<void> | void;
}

export function realPort(options: RealPortOptions = {}) {
  const keyless = options.env?.OPENAI_API_KEY === '';
  const config = fakeConfig({ OPENAI_API_KEY: 'sk-teste', ...options.env });
  const categorization = new ProductCategorizationService(config);
  const spell = new SpellCheckService(config);
  const categorizeCreate = keyless ? jest.fn() : installFakeOpenAi(categorization);
  const spellCreate = keyless ? jest.fn() : installFakeOpenAi(spell);
  spyOnLogger(categorization);
  spyOnLogger(spell);

  categorizeCreate.mockImplementation(async (body: { messages: Array<{ content: string }> }) => {
    const sent = JSON.parse(body.messages[1].content) as {
      products: Array<{ id: string; name: string }>;
    };
    const assignments = sent.products.map((product) => ({
      productId: product.id,
      source: 'ai',
      reason: 'teste',
      ...(options.categories?.[product.name] ?? { category: 'Mercearia', confidence: 0.9 }),
    }));
    return chatResponse({ content: JSON.stringify({ assignments }), usage: CALL_USAGE });
  });

  let spellCalls = 0;
  spellCreate.mockImplementation(async (body: { messages: Array<{ content: string }> }) => {
    spellCalls += 1;
    await options.spellCall?.(spellCalls);
    const sent = JSON.parse(body.messages[1].content.replace(/^[^[]*/, '')) as Array<{
      productId: string;
      text: string;
    }>;
    const corrections = sent
      .filter((entry) => options.fixes?.[entry.text])
      .map((entry) => ({
        productId: entry.productId,
        field: 'name',
        original: entry.text,
        suggestion: options.fixes?.[entry.text],
      }));
    return chatResponse({ content: JSON.stringify({ corrections }), usage: CALL_USAGE });
  });

  const findImages = jest.fn(
    async (
      products: Array<{ id: string; name: string }>,
      _clientId: string | null,
      call: { usage?: AiUsageCollector },
    ) => {
      call.usage?.declareModel('gpt-6-luna');
      call.usage?.record('gpt-6-luna', CALL_USAGE);
      return options.images ? options.images(products) : NO_ANSWER;
    },
  );
  const port = createEnrichPort(
    { provider: 'real' },
    { first: jest.fn() } as never,
    { measure: jest.fn(async () => ({ width: 600, height: 1200 })) } as never,
    categorization,
    spell,
    { findImages } as never,
    { isEnabled: () => options.nameSearch ?? true },
  );
  return { port, categorization, spell, categorizeCreate, spellCreate, findImages };
}
