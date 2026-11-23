import type { FlyerEanResolutionService } from '../../ai/ean/dotcompany/flyer-ean-resolution.service';
import type { GalleryEmbeddingService } from '../../ai/gallery-embedding.service';
import type { ProductCategorizationService } from '../../ai/product-categorization.service';
import type { SpellCheckService } from '../../ai/spell-check.service';
import type { FlyerProEnrichConfig } from '../config/flyer-pro-enrich.config';
import { EnrichCategoryPhase } from '../processors/enrich-category-phase';
import { EnrichImagePhase } from '../processors/enrich-image-phase';
import { EnrichSpellPhase } from '../processors/enrich-spell-phase';
import type { FlyerProGalleryPhotos } from '../services/flyer-pro-gallery-photos';
import type { FlyerProImageSizeService } from '../services/flyer-pro-image-size.service';
import { MockFlyerProEnrich } from './flyer-pro-enrich.mock';
import type { FlyerProEnrichPort } from './flyer-pro-enrich.port';
import { RealFlyerProEnrich } from './flyer-pro-enrich.real';

/** O que o módulo injeta para montar o provedor, na ordem do `inject` do `FlyerProModule`. */
export type EnrichServices = [
  gallery: FlyerProGalleryPhotos,
  sizes: FlyerProImageSizeService,
  categorization: Pick<ProductCategorizationService, 'isAvailable' | 'categorizeProducts'>,
  spellcheck: Pick<SpellCheckService, 'isAvailable' | 'spellCheck'>,
  images: Pick<FlyerEanResolutionService, 'findImages'>,
  embedding: Pick<GalleryEmbeddingService, 'isEnabled'>,
];

/**
 * Escolhe o provedor por `FLYER_PRO_ENRICH_PROVIDER` (já resolvido em `real` ou `mock` pela configuração, que avisa no
 * log do valor desconhecido). O `real` monta as três fases sobre os serviços de IA e nunca usa o simulado; nenhum dos dois
 * exige `OPENAI_API_KEY` para subir.
 */
export function createEnrichPort(
  config: Pick<FlyerProEnrichConfig, 'provider'>,
  ...services: EnrichServices
): FlyerProEnrichPort {
  const [gallery, sizes, categorization, spellcheck, images, embedding] = services;
  if (config.provider === 'mock') return new MockFlyerProEnrich(gallery, sizes);
  return new RealFlyerProEnrich({
    category: new EnrichCategoryPhase(categorization),
    spell: new EnrichSpellPhase(spellcheck),
    image: new EnrichImagePhase(images, embedding, sizes),
  });
}
