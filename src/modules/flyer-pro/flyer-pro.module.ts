import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FlyerProDocumentsController } from './controllers/flyer-pro-documents.controller';
import { FlyerProTemplatesController } from './controllers/flyer-pro-templates.controller';
import { FlyerProDocument } from './entities/flyer-pro-document.entity';
import { FlyerProImport } from './entities/flyer-pro-import.entity';
import { FlyerProItem } from './entities/flyer-pro-item.entity';
import { FlyerProClientGuardService } from './services/flyer-pro-client-guard.service';
import { FlyerProCursorService } from './services/flyer-pro-cursor.service';
import { FlyerProDocumentsService } from './services/flyer-pro-documents.service';
import { FlyerProSaveService } from './services/flyer-pro-save.service';
import { FlyerProItemsService } from './services/flyer-pro-items.service';
import { FlyerProSetupService } from './services/flyer-pro-setup.service';
import { FlyerProSceneReader } from './services/flyer-pro-scene.reader';
import { FlyerProTemplateSnapshotService } from './services/flyer-pro-template-snapshot.service';
import { FlyerProTemplatesService } from './services/flyer-pro-templates.service';

/**
 * Módulo do Encarte Pro (backend): a leitura dos templates das cenas do Templates v2 (N7), o montador da cópia congelada
 * do template, o encarte guardado no servidor (criar, listar, abrir e excluir: N1, N2, N3 e N6) e o serviço de guarda que
 * o módulo de clientes chama ao excluir um cliente. Lê as tabelas das cenas sem passar pela flag `TEMPLATE_SCENE_ENABLED`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([FlyerProDocument, FlyerProItem, FlyerProImport])],
  controllers: [FlyerProTemplatesController, FlyerProDocumentsController],
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
  ],
  exports: [FlyerProTemplateSnapshotService, FlyerProClientGuardService],
})
export class FlyerProModule {}
