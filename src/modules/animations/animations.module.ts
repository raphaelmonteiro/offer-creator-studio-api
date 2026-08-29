import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModule } from '../ai/ai.module';
import { MascotsModule } from '../mascots/mascots.module';
import { SharedModule } from '../../shared/shared.module';
import { AnimationQueueService, QUEUES } from '../../shared/queue/animation-queue.service';
import { ResourceGuardService } from '../../shared/resource-guard/resource-guard.service';
import { AnimationTask } from './entities/animation-task.entity';
import { RenderJob } from './entities/render-job.entity';
import { AnimationTasksService } from './services/animation-tasks.service';
import { RenderJobsService } from './services/render-jobs.service';
import { TtsCacheService } from './services/tts-cache.service';
import { WebhookService } from './services/webhook.service';
import { RunwayProvider } from './providers/runway.provider';
import { FalKlingProvider } from './providers/fal-kling.provider';
import { HeyGenProvider } from './providers/heygen.provider';
import { MockVideoProvider } from './providers/mock-video.provider';
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
 * A infraestrutura neutra (fila, transições CAS, créditos, assets, ffmpeg,
 * resource guard, eventos SSE, GC) vive no SharedModule (plano-comerciais
 * §11) — aqui ficam apenas domínio, providers, processors e controllers.
 * No processo API os consumers não são registrados; no worker
 * (WORKER_ONLY=true) os consumers assinam as filas com gate do ResourceGuard
 * (TDD ADR-02/§6.5).
 */
@Module({
  imports: [
    AiModule,
    SharedModule,
    // o formulário de animar mascote resolve a imagem a partir do mascote da
    // biblioteca — ownership e recorte são validados pelo MascotsService
    MascotsModule,
    TypeOrmModule.forFeature([AnimationTask, RenderJob]),
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
    AnimationTasksService,
    RenderJobsService,
    TtsCacheService,
    WebhookService,
    RunwayProvider,
    FalKlingProvider,
    HeyGenProvider,
    MockVideoProvider,
    AiGenerationProcessor,
    FfmpegRenderProcessor,
  ],
  exports: [SharedModule],
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
