import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnimationQueueService } from './queue/animation-queue.service';
import { TaskTransitionService } from './state/task-transition.service';
import { AnimationTaskEvent } from './state/animation-task-event.entity';
import { CreditsService } from './credits/credits.service';
import { AiCreditLedgerEntry } from './credits/ai-credit-ledger.entity';
import { MediaAssetsService } from './media-assets/media-assets.service';
import { AnimationAsset } from './media-assets/animation-asset.entity';
import { FfmpegRunner } from './ffmpeg/ffmpeg-runner';
import { ResourceGuardService } from './resource-guard/resource-guard.service';
import { AnimationEventsService } from './events/animation-events.service';
import { UploadsGcService } from './gc/uploads-gc.service';
import { SystemSetting } from './settings/system-setting.entity';
import { SystemSettingsService } from './settings/system-settings.service';
import { WorkerHeartbeatService } from './settings/worker-heartbeat.service';
import { VoiceCatalogEntry } from './voice/voice-catalog.entity';
import { ElevenLabsProvider } from './providers/elevenlabs.provider';
import { ElevenLabsMusicProvider } from './providers/elevenlabs-music.provider';
import { GeminiImageProvider } from './providers/gemini-image.provider';
import { FalQueueClient } from './providers/fal-queue.client';
import { ModerationProvider } from './providers/moderation.provider';

/**
 * Infraestrutura neutra extraída de modules/animations (plano-comerciais
 * §11): fila pg-boss, transições CAS + auditoria + pg_notify, ledger de
 * créditos, biblioteca de mídias, runner ffmpeg, admission control,
 * LISTEN/NOTIFY para SSE, GC de uploads, catálogo de vozes e os providers
 * HTTP neutros (ElevenLabs TTS, Gemini imagem, fila fal, moderação OpenAI).
 * Módulos de feature (animations e commercials) importam DAQUI — nunca um do
 * outro (lint de boundary em .eslintrc.js).
 *
 * WORKER_ONLY: os serviços daqui preservam seus próprios gates — o
 * AnimationEventsService só faz LISTEN no processo API, o UploadsGcService e o
 * WorkerHeartbeatService só agendam no worker; o registro de consumers de fila
 * continua nos módulos de feature (é lá que vivem os processors).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AnimationTaskEvent,
      AiCreditLedgerEntry,
      AnimationAsset,
      SystemSetting,
      VoiceCatalogEntry,
    ]),
  ],
  providers: [
    AnimationQueueService,
    TaskTransitionService,
    CreditsService,
    MediaAssetsService,
    FfmpegRunner,
    ResourceGuardService,
    AnimationEventsService,
    UploadsGcService,
    SystemSettingsService,
    WorkerHeartbeatService,
    ElevenLabsProvider,
    ElevenLabsMusicProvider,
    GeminiImageProvider,
    FalQueueClient,
    ModerationProvider,
  ],
  exports: [
    TypeOrmModule,
    AnimationQueueService,
    TaskTransitionService,
    CreditsService,
    MediaAssetsService,
    FfmpegRunner,
    ResourceGuardService,
    AnimationEventsService,
    UploadsGcService,
    SystemSettingsService,
    WorkerHeartbeatService,
    ElevenLabsProvider,
    ElevenLabsMusicProvider,
    GeminiImageProvider,
    FalQueueClient,
    ModerationProvider,
  ],
})
export class SharedModule {}
