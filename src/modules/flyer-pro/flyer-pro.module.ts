import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnimationQueueService, QUEUES } from '../../shared/queue/animation-queue.service';
import { SharedModule } from '../../shared/shared.module';
import { AiModule } from '../ai/ai.module';
import { FlyerProDocumentsController } from './controllers/flyer-pro-documents.controller';
import { FlyerProEnrichmentController } from './controllers/flyer-pro-enrichment.controller';
import { FlyerProStructureSuggestionController } from './controllers/flyer-pro-structure-suggestion.controller';
import { FlyerProTemplatesController } from './controllers/flyer-pro-templates.controller';
import {
  FLYER_PRO_ENRICH_CONFIG,
  FlyerProEnrichConfig,
  readEnrichConfig,
} from './config/flyer-pro-enrich.config';
import { readStructureAiConfig, STRUCTURE_AI_CONFIG } from './config/structure-ai.config';
import { FlyerProDocument } from './entities/flyer-pro-document.entity';
import { FlyerProImport } from './entities/flyer-pro-import.entity';
import { FlyerProItem } from './entities/flyer-pro-item.entity';
import { FlyerProJob } from './entities/flyer-pro-job.entity';
import { FlyerProEnrichCommitter } from './processors/flyer-pro-enrich.committer';
import { FlyerProEnrichProcessor } from './processors/flyer-pro-enrich.processor';
import type { BatchMessage } from './processors/flyer-pro-enrich.types';
import { createEnrichPort } from './providers/flyer-pro-enrich.factory';
import { FLYER_PRO_ENRICH_PORT } from './providers/flyer-pro-enrich.port';
import { createStructureAiPort } from './providers/flyer-pro-structure-ai.factory';
import { FLYER_PRO_STRUCTURE_AI_PORT } from './providers/flyer-pro-structure-ai.port';
import { FlyerProClientGuardService } from './services/flyer-pro-client-guard.service';
import { FlyerProCursorService } from './services/flyer-pro-cursor.service';
import { FlyerProDocumentsService } from './services/flyer-pro-documents.service';
import { FlyerProGalleryPhotos } from './services/flyer-pro-gallery-photos';
import { FlyerProImageSizeService } from './services/flyer-pro-image-size.service';
import { FlyerProJobReconcilerService } from './services/flyer-pro-job-reconciler.service';
import { FlyerProJobsService } from './services/flyer-pro-jobs.service';
import { FlyerProSaveService } from './services/flyer-pro-save.service';
import { FlyerProImportsService } from './services/flyer-pro-imports.service';
import { FlyerProItemsService } from './services/flyer-pro-items.service';
import { FlyerProSetupService } from './services/flyer-pro-setup.service';
import { FlyerProStructureLimiter } from './services/flyer-pro-structure-limiter';
import { FlyerProStructureSuggestionService } from './services/flyer-pro-structure-suggestion.service';
import { FlyerProSceneReader } from './services/flyer-pro-scene.reader';
import { FlyerProTemplateSnapshotService } from './services/flyer-pro-template-snapshot.service';
import { FlyerProTemplatesService } from './services/flyer-pro-templates.service';

/**
 * Módulo do Encarte Pro (backend): a leitura dos templates das cenas do Templates v2 (N7), o montador da cópia congelada
 * do template, o encarte guardado no servidor (criar, listar, abrir e excluir: N1, N2, N3 e N6) e o serviço de guarda que
 * o módulo de clientes chama ao excluir um cliente, e a sugestão de estrutura por IA (N19, só leitura). Lê as tabelas das cenas sem passar pela flag `TEMPLATE_SCENE_ENABLED`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([FlyerProDocument, FlyerProItem, FlyerProImport, FlyerProJob]),
    // A fila (`AnimationQueueService`) do job e, para as fases reais da change 29, os três serviços de IA que o `AiModule` exporta.
    SharedModule,
    AiModule,
  ],
  controllers: [
    FlyerProTemplatesController,
    FlyerProDocumentsController,
    FlyerProStructureSuggestionController,
    FlyerProEnrichmentController,
  ],
  providers: [
    FlyerProSceneReader,
    FlyerProTemplatesService,
    FlyerProTemplateSnapshotService,
    FlyerProDocumentsService,
    FlyerProSaveService,
    FlyerProSetupService,
    FlyerProCursorService,
    FlyerProItemsService,
    FlyerProClientGuardService,
    FlyerProImportsService,
    FlyerProStructureSuggestionService,
    FlyerProJobsService,
    FlyerProEnrichCommitter,
    FlyerProEnrichProcessor,
    FlyerProJobReconcilerService,
    FlyerProGalleryPhotos,
    FlyerProImageSizeService,
    // Um limitador só por processo da API: a vaga em andamento e o teto por hora vivem na memória dele.
    { provide: FlyerProStructureLimiter, useFactory: () => new FlyerProStructureLimiter() },
    {
      provide: FLYER_PRO_ENRICH_CONFIG,
      useFactory: (config: ConfigService) => readEnrichConfig(config),
      inject: [ConfigService],
    },
    {
      provide: FLYER_PRO_ENRICH_PORT,
      useFactory: createEnrichPort,
      inject: [FLYER_PRO_ENRICH_CONFIG, FlyerProGalleryPhotos, FlyerProImageSizeService],
    },
    {
      provide: STRUCTURE_AI_CONFIG,
      useFactory: (config: ConfigService) => readStructureAiConfig(config),
      inject: [ConfigService],
    },
    {
      provide: FLYER_PRO_STRUCTURE_AI_PORT,
      useFactory: createStructureAiPort,
      inject: [STRUCTURE_AI_CONFIG, ConfigService],
    },
  ],
  exports: [FlyerProTemplateSnapshotService, FlyerProClientGuardService],
})
export class FlyerProModule implements OnModuleInit {
  constructor(
    private readonly queue: AnimationQueueService,
    private readonly processor: FlyerProEnrichProcessor,
    private readonly reconciler: FlyerProJobReconcilerService,
    @Inject(FLYER_PRO_ENRICH_CONFIG) private readonly enrich: FlyerProEnrichConfig,
  ) {}

  /**
   * O consumidor dos lotes do job e o reconciliador só no worker (`WORKER_ONLY=true`) e com a flag do job ligada; a API
   * só publica. Os outros consumidores (animações, cenas) são dos módulos deles.
   */
  async onModuleInit(): Promise<void> {
    if (!this.enrich.enabled || process.env.WORKER_ONLY !== 'true') return;
    await this.queue.subscribe(
      QUEUES.FLYER_PRO_ENRICH,
      this.enrich.concurrency,
      (message: BatchMessage) => this.processor.handle(message),
    );
    this.reconciler.start();
  }
}
