import { DynamicModule, Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AnimationQueueService } from '../queue/animation-queue.service';
import { FlyerEanResolutionService } from '../../modules/ai/ean/dotcompany/flyer-ean-resolution.service';
import { GalleryEmbeddingService } from '../../modules/ai/gallery-embedding.service';
import { ProductImageMatchV2Service } from '../../modules/ai/metadata/product-image-match-v2.service';
import { ProductNameParserService } from '../../modules/ai/metadata/product-name-parser.service';
import { TaxonomyService } from '../../modules/ai/metadata/taxonomy/taxonomy.service';
import { ProductCategorizationService } from '../../modules/ai/product-categorization.service';
import { SpellCheckService } from '../../modules/ai/spell-check.service';

/**
 * Módulos que ocupam o lugar do `SharedModule` e do `AiModule` no app de teste do e2e (`overrideModule`, só testes). Os
 * módulos reais trazem o `forFeature` de entidades que o banco de e2e não monta (as cinco do `SharedModule`, `GalleryImage`
 * e `GalleryFolder`) e serviços com efeito na subida (LISTEN, embedding, runners); o `FlyerProModule`, que os importa,
 * precisa só da fila e dos serviços de IA que o `AiModule` exporta (change 28, R3; change 29).
 */

/**
 * O que o `SharedModule` entrega ao `FlyerProModule`: só a fila. O `AnimationQueueService` é o real; sobe ou não pelas
 * variáveis do app de teste (`createE2eApp` desliga as três flags nos specs que não testam o job).
 */
@Module({ providers: [AnimationQueueService], exports: [AnimationQueueService] })
export class E2eSharedModule {}

/** Os serviços de IA que o `AiModule` exporta e o `FlyerProModule` usa. */
const AI_SERVICES = [
  FlyerEanResolutionService,
  ProductCategorizationService,
  SpellCheckService,
  GalleryEmbeddingService,
];

/** Vazios: o provedor `mock` do job nunca chama IA (chaves zeradas). */
const emptyServices = (): Provider[] =>
  AI_SERVICES.map((token) => ({ provide: token, useValue: {} }));

/**
 * Os serviços de verdade, montados sem o `AiModule` (sem LISTEN, runners nem `forFeature`): as chaves vêm vazias e as
 * flags de IA desligadas do harness, então categorização, ortografia e embedding ficam indisponíveis, e a busca de fotos
 * roda só pelo EAN da Galeria e pelo nome já escolhido, com a busca por EAN na DotCompany desligada. Nenhuma chamada paga.
 */
const realServices = (): Provider[] => [
  {
    provide: ProductCategorizationService,
    useFactory: (config: ConfigService) => new ProductCategorizationService(config),
    inject: [ConfigService],
  },
  {
    provide: SpellCheckService,
    useFactory: (config: ConfigService) => new SpellCheckService(config),
    inject: [ConfigService],
  },
  {
    provide: GalleryEmbeddingService,
    useFactory: (config: ConfigService, dataSource: DataSource) =>
      new GalleryEmbeddingService(config, dataSource),
    inject: [ConfigService, DataSource],
  },
  {
    provide: FlyerEanResolutionService,
    useFactory: (
      config: ConfigService,
      dataSource: DataSource,
      embedding: GalleryEmbeddingService,
    ) => {
      const taxonomy = new TaxonomyService();
      const parser = new ProductNameParserService(config, taxonomy);
      const matcher = new ProductImageMatchV2Service(embedding, parser, taxonomy, config);
      const unused = {} as never;
      return new FlyerEanResolutionService(
        dataSource,
        matcher,
        unused,
        unused,
        unused,
        unused,
        config,
      );
    },
    inject: [ConfigService, DataSource, GalleryEmbeddingService],
  },
];

@Module({})
export class E2eAiModule {
  static forRoot(options: { real: boolean } = { real: false }): DynamicModule {
    const providers = options.real ? realServices() : emptyServices();
    return { module: E2eAiModule, providers, exports: AI_SERVICES };
  }
}
