import type { EnrichStep } from '../domain/flyer-pro-job.types';
import type { EnrichCategoryPhase } from '../processors/enrich-category-phase';
import type { EnrichImagePhase } from '../processors/enrich-image-phase';
import type { EnrichSpellPhase } from '../processors/enrich-spell-phase';
import type {
  CategoryVerdict,
  EnrichCallContext,
  EnrichItemInput,
  FlyerProEnrichPort,
  ImageVerdict,
  SpellVerdict,
} from './flyer-pro-enrich.port';

/** As três fases do provedor real, cada uma sobre o serviço de IA que o `/editor-v2` e o `/social` já usam. */
export interface RealEnrichPhases {
  category: EnrichCategoryPhase;
  spell: EnrichSpellPhase;
  image: EnrichImagePhase;
}

/**
 * O provedor `real` do job (U2.5 e U2.6): chama a categorização, a ortografia e a busca de fotos como serviços no worker,
 * sem as rotas `/ai/*`. Nenhuma fase cai no simulado: os marcadores do nome do encarte não têm efeito aqui. Categorias e
 * ortografia só rodam com o serviço disponível (flag e chave); a fase de fotos nunca é pulada, porque o EAN da Galeria e o
 * nome já escolhido não dependem da IA.
 */
export class RealFlyerProEnrich implements FlyerProEnrichPort {
  constructor(private readonly phases: RealEnrichPhases) {}

  isAvailable(phase: EnrichStep): boolean {
    if (phase === 'categorize') return this.phases.category.isAvailable();
    if (phase === 'spellcheck') return this.phases.spell.isAvailable();
    return true;
  }

  categorize(items: EnrichItemInput[], context: EnrichCallContext): Promise<CategoryVerdict[]> {
    return this.phases.category.run(items, context);
  }

  spellcheck(items: EnrichItemInput[], context: EnrichCallContext): Promise<SpellVerdict[]> {
    return this.phases.spell.run(items, context);
  }

  matchImages(items: EnrichItemInput[], context: EnrichCallContext): Promise<ImageVerdict[]> {
    return this.phases.image.run(items, context);
  }
}
