import { ProductCategorizationService } from '../../ai/product-categorization.service';
import {
  chatResponse,
  fakeConfig,
  installFakeOpenAi,
  openAiError,
  spyOnLogger,
} from '../../ai/utils/openai-chat.testutil';
import { FLYER_PRO_CATEGORIES } from '../domain/flyer-pro-categories';
import { callContext, itemInput } from '../providers/flyer-pro-enrich.testutil';
import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { EnrichCategoryPhase } from './enrich-category-phase';

/** O serviço real com o cliente da OpenAI simulado; sem chave, o serviço fica sem cliente (indisponível), como em produção. */
function build(env: Record<string, string> = {}) {
  const service = new ProductCategorizationService(
    fakeConfig({ OPENAI_API_KEY: 'sk-teste', ...env }),
  );
  const create = env.OPENAI_API_KEY === '' ? jest.fn() : installFakeOpenAi(service);
  spyOnLogger(service);
  return { service, create, phase: new EnrichCategoryPhase(service) };
}

type Answer = { category: string; confidence: number; reason?: string };

/** Responde o lote com a resposta de cada nome (por nome do produto no pedido). */
function answering(byName: Record<string, Answer>) {
  return async (body: { messages: Array<{ content: string }> }) => {
    const sent = JSON.parse(body.messages[1].content) as {
      products: Array<{ id: string; name: string }>;
    };
    const assignments = sent.products.map((product) => ({
      productId: product.id,
      source: 'ai',
      reason: 'teste',
      ...(byName[product.name] ?? { category: 'Mercearia', confidence: 0.9 }),
    }));
    return chatResponse({
      content: JSON.stringify({ assignments }),
      usage: { prompt_tokens: 1000, completion_tokens: 100 },
    });
  };
}

const sabao = itemInput('SABÃO EM PÓ 1KG', {
  id: 'sabao',
  category: 'Mercearia',
  categorySource: 'import',
  imported: { rawCategory: 'MERCEARIA' },
});
const coxa = itemInput('COXA E SOBRECOXA DE FRANGO', { id: 'coxa' });

describe('EnrichCategoryPhase: chamada da categorização no job', () => {
  it('item com a categoria da planilha: vai com currentCategory nulo e a descrição, e a resposta vem da IA', async () => {
    const { phase, create, service } = build();
    create.mockImplementation(
      answering({ 'SABÃO EM PÓ 1KG': { category: 'Limpeza', confidence: 0.88 } }),
    );
    const categorize = jest.spyOn(service, 'categorizeProducts');

    const [verdict] = await phase.run([sabao], callContext());

    expect(categorize.mock.calls[0][0].products).toEqual([
      {
        id: 'sabao',
        name: 'SABÃO EM PÓ 1KG',
        unit: 'cada',
        currentCategory: null,
        description: 'Categoria na planilha: MERCEARIA',
      },
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(create.mock.calls[0][0].messages[1].content);
    expect(sent.products[0]).toMatchObject({
      currentCategory: null,
      description: 'Categoria na planilha: MERCEARIA',
    });
    expect(verdict).toMatchObject({ itemId: 'sabao', action: 'suggest', category: 'Limpeza' });
  });

  it('item incluído à mão: vai sem descrição, com currentCategory nulo', async () => {
    const { phase, create, service } = build();
    create.mockImplementation(
      answering({ 'COXA E SOBRECOXA DE FRANGO': { category: 'Carnes', confidence: 0.9 } }),
    );
    const categorize = jest.spyOn(service, 'categorizeProducts');

    await phase.run([coxa], callContext());

    const [product] = categorize.mock.calls[0][0].products;
    expect(product).not.toHaveProperty('description');
    expect(product.currentCategory).toBeNull();
  });

  it('categoria da planilha em branco ou sem a chave: os dois vão sem descrição', async () => {
    const { phase, create, service } = build();
    create.mockImplementation(answering({}));
    const categorize = jest.spyOn(service, 'categorizeProducts');
    const abacate = itemInput('ABACATE', { id: 'abacate', imported: { rawCategory: '   ' } });
    const salsinha = itemInput('SALSINHA', { id: 'salsinha', imported: {} });

    await phase.run([abacate, salsinha], callContext());

    for (const product of categorize.mock.calls[0][0].products) {
      expect(product).not.toHaveProperty('description');
      expect(product.currentCategory).toBeNull();
    }
  });

  it('a lista traz exatamente as 11 categorias, com preserveExistingCategories ligado', async () => {
    const { phase, create, service } = build();
    create.mockImplementation(answering({}));
    const categorize = jest.spyOn(service, 'categorizeProducts');

    await phase.run([coxa], callContext());

    expect(categorize.mock.calls[0][0].allowedCategories).toEqual([...FLYER_PRO_CATEGORIES]);
    expect(categorize.mock.calls[0][0].preserveExistingCategories).toBe(true);
  });

  it('repassa o coletor de uso e o sinal de cancelamento: o uso da chamada fica no coletor', async () => {
    const { phase, create } = build();
    create.mockImplementation(
      answering({ 'COXA E SOBRECOXA DE FRANGO': { category: 'Carnes', confidence: 0.9 } }),
    );
    const context = callContext();

    await phase.run([coxa], context);

    expect(create.mock.calls[0][1].signal).toBe(context.signal);
    expect(context.usage.snapshot()).toMatchObject({ model: 'gpt-6-luna', calls: 1 });
  });

  it('o sinal abortado cancela a chamada em andamento: o lote falha como transitório', async () => {
    const { phase, create } = build();
    const controller = new AbortController();
    create.mockImplementation(
      (_body: unknown, options: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('Request was aborted.')));
        }),
    );

    const running = phase.run([coxa], callContext('x', { signal: controller.signal }));
    controller.abort();

    await expect(running).rejects.toBeInstanceOf(TransientProviderError);
  });
});

