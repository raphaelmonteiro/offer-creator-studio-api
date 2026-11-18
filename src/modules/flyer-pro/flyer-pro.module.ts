import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SharedModule } from '../../shared/shared.module';
import { AiModule } from '../ai/ai.module';
import { FlyerProDocumentsController } from './controllers/flyer-pro-documents.controller';
import { FlyerProEnrichmentController } from './controllers/flyer-pro-enrichment.controller';
import { FlyerProStructureSuggestionController } from './controllers/flyer-pro-structure-suggestion.controller';
import { FlyerProTemplatesController } from './controllers/flyer-pro-templates.controller';
import { FLYER_PRO_ENRICH_CONFIG, readEnrichConfig } from './config/flyer-pro-enrich.config';
import { readStructureAiConfig, STRUCTURE_AI_CONFIG } from './config/structure-ai.config';
import { FlyerProDocument } from './entities/flyer-pro-document.entity';
import { FlyerProImport } from './entities/flyer-pro-import.entity';
import { FlyerProItem } from './entities/flyer-pro-item.entity';
import { FlyerProJob } from './entities/flyer-pro-job.entity';
import { createStructureAiPort } from './providers/flyer-pro-structure-ai.factory';
import { FLYER_PRO_STRUCTURE_AI_PORT } from './providers/flyer-pro-structure-ai.port';
import { FlyerProClientGuardService } from './services/flyer-pro-client-guard.service';
import { FlyerProCursorService } from './services/flyer-pro-cursor.service';
import { FlyerProDocumentsService } from './services/flyer-pro-documents.service';
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
    // Um limitador só por processo da API: a vaga em andamento e o teto por hora vivem na memória dele.
    { provide: FlyerProStructureLimiter, useFactory: () => new FlyerProStructureLimiter() },
    {
      provide: FLYER_PRO_ENRICH_CONFIG,
      useFactory: (config: ConfigService) => readEnrichConfig(config),
      inject: [ConfigService],
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
export class FlyerProModule {}
