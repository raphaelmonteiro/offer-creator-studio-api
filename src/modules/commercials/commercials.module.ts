import { Module, OnModuleInit } from '@nestjs/common';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AnimationQueueService, QUEUES } from '../../shared/queue/animation-queue.service';
import { ResourceGuardService } from '../../shared/resource-guard/resource-guard.service';
import { SharedModule } from '../../shared/shared.module';
import { ClientsModule } from '../clients/clients.module';
import { EmailModule } from '../email/email.module';
import { MascotsModule } from '../mascots/mascots.module';
import { CommercialsController } from './commercials.controller';
import { CommercialsInsightsController } from './commercials-insights.controller';
import { CommercialsService } from './commercials.service';
import { mcModelPrices } from './domain/mc-kit-costs';
import { MC_QUEUE_CONCURRENCY, mcTalkEngines, parseMcFormats } from './domain/mc-pipeline.config';
import { McCharacterKit } from './entities/mc-character-kit.entity';
import { McEvent } from './entities/mc-event.entity';
import { McKitCandidate } from './entities/mc-kit-candidate.entity';
import { McProject } from './entities/mc-project.entity';
import { McScene } from './entities/mc-scene.entity';
import { McStep } from './entities/mc-step.entity';
import { McStepType } from './domain/mc-types';
import { McEnabledGuard } from './mc-enabled.guard';
import { McEventsController } from './mc-events.controller';
import { McOfferCarouselController } from './mc-offer-carousel.controller';
import { McAssemblyProcessor } from './processors/mc-assembly.processor';
import { McComposeFfmpegProcessor } from './processors/mc-compose-ffmpeg.processor';
import { McFinalizeProcessor } from './processors/mc-finalize.processor';
import { McRenderRemotionProcessor } from './processors/mc-render-remotion.processor';
import { McCarouselRendererService } from './services/mc-carousel-renderer';
import { McOfferCarouselService } from './services/mc-offer-carousel.service';
import { McIngestProcessor } from './processors/mc-ingest.processor';
import { McClipInspectorService } from './services/mc-clip-inspector.service';
import { McKeyframeProcessor } from './processors/mc-keyframe.processor';
import { McKitCandidatesProcessor } from './processors/mc-kit-candidates.processor';
import { McKitProcessor } from './processors/mc-kit.processor';
import { McPollProcessor } from './processors/mc-poll.processor';
import { McSceneComposeProcessor } from './processors/mc-scene-compose.processor';
import { McScriptProcessor } from './processors/mc-script.processor';
import { McTalkingProcessor } from './processors/mc-talking.processor';
import { McTtsProcessor } from './processors/mc-tts.processor';
import { McKitCandidatesService, McKitReferencesJob } from './services/mc-kit-candidates.service';
import { McKitTileService } from './services/mc-kit-tile.service';
import { McKitViewService } from './services/mc-kit-view.service';
import { McKitsService } from './services/mc-kits.service';
import { McMouthGateService } from './services/mc-mouth-gate.service';
import { McLogoLocatorService } from './services/mc-logo-locator.service';
import { McMaterializerService } from './services/mc-materializer.service';
import { McPipelineService } from './services/mc-pipeline.service';
import { McArtService } from './services/mc-art.service';
import { McFromArtService } from './services/mc-from-art.service';
import { McProjectActionsService } from './services/mc-project-actions.service';
import { McQualityService } from './services/mc-quality.service';
import { McReconcilerService } from './services/mc-reconciler.service';
import { McStorageService } from './services/mc-storage.service';
import { McTranslationService } from './services/mc-translation.service';
import { McVoicesService } from './services/mc-voices.service';
import { McAdminCostsService } from './services/mc-admin-costs.service';
import { McWindowPriceService } from './services/mc-window-price.service';

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
    // ClientsModule: o kit com origem `logo` lê `clients.logoUrl` via
    // ClientsService para registrar o logo como personagem de origem (D5).
    ClientsModule,
    // EmailModule: e-mail de conclusão do comercial (plano §10 v1) — envio
    // NÃO bloqueante, tratado no McPipelineService.
    EmailModule,
    TypeOrmModule.forFeature([McCharacterKit, McKitCandidate, McProject, McScene, McStep, McEvent]),
  ],
  // CommercialsInsightsController: custos por mês (admin, 8.3) e avisos da janela (4.7).
  controllers: [
    CommercialsController,
    McEventsController,
    CommercialsInsightsController,
    // F2 (6.8): correção por oferta e "atualizar oferta" a partir do catálogo.
    McOfferCarouselController,
  ],
  providers: [
    CommercialsService,
    McKitsService,
    McKitViewService,
    McKitCandidatesService,
    McKitTileService,
    McMouthGateService,
    McKitCandidatesProcessor,
    McVoicesService,
    McStorageService,
    McMaterializerService,
    McPipelineService,
    McProjectActionsService,
    // Ponte arte → projeto (D9): upload da arte e criação a partir dela.
    McArtService,
    McFromArtService,
    McLogoLocatorService,
    McTranslationService,
    McQualityService,
    McScriptProcessor,
    McKitProcessor,
    McKeyframeProcessor,
    McTtsProcessor,
    McTalkingProcessor,
    McPollProcessor,
    McIngestProcessor,
    McAssemblyProcessor,
    McSceneComposeProcessor,
    // Steps de projeto do F1 (D6): composição e finalização na fila mc.ffmpeg.
    McComposeFfmpegProcessor,
    McFinalizeProcessor,
    // F2 (tarefas 6.5–6.8): render Remotion (fila mc.render) e correções por oferta.
    McRenderRemotionProcessor,
    McCarouselRendererService,
    McOfferCarouselService,
    McReconcilerService,
    McClipInspectorService,
    // Leituras derivadas (8.3 / 4.7): custo de fornecedor e aviso de janela sobre preço.
    McAdminCostsService,
    McWindowPriceService,
    McEnabledGuard,
  ],
})
export class CommercialsModule implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly queue: AnimationQueueService,
    private readonly resourceGuard: ResourceGuardService,
    private readonly scriptProcessor: McScriptProcessor,
    private readonly kitProcessor: McKitProcessor,
    private readonly kitCandidatesProcessor: McKitCandidatesProcessor,
    private readonly keyframeProcessor: McKeyframeProcessor,
    private readonly ttsProcessor: McTtsProcessor,
    private readonly talkingProcessor: McTalkingProcessor,
    private readonly pollProcessor: McPollProcessor,
    private readonly ingestProcessor: McIngestProcessor,
    private readonly assemblyProcessor: McAssemblyProcessor,
    private readonly sceneComposeProcessor: McSceneComposeProcessor,
    private readonly composeFfmpegProcessor: McComposeFfmpegProcessor,
    private readonly finalizeProcessor: McFinalizeProcessor,
    private readonly renderRemotionProcessor: McRenderRemotionProcessor,
    private readonly reconciler: McReconcilerService,
    private readonly voices: McVoicesService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.MC_ENABLED !== 'true') return;
    // Falha cedo com MC_FORMATS ou MC_TALK_ENGINE_* mal escritos (design D2/D13):
    // vale para API e worker — tarifa/limite errados nunca chegam à telemetria.
    parseMcFormats();
    mcTalkEngines();
    // Tabela de tarifas do kit (MC_KIT_PRICES, tarefa 2.6): mal escrita derruba o boot.
    mcModelPrices();
    if (process.env.WORKER_ONLY === 'true') {
      await this.queue.subscribe(
        QUEUES.MC_LLM,
        MC_QUEUE_CONCURRENCY[QUEUES.MC_LLM] ?? 2,
        (d: { stepId: string; projectId?: string }) => this.scriptProcessor.process(d),
      );
      // mc.image transporta TRÊS payloads: kit ({kitId, slot?}), rodada de
      // candidatos ({kitId, candidates: true, roundId}) e keyframe ({stepId})
      // — o dispatcher separa pela forma (uma fila, um consumer). O kit recebe
      // o id do job (estável nas re-entregas do pg-boss): chave da geração
      // para não pagar a descrição canônica de novo (2.6).
      await this.queue.subscribe(
        QUEUES.MC_IMAGE,
        MC_QUEUE_CONCURRENCY[QUEUES.MC_IMAGE] ?? 4,
        (
          d: {
            kitId?: string;
            slot?: number;
            stepId?: string;
            candidates?: boolean;
            roundId?: string;
            fromReview?: boolean;
            previous?: McKitReferencesJob['previous'];
          },
          jobId: string,
        ) => {
          if (!d.kitId) return this.keyframeProcessor.process({ stepId: d.stepId as string });
          if (d.candidates) {
            return this.kitCandidatesProcessor.process({
              kitId: d.kitId,
              roundId: d.roundId as string,
            });
          }
          return this.kitProcessor.process(
            {
              kitId: d.kitId,
              slot: d.slot,
              fromReview: d.fromReview,
              previous: d.previous,
            },
            jobId,
          );
        },
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
      // mc.ffmpeg transporta assembly E scene_compose (v2): o dispatcher usa o
      // `type` do payload e, na falta dele (watchdog/jobs antigos), consulta o step.
      await this.queue.subscribe(
        QUEUES.MC_FFMPEG,
        MC_QUEUE_CONCURRENCY[QUEUES.MC_FFMPEG] ?? 1,
        (d: { stepId: string; type?: string }) => this.dispatchFfmpeg(d),
        () => this.resourceGuard.admitHeavyJob(),
      );
      // mc.render (F2, tarefa 6.5): render Remotion — um navegador por vez, gate
      // do ResourceGuard (CPU/memória), expiração própria (MC_QUEUE_EXPIRE_S).
      await this.queue.subscribe(
        QUEUES.MC_RENDER,
        MC_QUEUE_CONCURRENCY[QUEUES.MC_RENDER] ?? 1,
        (d: { stepId: string }) => this.renderRemotionProcessor.process(d),
        () => this.resourceGuard.admitHeavyJob(),
      );
      // Watchdog de steps órfãos (domain/mc-watchdog.ts): repõe jobs de steps
      // cujo job pg-boss morreu (ex.: retries queimados por recusa do guard).
      this.reconciler.start();
      return;
    }
    // Processo API: sincroniza o catálogo de vozes com a conta ElevenLabs (plano §5.3).
    await this.voices.syncCatalog();
  }

  private async dispatchFfmpeg(d: { stepId: string; type?: string }): Promise<void> {
    let type = d.type;
    if (!type) {
      const step = await this.stepType(d.stepId);
      type = step ?? McStepType.ASSEMBLY;
    }
    if (type === McStepType.SCENE_COMPOSE) return this.sceneComposeProcessor.process(d);
    // Steps de projeto do F1 (D6): compose_ffmpeg → finalize na mesma fila.
    if (type === McStepType.COMPOSE_FFMPEG) return this.composeFfmpegProcessor.process(d);
    if (type === McStepType.FINALIZE) return this.finalizeProcessor.process(d);
    return this.assemblyProcessor.process(d);
  }

  private async stepType(stepId: string): Promise<string | null> {
    const row = await this.dataSource
      .getRepository(McStep)
      .findOne({ where: { id: stepId }, select: ['id', 'type'] });
    return row?.type ?? null;
  }
}
