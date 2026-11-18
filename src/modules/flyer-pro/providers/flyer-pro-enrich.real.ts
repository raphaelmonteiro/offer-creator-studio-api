import type { EnrichStep } from '../domain/flyer-pro-job.types';
import type { FlyerProEnrichPort } from './flyer-pro-enrich.port';

/**
 * O provedor `real` desta change (A-27): ainda não implementa fase nenhuma e declara as três indisponíveis, então o job
 * as pula com `skipped: 'AI_DISABLED'` sem tocar item. Nunca cai no simulado (gravaria fotos e categorias inventadas num
 * encarte de verdade) e nunca chama serviço pago. A change 29 o preenche com os serviços de IA em modo estrito.
 */
export class RealFlyerProEnrich implements FlyerProEnrichPort {
  isAvailable(_phase: EnrichStep): boolean {
    return false;
  }

  modelOf(_phase: EnrichStep): string {
    return 'real';
  }

  categorize(): Promise<never> {
    return this.notImplemented('categorize');
  }

  spellcheck(): Promise<never> {
    return this.notImplemented('spellcheck');
  }

  matchImages(): Promise<never> {
    return this.notImplemented('image_match');
  }

  /** Inalcançável: o job só chama a fase que `isAvailable` aceitou. */
  private notImplemented(phase: EnrichStep): Promise<never> {
    return Promise.reject(new Error(`O provedor real ainda não implementa a fase ${phase}`));
  }
}
