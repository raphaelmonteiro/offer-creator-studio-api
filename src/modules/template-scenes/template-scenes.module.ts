import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SharedModule } from '../../shared/shared.module';
import { TemplateScene } from './entities/template-scene.entity';
import { TemplateSceneAsset } from './entities/template-scene-asset.entity';
import { TemplateSceneMessage } from './entities/template-scene-message.entity';
import { TemplateSceneVersion } from './entities/template-scene-version.entity';
import { SceneFilesService } from './services/scene-files.service';
import { SceneLockService } from './services/scene-lock.service';
import { SceneLogoService } from './services/scene-logo.service';
import { SceneReadService } from './services/scene-read.service';
import { SceneVersionsService } from './services/scene-versions.service';
import { TemplateScenesService } from './services/template-scenes.service';
import { TemplateSceneEnabledGuard } from './template-scene-enabled.guard';
import { TemplateScenesController } from './template-scenes.controller';

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
  controllers: [TemplateScenesController],
  providers: [
    TemplateSceneEnabledGuard,
    SceneLockService,
    SceneReadService,
    TemplateScenesService,
    SceneVersionsService,
    SceneFilesService,
    SceneLogoService,
  ],
})
export class TemplateScenesModule {}
