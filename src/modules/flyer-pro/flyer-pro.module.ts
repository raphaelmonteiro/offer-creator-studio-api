import { Module } from '@nestjs/common';
import { FlyerProTemplatesController } from './controllers/flyer-pro-templates.controller';
import { FlyerProSceneReader } from './services/flyer-pro-scene.reader';
import { FlyerProTemplatesService } from './services/flyer-pro-templates.service';

/**
 * Módulo do Encarte Pro (backend). Nasce com a leitura dos templates das cenas do Templates v2 (N7); o montador da
 * cópia congelada do template entra na task seguinte e as rotas do documento, nas changes seguintes. Só lê as tabelas
 * das cenas, sem passar pela flag `TEMPLATE_SCENE_ENABLED`.
 */
@Module({
  controllers: [FlyerProTemplatesController],
  providers: [FlyerProSceneReader, FlyerProTemplatesService],
})
export class FlyerProModule {}
