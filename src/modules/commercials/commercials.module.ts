import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnimationQueueService, QUEUES } from '../../shared/queue/animation-queue.service';
import { ResourceGuardService } from '../../shared/resource-guard/resource-guard.service';
import { SharedModule } from '../../shared/shared.module';
import { EmailModule } from '../email/email.module';
import { MascotsModule } from '../mascots/mascots.module';
import { CommercialsController } from './commercials.controller';
import { CommercialsService } from './commercials.service';
import { MC_QUEUE_CONCURRENCY } from './domain/mc-pipeline.config';
import { McCharacterKit } from './entities/mc-character-kit.entity';
import { McEvent } from './entities/mc-event.entity';
import { McProject } from './entities/mc-project.entity';
import { McScene } from './entities/mc-scene.entity';
import { McStep } from './entities/mc-step.entity';
import { McEnabledGuard } from './mc-enabled.guard';
import { McEventsController } from './mc-events.controller';
import { McAssemblyProcessor } from './processors/mc-assembly.processor';
import { McIngestProcessor } from './processors/mc-ingest.processor';
import { McKeyframeProcessor } from './processors/mc-keyframe.processor';
import { McKitProcessor } from './processors/mc-kit.processor';
import { McPollProcessor } from './processors/mc-poll.processor';
import { McScriptProcessor } from './processors/mc-script.processor';
import { McTalkingProcessor } from './processors/mc-talking.processor';
import { McTtsProcessor } from './processors/mc-tts.processor';
import { McKitsService } from './services/mc-kits.service';
import { McMaterializerService } from './services/mc-materializer.service';
import { McPipelineService } from './services/mc-pipeline.service';
import { McProjectActionsService } from './services/mc-project-actions.service';
import { McReconcilerService } from './services/mc-reconciler.service';
import { McStorageService } from './services/mc-storage.service';
import { McVoicesService } from './services/mc-voices.service';

/**
 * Módulo de Comerciais com Mascote (docs/plano-comerciais-mascote.md §6).
 * Toda a infraestrutura vem do SharedModule (fila, CAS+notify, créditos,
 * assets, providers HTTP, guard) — NUNCA de modules/animations (lint de
 * boundary no .eslintrc.js). MascotsModule é import PERMITIDO: o kit valida
 * ownership/direitos/recorte do mascote via MascotsService (plano §4).
 *
 * O módulo fica SEMPRE registrado no app.module; a feature flag MC_ENABLED
 * age nas rotas (McEnabledGuard → 404) e no registro dos consumers abaixo.
 * Como no AnimationsModule, o processo API não registra consumers — só o
 * worker (WORKER_ONLY=true). O seed do voice_catalog roda no processo API
 * (idempotente: só insere com a tabela vazia; falha não derruba o boot).
 *
 * Filas do pipeline (plano §6.4; concorrências em MC_QUEUE_CONCURRENCY):
 * mc.llm 2 · mc.image 4 (kit + keyframe, despachados pelo payload) ·
 * mc.tts 4 · mc.submit 8 · mc.poll 10 (NUNCA gated — poll parado = pipeline
 * parado) · mc.ingest 2 e mc.ffmpeg 1 com gate do ResourceGuard (jobs
 * pesados de disco/CPU respeitam o admission control).
 */
