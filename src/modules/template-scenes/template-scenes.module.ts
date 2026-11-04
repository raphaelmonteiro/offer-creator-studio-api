import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SharedModule } from '../../shared/shared.module';
import { TemplateScene } from './entities/template-scene.entity';
import { TemplateSceneAsset } from './entities/template-scene-asset.entity';
import { TemplateSceneMessage } from './entities/template-scene-message.entity';
import { TemplateSceneVersion } from './entities/template-scene-version.entity';
import { TemplateSceneEnabledGuard } from './template-scene-enabled.guard';

/**
 * Cena de template (estágio 3 do Template Pro): persistência, versões, chat e geração assíncrona.
 * Sempre registrado no app; a flag `TEMPLATE_SCENE_ENABLED` age nas rotas (404) e no consumer.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TemplateScene,
      TemplateSceneVersion,
      TemplateSceneAsset,
      TemplateSceneMessage,
    ]),
    SharedModule,
  ],
  providers: [TemplateSceneEnabledGuard],
})
export class TemplateScenesModule {}
