import { DynamicModule, Module } from '@nestjs/common';
import { AnimationQueueService } from '../queue/animation-queue.service';
import { FlyerEanResolutionService } from '../../modules/ai/ean/dotcompany/flyer-ean-resolution.service';
import { ProductCategorizationService } from '../../modules/ai/product-categorization.service';
import { SpellCheckService } from '../../modules/ai/spell-check.service';

/**
 * Módulos que ocupam o lugar do `SharedModule` e do `AiModule` no app de teste do e2e (`overrideModule`, só testes). Os
 * módulos reais trazem o `forFeature` de entidades que o banco de e2e não monta (as cinco do `SharedModule`, `GalleryImage`
 * e `GalleryFolder`) e serviços com efeito na subida (LISTEN, embedding, runners); o `FlyerProModule`, que os importa,
 * precisa só da fila e dos três serviços de IA que o `AiModule` exporta (change 28, R3).
 */

/**
 * O que o `SharedModule` entrega ao `FlyerProModule`: só a fila. O `AnimationQueueService` é o real; sobe ou não pelas
 * variáveis do app de teste (`createE2eApp` desliga as três flags nos specs que não testam o job).
 */
@Module({ providers: [AnimationQueueService], exports: [AnimationQueueService] })
export class E2eSharedModule {}

/** Os três serviços de IA do `AiModule`, vazios: nenhum e2e chama IA (chaves zeradas, provedor `mock`). */
const AI_SERVICES = [FlyerEanResolutionService, ProductCategorizationService, SpellCheckService];

@Module({})
export class E2eAiModule {
  static forRoot(): DynamicModule {
    const providers = AI_SERVICES.map((token) => ({ provide: token, useValue: {} }));
    return { module: E2eAiModule, providers, exports: AI_SERVICES };
  }
}