@Module({
  imports: [
    SharedModule,
    MascotsModule,
    // EmailModule: e-mail de conclusão do comercial (plano §10 v1) — envio
    // NÃO bloqueante, tratado no McPipelineService.
    EmailModule,
    TypeOrmModule.forFeature([McCharacterKit, McProject, McScene, McStep, McEvent]),
  ],
  controllers: [CommercialsController, McEventsController],
  providers: [
    CommercialsService,
    McKitsService,
    McVoicesService,
    McStorageService,
    McMaterializerService,
    McPipelineService,
    McProjectActionsService,
    McScriptProcessor,
    McKitProcessor,
    McKeyframeProcessor,
    McTtsProcessor,
    McTalkingProcessor,
    McPollProcessor,
    McIngestProcessor,
    McAssemblyProcessor,
    McReconcilerService,
    McEnabledGuard,
  ],
})
export class CommercialsModule implements OnModuleInit {
  constructor(
    private readonly queue: AnimationQueueService,
    private readonly resourceGuard: ResourceGuardService,
    private readonly scriptProcessor: McScriptProcessor,
    private readonly kitProcessor: McKitProcessor,
    private readonly keyframeProcessor: McKeyframeProcessor,
    private readonly ttsProcessor: McTtsProcessor,
    private readonly talkingProcessor: McTalkingProcessor,
    private readonly pollProcessor: McPollProcessor,
    private readonly ingestProcessor: McIngestProcessor,
    private readonly assemblyProcessor: McAssemblyProcessor,
    private readonly reconciler: McReconcilerService,
    private readonly voices: McVoicesService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.MC_ENABLED !== 'true') return;
    if (process.env.WORKER_ONLY === 'true') {
      await this.queue.subscribe(
        QUEUES.MC_LLM,
        MC_QUEUE_CONCURRENCY[QUEUES.MC_LLM] ?? 2,
        (d: { stepId: string; projectId?: string }) => this.scriptProcessor.process(d),
      );
      // mc.image transporta DOIS payloads: kit ({kitId, slot?}) e keyframe
      // ({stepId}) — o dispatcher separa pela forma (uma fila, um consumer).
      await this.queue.subscribe(
        QUEUES.MC_IMAGE,
        MC_QUEUE_CONCURRENCY[QUEUES.MC_IMAGE] ?? 4,
        (d: { kitId?: string; slot?: number; stepId?: string }) =>
          d.kitId
            ? this.kitProcessor.process({ kitId: d.kitId, slot: d.slot })
            : this.keyframeProcessor.process({ stepId: d.stepId as string }),
      );
      await this.queue.subscribe(
        QUEUES.MC_TTS,
        MC_QUEUE_CONCURRENCY[QUEUES.MC_TTS] ?? 4,
        (d: { stepId: string }) => this.ttsProcessor.process(d),
      );
      await this.queue.subscribe(
        QUEUES.MC_SUBMIT,
        MC_QUEUE_CONCURRENCY[QUEUES.MC_SUBMIT] ?? 8,
        (d: { stepId: string }) => this.talkingProcessor.process(d),
      );
      // mc.poll NUNCA leva admit: com o guard degradado o poll continua —
      // é ele que detecta timeout e mantém o estado do pipeline vivo (§6.4).
      await this.queue.subscribe(
        QUEUES.MC_POLL,
        MC_QUEUE_CONCURRENCY[QUEUES.MC_POLL] ?? 10,
        (d: { stepId: string; attempt?: number; statusUrl?: string; responseUrl?: string }) =>
          this.pollProcessor.process(d),
      );
      await this.queue.subscribe(
        QUEUES.MC_INGEST,
        MC_QUEUE_CONCURRENCY[QUEUES.MC_INGEST] ?? 2,
        (d: { stepId: string; responseUrl?: string }) => this.ingestProcessor.process(d),
        () => this.resourceGuard.admitHeavyJob(),
      );
      await this.queue.subscribe(
        QUEUES.MC_FFMPEG,
        MC_QUEUE_CONCURRENCY[QUEUES.MC_FFMPEG] ?? 1,
        (d: { stepId: string }) => this.assemblyProcessor.process(d),
        () => this.resourceGuard.admitHeavyJob(),
      );
      // Watchdog de steps órfãos (domain/mc-watchdog.ts): repõe jobs de steps
      // cujo job pg-boss morreu (ex.: retries queimados por recusa do guard).
      this.reconciler.start();
      return;
    }
    // Processo API: seed idempotente do catálogo de vozes (plano §5.3).
    await this.voices.seedIfEmpty();
  }
}
