import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FlyerProTemplatesController } from './controllers/flyer-pro-templates.controller';
import { FlyerProDocument } from './entities/flyer-pro-document.entity';
import { FlyerProItem } from './entities/flyer-pro-item.entity';
import { FlyerProSceneReader } from './services/flyer-pro-scene.reader';
import { FlyerProTemplateSnapshotService } from './services/flyer-pro-template-snapshot.service';
import { FlyerProTemplatesService } from './services/flyer-pro-templates.service';

/**
 * Módulo do Encarte Pro (backend). Nasce com a leitura dos templates das cenas do Templates v2 (N7) e com o montador da
 * cópia congelada do template, que as changes seguintes (documento e salvar) chamam. Só lê as tabelas das cenas, sem
 * passar pela flag `TEMPLATE_SCENE_ENABLED`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([FlyerProDocument, FlyerProItem])],
  controllers: [FlyerProTemplatesController],
  providers: [FlyerProSceneReader, FlyerProTemplatesService, FlyerProTemplateSnapshotService],
  exports: [FlyerProTemplateSnapshotService],
})
export class FlyerProModule {}
