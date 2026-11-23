import type { ProductCategorizationService } from '../../ai/product-categorization.service';
import { categorizationRequest, categoryVerdictOf } from '../domain/flyer-pro-enrich-category';
import type {
  CategoryVerdict,
  EnrichCallContext,
  EnrichItemInput,
} from '../providers/flyer-pro-enrich.port';
import { strictCall } from '../providers/flyer-pro-enrich.strict';

/** O que a fase usa do serviço de categorização (`ProductCategorizationService`). */
export type CategorizationApi = Pick<
  ProductCategorizationService,
  'isAvailable' | 'categorizeProducts'
>;

/**
 * A fase de categorias do provedor real (U2.5): chama a categorização que o `/editor-v2` já usa, como serviço, sem a rota
 * `/ai/*`. Disponível pelo método público do serviço (flag e chave), nunca deduzido do `fallback`. A falha sobe
 * classificada; a resposta vira veredito da porta pelas regras de `domain/flyer-pro-enrich-category.ts`.
 */
export class EnrichCategoryPhase {
  constructor(private readonly service: CategorizationApi) {}

  isAvailable(): boolean {
    return this.service.isAvailable();
  }

  async run(items: EnrichItemInput[], context: EnrichCallContext): Promise<CategoryVerdict[]> {
    const { assignments } = await strictCall(() =>
      this.service.categorizeProducts(categorizationRequest(items), {
        usage: context.usage,
        signal: context.signal,
      }),
    );
    const byItem = new Map(assignments.map((assignment) => [assignment.productId, assignment]));
    return items.map((item) => categoryVerdictOf(item, byItem.get(item.id)));
  }
}
