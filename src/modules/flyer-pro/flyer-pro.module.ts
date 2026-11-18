import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FlyerProDocumentsController } from './controllers/flyer-pro-documents.controller';
import { FlyerProExportsController } from './controllers/flyer-pro-exports.controller';
import { FlyerProStructureSuggestionController } from './controllers/flyer-pro-structure-suggestion.controller';
import { FlyerProTemplatesController } from './controllers/flyer-pro-templates.controller';
import { readStructureAiConfig, STRUCTURE_AI_CONFIG } from './config/structure-ai.config';
import { FlyerProDocument } from './entities/flyer-pro-document.entity';
import { FlyerProExport } from './entities/flyer-pro-export.entity';
import { FlyerProImport } from './entities/flyer-pro-import.entity';
import { FlyerProItem } from './entities/flyer-pro-item.entity';
import { createStructureAiPort } from './providers/flyer-pro-structure-ai.factory';
import { FLYER_PRO_STRUCTURE_AI_PORT } from './providers/flyer-pro-structure-ai.port';
import { FlyerProClientGuardService } from './services/flyer-pro-client-guard.service';
import { FlyerProCursorService } from './services/flyer-pro-cursor.service';
import { FlyerProDocumentsService } from './services/flyer-pro-documents.service';
import { FlyerProExportsService } from './services/flyer-pro-exports.service';
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
 * o módulo de clientes chama ao excluir um cliente, o registro e o histórico das exportações (N8 e N9) e a sugestão de estrutura por IA (N19, só leitura). Lê as tabelas das cenas sem passar pela flag `TEMPLATE_SCENE_ENABLED`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([FlyerProDocument, FlyerProItem, FlyerProImport, FlyerProExport]),
  ],
  controllers: [
    FlyerProTemplatesController,
    FlyerProDocumentsController,
    FlyerProExportsController,
    FlyerProStructureSuggestionController,
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
    FlyerProExportsService,
    FlyerProStructureSuggestionService,
    // Um limitador só por processo da API: a vaga em andamento e o teto por hora vivem na memória dele.
    { provide: FlyerProStructureLimiter, useFactory: () => new FlyerProStructureLimiter() },
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
