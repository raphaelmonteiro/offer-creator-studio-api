import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { AnimationAsset } from './entities/animation-asset.entity';
import { AnimationTask } from './entities/animation-task.entity';
import { AnimationTaskEvent } from './entities/animation-task-event.entity';
import { RenderJob } from './entities/render-job.entity';
import { AiCreditLedgerEntry } from './entities/ai-credit-ledger.entity';
import { VoiceCatalogEntry } from './entities/voice-catalog.entity';
import { CreditsService } from './services/credits.service';
import { TaskTransitionService } from './services/task-transition.service';
import { AnimationQueueService, QUEUES } from './services/animation-queue.service';
import { ResourceGuardService } from './services/resource-guard.service';
import { AnimationEventsService } from './services/animation-events.service';
import { AnimationTasksService } from './services/animation-tasks.service';
import { RenderJobsService } from './services/render-jobs.service';
import { TtsCacheService } from './services/tts-cache.service';
import { WebhookService } from './services/webhook.service';
import { RunwayProvider } from './providers/runway.provider';
import { FalKlingProvider } from './providers/fal-kling.provider';
import { ElevenLabsProvider } from './providers/elevenlabs.provider';
import { HeyGenProvider } from './providers/heygen.provider';
import { AiGenerationProcessor } from './processors/ai-generation.processor';
import { FfmpegRenderProcessor } from './processors/ffmpeg-render.processor';
import { AnimationTasksController } from './controllers/animation-tasks.controller';
import { RenderJobsController } from './controllers/render-jobs.controller';
import { AnimationAssetsController } from './controllers/animation-assets.controller';
import { AnimationEventsController } from './controllers/animation-events.controller';
import { AnimationWebhooksController } from './controllers/animation-webhooks.controller';
import { CreditsController } from './controllers/credits.controller';
import { VoiceCatalogController } from './controllers/voice-catalog.controller';

/**
 * Módulo de Animações IA (TDD docs/tdd-modulo-animacoes-ia.md).
 * No processo API os consumers não são registrados; no worker (WORKER_ONLY=true)
 * os consumers assinam as filas com gate do ResourceGuard (TDD ADR-02/§6.5).
 */
@Module({
  imports: [
    AiModule,
    TypeOrmModule.forFeature([
      AnimationAsset,
      AnimationTask,
      AnimationTaskEvent,
      RenderJob,
      AiCreditLedgerEntry,
      VoiceCatalogEntry,
    ]),
  ],
  controllers: [
    AnimationTasksController,
    RenderJobsController,
    AnimationAssetsController,
    AnimationEventsController,
    AnimationWebhooksController,
    CreditsController,
    VoiceCatalogController,
  ],
  providers: [
    CreditsService,
    TaskTransitionService,
    AnimationQueueService,
    ResourceGuardService,
    AnimationEventsService,
    AnimationTasksService,
    RenderJobsService,
    TtsCacheService,
    WebhookService,
    RunwayProvider,
    FalKlingProvider,
    ElevenLabsProvider,
    HeyGenProvider,
    AiGenerationProcessor,
    FfmpegRenderProcessor,
  ],
  exports: [AnimationQueueService],
})
export class AnimationsModule implements OnModuleInit {
  constructor(
    private readonly queue: AnimationQueueService,
    private readonly resourceGuard: ResourceGuardService,
    private readonly aiProcessor: AiGenerationProcessor,
    private readonly renderProcessor: FfmpegRenderProcessor,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.WORKER_ONLY !== 'true') return;
    const renderConcurrency = Number(process.env.RENDER_CONCURRENCY ?? 1);
    // jobs leves (poll) fluem sempre; pesados passam pelo admission control
    await this.queue.subscribe(QUEUES.AI_GENERATE, 2, (d: { taskId: string }) =>
      this.aiProcessor.generate(d),
    );
    await this.queue.subscribe(QUEUES.AI_POLL, 4, (d: { taskId: string; attempt?: number }) =>
      this.aiProcessor.poll(d),
    );
    await this.queue.subscribe(
      QUEUES.RENDER_EXPORT,
      renderConcurrency,
      (d: { renderId: string }) => this.renderProcessor.process(d),
      () => this.resourceGuard.admitHeavyJob(),
    );
  }
}