describe('EnrichCategoryPhase: disponibilidade pelo método público do serviço', () => {
  it('sem chave: indisponível, sem chamar a OpenAI', () => {
    const { phase, create } = build({ OPENAI_API_KEY: '' });
    expect(phase.isAvailable()).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('AI_PRODUCT_CATEGORIZATION_ENABLED=false com a chave presente: indisponível', () => {
    expect(build({ AI_PRODUCT_CATEGORIZATION_ENABLED: 'false' }).phase.isAvailable()).toBe(false);
  });

  it('chave e flag: disponível', () => {
    expect(build().phase.isAvailable()).toBe(true);
  });

  it('todas as respostas fallback: nenhum veredito grava, e a fase segue disponível (não é deduzida do fallback)', async () => {
    const { phase, create } = build();
    create.mockImplementation(async (body: { messages: Array<{ content: string }> }) => {
      const sent = JSON.parse(body.messages[1].content) as { products: Array<{ id: string }> };
      const assignments = sent.products.map((p) => ({
        productId: p.id,
        category: 'Categoria inventada',
        confidence: 0.9,
        source: 'ai',
        reason: 'x',
      }));
      return chatResponse({ content: JSON.stringify({ assignments }) });
    });

    const verdicts = await phase.run([coxa, sabao], callContext());

    expect(verdicts.map((v) => v.action)).toEqual(['unanswered', 'unanswered']);
    expect(phase.isAvailable()).toBe(true);
  });
});

describe('EnrichCategoryPhase: falha do serviço', () => {
  it('503: transitória; na repetição, as categorias vêm', async () => {
    const { phase, create } = build();
    create.mockRejectedValueOnce(openAiError(503, 'indisponível'));
    create.mockImplementation(
      answering({ 'COXA E SOBRECOXA DE FRANGO': { category: 'Carnes', confidence: 0.9 } }),
    );

    await expect(phase.run([coxa], callContext())).rejects.toBeInstanceOf(TransientProviderError);
    const [verdict] = await phase.run([coxa], callContext());
    expect(verdict).toMatchObject({ action: 'apply', category: 'Carnes' });
  });

  it('chave inválida (401): terminal, com o código de chave', async () => {
    const { phase, create } = build();
    create.mockRejectedValue(openAiError(401, 'chave inválida'));

    const error = await phase.run([coxa], callContext()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TerminalProviderError);
    expect((error as TerminalProviderError).code).toBe('provider_auth');
  });

  it('conta sem crédito: terminal', async () => {
    const { phase, create } = build();
    create.mockRejectedValue(openAiError(429, 'sem saldo', 'insufficient_quota'));
    await expect(phase.run([coxa], callContext())).rejects.toBeInstanceOf(TerminalProviderError);
  });

  it('resposta fora do formato em todas as novas tentativas do serviço: transitória', async () => {
    const { phase, create } = build();
    create.mockResolvedValue(chatResponse({ content: '{"assignments": "isto não é uma lista"}' }));

    await expect(phase.run([coxa], callContext())).rejects.toBeInstanceOf(TransientProviderError);
    // a primeira chamada mais a nova tentativa do próprio serviço
    expect(create).toHaveBeenCalledTimes(2);
  });
});
