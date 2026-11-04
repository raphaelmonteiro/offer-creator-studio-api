import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnimationQueueService, QUEUES } from '../../shared/queue/animation-queue.service';
import { SharedModule } from '../../shared/shared.module';
import { AiModule } from '../ai/ai.module';
import { OpenAiImageService } from '../ai/openai-image.service';
import { TemplateScene } from './entities/template-scene.entity';
import { TemplateSceneAsset } from './entities/template-scene-asset.entity';
import { TemplateSceneMessage } from './entities/template-scene-message.entity';
import { TemplateSceneVersion } from './entities/template-scene-version.entity';
import { SceneTurnJob, SceneTurnProcessor } from './processors/scene-turn.processor';
import { SceneTurnState } from './processors/scene-turn-state';
import { createSceneImageProvider } from './providers/scene-image-provider.factory';
import { SCENE_IMAGE_PROVIDER } from './providers/scene-image-provider';
import { SceneFilesService } from './services/scene-files.service';
import { SceneLockService } from './services/scene-lock.service';
import { SceneLogoService } from './services/scene-logo.service';
import { SceneReadService } from './services/scene-read.service';
import { SceneReconcilerService } from './services/scene-reconciler.service';
import { SceneTurnService } from './services/scene-turn.service';
import { SceneVersionsService } from './services/scene-versions.service';
import { TemplateScenesService } from './services/template-scenes.service';
import { TemplateSceneEnabledGuard } from './template-scene-enabled.guard';
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
  controllers: [TemplateScenesController, TemplateScenesAdminController],
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
    SceneTurnProcessor,
    SceneReconcilerService,
    {
      provide: SCENE_IMAGE_PROVIDER,
      inject: [ConfigService, OpenAiImageService],
      useFactory: createSceneImageProvider,
    },
  ],
})
export class TemplateScenesModule implements OnModuleInit {
  constructor(
    private readonly config: ConfigService,
    private readonly queue: AnimationQueueService,
    private readonly processor: SceneTurnProcessor,
    private readonly reconciler: SceneReconcilerService,
  ) {}

  /** Consumer e reconciliador só no worker e com a flag da cena ligada. */
  async onModuleInit(): Promise<void> {
    if (this.config.get('TEMPLATE_SCENE_ENABLED') !== 'true') return;
    if (this.config.get('WORKER_ONLY') !== 'true') return;
    await this.queue.subscribe(
      QUEUES.TEMPLATE_SCENE_TURN,
      this.concurrency(),
      (job: SceneTurnJob, jobId: string) => this.processor.process(job, jobId),
    );
    this.reconciler.start();
  }

  private concurrency(): number {
    const value = Number(this.config.get<string>('TEMPLATE_SCENE_CONCURRENCY', '1'));
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
  }
}
