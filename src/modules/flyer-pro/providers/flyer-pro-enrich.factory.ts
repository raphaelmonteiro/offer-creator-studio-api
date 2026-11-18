import type { FlyerProEnrichConfig } from '../config/flyer-pro-enrich.config';
import { FlyerProGalleryPhotos } from '../services/flyer-pro-gallery-photos';
import { FlyerProImageSizeService } from '../services/flyer-pro-image-size.service';
import { MockFlyerProEnrich } from './flyer-pro-enrich.mock';
import type { FlyerProEnrichPort } from './flyer-pro-enrich.port';
import { RealFlyerProEnrich } from './flyer-pro-enrich.real';

/**
 * Escolhe o provedor por `FLYER_PRO_ENRICH_PROVIDER` (já resolvido em `real` ou `mock` pela configuração, que avisa no
 * log do valor desconhecido). Nenhum dos dois exige `OPENAI_API_KEY` para subir.
 */
export function createEnrichPort(
  config: Pick<FlyerProEnrichConfig, 'provider'>,
  gallery: FlyerProGalleryPhotos,
  sizes: FlyerProImageSizeService,
): FlyerProEnrichPort {
  return config.provider === 'mock'
    ? new MockFlyerProEnrich(gallery, sizes)
    : new RealFlyerProEnrich();
}
