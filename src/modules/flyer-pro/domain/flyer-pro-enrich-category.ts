import { fold } from '../../../shared/text/fold';
import type {
  CategoryChoice,
  CategoryVerdict,
  EnrichItemInput,
} from '../providers/flyer-pro-enrich.port';
import { FLYER_PRO_CATEGORIES } from './flyer-pro-categories';
import { rawCategoryOf } from './flyer-pro-enrich-input';

/**
 * As regras puras da fase de categorias do provedor real (U2.5): o pedido à categorização, a tradução da resposta dela
 * para o veredito da porta e a regra de "mesma categoria". Sem banco e sem serviço; as tabelas estão no `design.md`.
 */

/** A partir de 0,65 a resposta é certeza (A-3); abaixo, sugestão. */
export const CATEGORY_CONFIDENCE_THRESHOLD = 0.65;

const NO_CATEGORY = fold('Sem categoria');

/** O que o job lê da resposta da categorização para um item (o `ProductCategoryAssignmentDto`, sem importá-lo). */
export interface CategoryAnswer {
  productId: string;
  category: string;
  confidence: number;
  source: 'ai' | 'existing' | 'fallback';
  reason?: string;
}

/** A categoria na grafia da lista fechada (sem acento e sem diferença de maiúsculas), ou `null` se não é uma das 11. */
export function canonicalCategory(name: string): string | null {
  return FLYER_PRO_CATEGORIES.find((category) => fold(category) === fold(name)) ?? null;
}

/** "Categoria na planilha: <rawCategory>" quando o item veio com ela; senão `undefined` (sem descrição, A-20). */
export function categoryDescription(item: Pick<EnrichItemInput, 'imported'>): string | undefined {
  const raw = rawCategoryOf(item.imported);
  return raw ? `Categoria na planilha: ${raw}` : undefined;
}

/** O pedido da categorização para os itens do lote: `currentCategory` sempre nulo, para a IA opinar também sobre a planilha. */
export function categorizationRequest(items: EnrichItemInput[]) {
  return {
    products: items.map((item) => {
      const description = categoryDescription(item);
      return {
        id: item.id,
        name: item.name,
        unit: item.unit,
        currentCategory: null,
        ...(description ? { description } : {}),
      };
    }),
    allowedCategories: [...FLYER_PRO_CATEGORIES],
    preserveExistingCategories: true,
  };
}

const sameCategory = (current: string | null | undefined, answered: string): boolean =>
  !!current && fold(current) === fold(answered);

/**
 * A resposta da categorização para o item como veredito da porta. `fallback`, ausente e categoria fora das 11 não
 * gravam (`unanswered`); "Sem categoria" é "a IA olhou e não tem sugestão" (`none`). A categoria da planilha só vira
 * sugestão quando a IA discorda com certeza; o resto dela é só a marca de conferido.
 */
export function categoryVerdictOf(
  item: Pick<EnrichItemInput, 'id' | 'category' | 'categorySource'>,
  answer: CategoryAnswer | undefined,
): CategoryVerdict {
  const unanswered: CategoryVerdict = { itemId: item.id, action: 'unanswered' };
  if (!answer || answer.source === 'fallback') return unanswered;
  if (fold(answer.category) === NO_CATEGORY) return { itemId: item.id, action: 'none' };
  const category = canonicalCategory(answer.category);
  if (!category) return unanswered;
  const confidence = Number.isFinite(answer.confidence) ? answer.confidence : 0;
  const sure = confidence >= CATEGORY_CONFIDENCE_THRESHOLD;
  const choice = (action: CategoryChoice['action']): CategoryChoice => ({
    itemId: item.id,
    action,
    category,
    confidence,
    why: answer.reason ?? null,
  });
  if (item.categorySource === 'import') {
    const agrees = sameCategory(item.category, category);
    return sure && !agrees ? choice('suggest') : { itemId: item.id, action: 'none' };
  }
  return choice(sure ? 'apply' : 'suggest');
}

/**
 * A categoria respondida é a que o item já tem: nada a trocar, só a marca de conferido (`suggestion: null`). A exceção é
 * o item que o job aplicou antes (`ai`), com certeza e `autoApply`: ele regrava a confirmação, com o carimbo novo.
 */
export function keepsCurrentCategory(
  item: Pick<EnrichItemInput, 'category' | 'categorySource'>,
  choice: Pick<CategoryChoice, 'action' | 'category'>,
  autoApply: boolean,
): boolean {
  if (!sameCategory(item.category, choice.category)) return false;
  return !(item.categorySource === 'ai' && choice.action === 'apply' && autoApply);
}
