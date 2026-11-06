import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnimationQueueService, QUEUES } from '../../shared/queue/animation-queue.service';
import { SharedModule } from '../../shared/shared.module';
import { AiModule } from '../ai/ai.module';
import { OpenAiDirectorService } from '../ai/openai-director.service';
import { OpenAiImageService } from '../ai/openai-image.service';
import { OpenAiVisionService } from '../ai/openai-vision.service';
import { TemplateScene } from './entities/template-scene.entity';
import { TemplateSceneAsset } from './entities/template-scene-asset.entity';
import { TemplateSceneMessage } from './entities/template-scene-message.entity';
import { TemplateSceneVersion } from './entities/template-scene-version.entity';
import { SceneAddElementHandler } from './processors/scene-add-element.handler';
import { SceneCallRunner } from './processors/scene-call-runner';
import { SceneDirectorJob, SceneDirectorProcessor } from './processors/scene-director.processor';
import { SceneDirectorState } from './processors/scene-director-state';
import { SceneEditHandler } from './processors/scene-edit.handler';
import { SceneGenerateHandler } from './processors/scene-generate.handler';
import { SceneLayerHandler } from './processors/scene-layer.handler';
import { SceneTurnJob, SceneTurnProcessor } from './processors/scene-turn.processor';
import { SceneTurnSupport } from './processors/scene-turn-support';
import { SceneTurnState } from './processors/scene-turn-state';
import {
  createSceneDirectorClient,
  SCENE_DIRECTOR_CLIENT,
} from './providers/scene-director-client';
import { createSceneImageProvider } from './providers/scene-image-provider.factory';
import { SCENE_IMAGE_PROVIDER } from './providers/scene-image-provider';
import { createSceneVisionClient, SCENE_VISION_CLIENT } from './providers/scene-vision-client';
import { SceneDirectorContextService } from './services/scene-director-context';
import { SceneDirectorService } from './services/scene-director.service';
import { SceneFilesService } from './services/scene-files.service';
import { SceneImageService } from './services/scene-image.service';
import { SceneLockService } from './services/scene-lock.service';
import { SceneLogoService } from './services/scene-logo.service';
import { SceneReadService } from './services/scene-read.service';
import { SceneReconcilerService } from './services/scene-reconciler.service';
import { SceneTurnService } from './services/scene-turn.service';
import { SceneVisionService } from './services/scene-vision.service';
import { SceneVersionsService } from './services/scene-versions.service';
import { TemplateScenesService } from './services/template-scenes.service';
import { TemplateSceneEnabledGuard } from './template-scene-enabled.guard';
import { TemplateSceneEventsController } from './template-scene-events.controller';
import { TemplateScenesAdminController } from './template-scenes-admin.controller';
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
    AiModule,
  ],
  controllers: [
    TemplateScenesController,
    TemplateSceneEventsController,
    TemplateScenesAdminController,
  ],
  providers: [
    TemplateSceneEnabledGuard,
    SceneLockService,
    SceneReadService,
    TemplateScenesService,
    SceneVersionsService,
    SceneFilesService,
    SceneLogoService,
    SceneTurnService,
    SceneTurnState,
    SceneTurnSupport,
    SceneCallRunner,
    SceneImageService,
    SceneVisionService,
    SceneDirectorService,
    SceneDirectorContextService,
    SceneDirectorState,
    SceneDirectorProcessor,
    SceneGenerateHandler,
    SceneEditHandler,
    SceneLayerHandler,
    SceneAddElementHandler,
    SceneTurnProcessor,
    SceneReconcilerService,
    {
      provide: SCENE_IMAGE_PROVIDER,
      inject: [ConfigService, OpenAiImageService],
      useFactory: createSceneImageProvider,
    },
    {
      provide: SCENE_DIRECTOR_CLIENT,
      inject: [ConfigService, OpenAiDirectorService],
      useFactory: createSceneDirectorClient,
    },
    {
      provide: SCENE_VISION_CLIENT,
      inject: [ConfigService, OpenAiVisionService],
      useFactory: createSceneVisionClient,
    },
  ],
})
export class TemplateScenesModule implements OnModuleInit {
  constructor(
    private readonly config: ConfigService,
    private readonly queue: AnimationQueueService,
    private readonly processor: SceneTurnProcessor,
    private readonly directorProcessor: SceneDirectorProcessor,
    private readonly reconciler: SceneReconcilerService,
  ) {}

  /** Consumers e reconciliador só no worker e com a flag da cena ligada. */
  async onModuleInit(): Promise<void> {
    if (this.config.get('TEMPLATE_SCENE_ENABLED') !== 'true') return;
    if (this.config.get('WORKER_ONLY') !== 'true') return;
    await this.queue.subscribe(
      QUEUES.TEMPLATE_SCENE_TURN,
      this.positiveInt('TEMPLATE_SCENE_CONCURRENCY', 1),
      (job: SceneTurnJob, jobId: string) => this.processor.process(job, jobId),
    );
    // O Diretor tem concorrência própria: não espera a imagem de outra cena (crítica S4).
    await this.queue.subscribe(
      QUEUES.TEMPLATE_SCENE_DIRECTOR,
      this.positiveInt('TEMPLATE_SCENE_DIRECTOR_CONCURRENCY', 4),
      (job: SceneDirectorJob, jobId: string) => this.directorProcessor.process(job, jobId),
    );
    this.reconciler.start();
  }

  private positiveInt(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key, String(fallback)));
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
  }
}
