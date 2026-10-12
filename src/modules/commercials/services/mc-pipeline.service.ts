import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { EmailService } from '../../email/email.service';
import { CommercialsService } from '../commercials.service';
import {
  classifyMcError,
  McErrorClass,
  mcErrorCode,
  mcRefundsOnTerminal,
  mcRetryDelayS,
  mcShouldRetry,
} from '../domain/mc-error-classes';
import { isProjectAssemblyStep, projectAssemblySteps } from '../domain/mc-execution-plan';
import { mcExpireForQueue, mcQueueForStep } from '../domain/mc-pipeline.config';
import {
  approvalAuthorizes,
  isPipelineV2,
  McPhase,
  McQualityState,
  resolveQuality,
} from '../domain/mc-quality';
import { preparationComplete, readySteps, sceneFinalStepType } from '../domain/mc-scheduler';
import {
  assertProjectTransition,
  assertStepTransition,
  McProjectStatus,
  McSceneStatus,
  McStepStatus,
} from '../domain/mc-state-machines';
import { McScript, McStepType } from '../domain/mc-types';

/** Submits assíncronos caros (video/lipsync/talk): consomem no SUBMIT, verificável pelo providerJobId. */
export function isSubmitConsumeStep(type: McStepType): boolean {
  return type === McStepType.VIDEO || type === McStepType.LIPSYNC || type === McStepType.TALK;
}
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McMaterializerService } from './mc-materializer.service';

/**
 * Motor de execução do pipeline (plano-comerciais §6.2/§6.4) — o par do
 * mc-scheduler puro: aplica no banco o que o `readySteps` decide, SEMPRE na
 * transação de quem chama (pg-boss é Postgres — enfileirar na mesma transação
 * da conclusão dá atomicidade real). Concentra:
 *
 * - `enqueueReadySteps`: CAS pending→queued + publish + evento por step;
 *   se o assembly destravou, CAS generating→assembling do projeto.
 * - `completeStepAndAdvance`: conclusão CAS de um step + consumo de créditos
 *   + atalhos/ready da cena + avanço do scheduler — TUDO numa transação.
 * - `failStep`: política por classe de erro (§6.4) — retry via fila com
 *   backoff, ou terminal com estorno idempotente do step, cena failed e
 *   projeto needs_attention (quota também emite admin_alert).
 *
 * Consumo de créditos (plano §6.7): o débito real aconteceu na RESERVA
 * (approve); "consumir" aqui é contabilidade em mc_projects.consumedCredits —
 * o que define quanto `refundUnconsumed` devolve num cancel/falha terminal.
 * Steps síncronos baratos consomem no SUCESSO; submits assíncronos caros
 * consomem no SUBMIT (verificável: providerJobId gravado). skipped_cached
 * nunca consome (§6.3: cache não entra na cobrança).
 */
@Injectable()
export class McPipelineService {
  private readonly logger = new Logger(McPipelineService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly transitions: TaskTransitionService,
    private readonly queue: AnimationQueueService,
    private readonly credits: CreditsService,
    private readonly commercials: CommercialsService,
    private readonly email: EmailService,
    private readonly materializer: McMaterializerService,
  ) {}

  // ────────────────────────────── enqueue ──────────────────────────────

  /**
   * Roda o scheduler puro sobre o estado ATUAL (lido no manager da transação)
   * e enfileira os steps desbloqueados. Retorna os ids enfileirados.
   */
  async enqueueReadySteps(manager: EntityManager, projectId: string): Promise<string[]> {
    const project = await manager.findOneByOrFail(McProject, { id: projectId });
    const scenes = await manager.find(McScene, { where: { projectId } });
    const steps = await manager.find(McStep, { where: { projectId } });
    const ready = readySteps(project, scenes, steps);
    const enqueued: string[] = [];

    for (const ref of ready) {
      assertStepTransition(McStepStatus.PENDING, McStepStatus.QUEUED);
      const won = await this.transitions.casTransition(
        manager,
        McStep,
        ref.id,
        McStepStatus.PENDING,
        McStepStatus.QUEUED,
      );
      if (!won) continue; // corrida com outro avanço — o outro enfileirou
      await this.commercials.appendEvent(manager, {
        userId: project.userId,
        refKind: 'step',
        refId: ref.id,
        kind: 'transition',
        fromStatus: McStepStatus.PENDING,
        toStatus: McStepStatus.QUEUED,
        detail: { type: ref.type, projectId },
      });
      const queueName = mcQueueForStep(ref.type);
      await this.queue.publish(
        queueName,
        // `type` viaja no payload para o dispatcher da fila mc.ffmpeg
        // (assembly × scene_compose); consumidores antigos ignoram o campo.
        { stepId: ref.id, projectId, type: ref.type },
        // job na MESMA transação do step (só visível ao worker no commit)
        { expireInSeconds: mcExpireForQueue(queueName), manager },
      );
      enqueued.push(ref.id);
    }

    // O PRIMEIRO step de projeto da fase assembly destravou (assembly no F3;
    // compose_ffmpeg no F1 — D6) ⇒ o projeto entra em montagem
    // (generating → assembling). O finalize nunca é o primeiro.
    const firstAssemblyStep = projectAssemblySteps(project.format)[0];
    if (ready.some((r) => r.type === firstAssemblyStep)) {
      const won = await this.transitions.casTransition(
        manager,
        McProject,
        projectId,
        McProjectStatus.GENERATING,
        McProjectStatus.ASSEMBLING,
      );
      if (won) {
        await this.appendProjectTransition(
          manager,
          project.userId,
          projectId,
          McProjectStatus.GENERATING,
          McProjectStatus.ASSEMBLING,
          {},
        );
      }
    }
    return enqueued;
  }

  // ─────────────────────────── claim (início) ───────────────────────────

  /**
   * Reivindica um step para execução: CAS queued→running (+attempts) com
   * evento+notify e cena pending→running oportunista. Job duplicado/expirado
   * perde o CAS e vira no-op. Step de geração antiga (cena re-rolada com o job
   * ainda na fila) é CANCELADO aqui — nunca gasta provider (plano §6.3).
   * @returns o step fresco reivindicado, ou null (não executar).
   */
  async claimStep(stepId: string, expectedType: McStepType | McStepType[]): Promise<McStep | null> {
    const types = Array.isArray(expectedType) ? expectedType : [expectedType];
    const step = await this.dataSource.getRepository(McStep).findOneBy({ id: stepId });
    if (!step || !types.includes(step.type)) return null;

    return this.dataSource.transaction(async (manager) => {
      // Geração antiga? O scheduler já a ignora; aqui o job enfileirado morre.
      if (step.sceneId) {
        const scene = await manager.findOneBy(McScene, { id: step.sceneId });
        if (scene && step.sceneGeneration !== scene.generation) {
          await this.transitions.casTransition(
            manager,
            McStep,
            stepId,
            McStepStatus.QUEUED,
            McStepStatus.CANCELED,
            { finishedAt: new Date(), errorCode: 'superseded_generation' },
          );
          return null;
        }
      }
      // Pipeline v2 (ADR §4.1): o job só executa se a REVISÃO e a FASE do step
      // ainda forem as do projeto — e produção só com aprovação válida. Jobs
      // atrasados de revisões anteriores morrem aqui, antes de qualquer gasto.
      if (step.projectRevision != null) {
        const projectRow = await manager.findOneByOrFail(McProject, { id: step.projectId });
        const denial = this.v2DenialReason(step, projectRow);
        if (denial) {
          await this.transitions.casTransition(
            manager,
            McStep,
            stepId,
            McStepStatus.QUEUED,
            McStepStatus.CANCELED,
            { finishedAt: new Date(), errorCode: denial },
          );
          await this.commercials.appendEvent(manager, {
            userId: projectRow.userId,
            refKind: 'step',
            refId: stepId,
            kind: 'transition',
            fromStatus: McStepStatus.QUEUED,
            toStatus: McStepStatus.CANCELED,
            detail: { type: step.type, reason: denial, projectRevision: step.projectRevision },
          });
          return null;
        }
      }

      assertStepTransition(McStepStatus.QUEUED, McStepStatus.RUNNING);
      const won = await this.transitions.casTransition(
        manager,
        McStep,
        stepId,
        McStepStatus.QUEUED,
        McStepStatus.RUNNING,
        { startedAt: new Date(), attempts: step.attempts + 1 },
      );
      if (!won) return null;

      const project = await manager.findOneByOrFail(McProject, { id: step.projectId });
      await this.commercials.appendEvent(manager, {
        userId: project.userId,
        refKind: 'step',
        refId: stepId,
        kind: 'transition',
        fromStatus: McStepStatus.QUEUED,
        toStatus: McStepStatus.RUNNING,
        detail: { type: step.type, attempt: step.attempts + 1 },
      });
      await this.notifyStep(manager, project.userId, step, McStepStatus.RUNNING);

      if (step.sceneId) {
        const sceneWon = await this.transitions.casTransition(
          manager,
          McScene,
          step.sceneId,
          McSceneStatus.PENDING,
          McSceneStatus.RUNNING,
        );
        if (sceneWon) {
          await this.commercials.appendEvent(manager, {
            userId: project.userId,
            refKind: 'scene',
            refId: step.sceneId,
            kind: 'transition',
            fromStatus: McSceneStatus.PENDING,
            toStatus: McSceneStatus.RUNNING,
            detail: { stepId },
          });
          await this.transitions.notify(
            manager,
            project.userId,
            {
              kind: 'mc_scene',
              projectId: step.projectId,
              sceneId: step.sceneId,
              status: McSceneStatus.RUNNING,
            },
            MC_EVENTS_CHANNEL,
          );
        }
      }

      step.status = McStepStatus.RUNNING;
      step.attempts += 1;
      step.startedAt = new Date();
      return step;
    });
  }

  // ───────────────────────── conclusão + avanço ─────────────────────────

  /**
   * Conclui um step com sucesso e AVANÇA o scheduler NA MESMA transação
   * (plano §6.2): CAS → succeeded, consumo (quando `consumeOnSuccess`),
   * atalho de asset na cena, cena ready quando o step é o final dela, e
   * enfileiramento dos steps que destravaram. @returns true se venceu o CAS.
   */
  async completeStepAndAdvance(
    manager: EntityManager,
    step: McStep,
    opts: {
      from: McStepStatus;
      outputAssetId?: string | null;
      provider?: string | null;
      providerCostUsd?: number | null;
      /** true = consumo no sucesso (keyframe/tts/assembly, plano §6.7). */
      consumeOnSuccess?: boolean;
    },
  ): Promise<boolean> {
    assertStepTransition(opts.from, McStepStatus.SUCCEEDED);
    const patch: Record<string, unknown> = { finishedAt: new Date() };
    if (opts.outputAssetId !== undefined) patch.outputAssetId = opts.outputAssetId;
    if (opts.provider !== undefined) patch.provider = opts.provider;
    if (opts.providerCostUsd != null) patch.providerCostUsd = opts.providerCostUsd.toFixed(4);
    const won = await this.transitions.casTransition(
      manager,
      McStep,
      step.id,
      opts.from,
      McStepStatus.SUCCEEDED,
      patch,
    );
    if (!won) return false;

    const project = await manager.findOneByOrFail(McProject, { id: step.projectId });
    await this.commercials.appendEvent(manager, {
      userId: project.userId,
      refKind: 'step',
      refId: step.id,
      kind: 'transition',
      fromStatus: opts.from,
      toStatus: McStepStatus.SUCCEEDED,
      detail: { type: step.type, outputAssetId: opts.outputAssetId ?? null },
    });
    if (opts.consumeOnSuccess) {
      await this.consumeStepCredits(manager, project.id, step);
    }
    if (opts.providerCostUsd != null && opts.providerCostUsd > 0) {
      await manager.increment(
        McProject,
        { id: project.id },
        'providerCostUsd',
        opts.providerCostUsd,
      );
    }
    await this.notifyStep(manager, project.userId, step, McStepStatus.SUCCEEDED);

    // Atalhos de asset + cena ready quando este é o step final dela.
    if (step.sceneId) {
      const scene = await manager.findOneByOrFail(McScene, { id: step.sceneId });
      if (step.sceneGeneration === scene.generation) {
        await this.applySceneShortcut(manager, scene, step.type, opts.outputAssetId ?? null);
        // v2: steps de PREPARAÇÃO nunca tornam a cena pronta (ADR §4.1: prévia
        // pronta ≠ vídeo final pronto); só o `final` do plano marca ready.
        const isPreparation = step.phase === 'preparation';
        if (!isPreparation && sceneFinalStepType(scene) === step.type) {
          await this.markSceneReady(manager, project.userId, scene, opts.outputAssetId ?? null);
        }
      }
    }

    // Avanço do scheduler NA TRANSAÇÃO da conclusão (plano §6.2).
    await this.enqueueReadySteps(manager, step.projectId);

    // v2: preparação concluída (sucesso ou cache) ⇒ visual_review + manifesto.
    if (isPipelineV2(project) && project.status === McProjectStatus.PREPARING) {
      await this.completePreparationIfReady(manager, project);
    }
    return true;
  }

  /**
   * Pipeline v2 (ADR §4.1): quando TODAS as cenas vivas têm as prévias do
   * plano concluídas na revisão corrente, CAS preparing → visual_review e o
   * manifesto de preparação é fechado (assets selecionados, hashes, durações
   * medidas). Chamado na transação de conclusão de cada step de preparação e
   * pelo `prepare` quando o cache cobre tudo (nenhum job para esperar).
   */
  async completePreparationIfReady(
    manager: EntityManager,
    project: McProject,
    kitInput?: McCharacterKit,
  ): Promise<boolean> {
    const fresh = await manager.findOneByOrFail(McProject, { id: project.id });
    if (fresh.status !== McProjectStatus.PREPARING) return false;
    const scenes = await manager.find(McScene, {
      where: { projectId: project.id },
      order: { idx: 'ASC' },
    });
    const steps = await manager.find(McStep, { where: { projectId: project.id } });
    if (!preparationComplete(fresh, scenes, steps)) return false;
    const kit = kitInput ?? (await manager.findOneByOrFail(McCharacterKit, { id: fresh.kitId }));
    const quality = resolveQuality(fresh.quality);
    const live = scenes.filter((s) => s.status !== McSceneStatus.CANCELED);
    const manifest = await this.materializer.buildPreparationManifest(
      manager,
      fresh,
      kit,
      fresh.script as McScript,
      live,
      { completed: true, startedAt: quality.preparation?.startedAt },
    );
    const settled = await this.settlePhase(manager, fresh, quality, 'preparation', steps);
    assertProjectTransition(McProjectStatus.PREPARING, McProjectStatus.VISUAL_REVIEW);
    const won = await this.transitions.casTransition(
      manager,
      McProject,
      fresh.id,
      McProjectStatus.PREPARING,
      McProjectStatus.VISUAL_REVIEW,
      { quality: { ...settled, preparation: manifest, resumePhase: null } },
    );
    if (!won) return false;
    await this.appendProjectTransition(
      manager,
      fresh.userId,
      fresh.id,
      McProjectStatus.PREPARING,
      McProjectStatus.VISUAL_REVIEW,
      { revision: fresh.revision, manifestHash: manifest.hash, sceneCount: live.length },
    );
    return true;
  }

  /**
   * Fecha o orçamento de uma fase (v2, ADR §4.3): consumo = o que os steps da
   * fase/revisão efetivamente consumiram; sobra da reserva volta ao usuário
   * pela chave da fase (idempotente). Nunca toca reservas de outras fases.
   */
  async settlePhase(
    manager: EntityManager,
    project: McProject,
    quality: McQualityState,
    phase: McPhase,
    steps: McStep[],
  ): Promise<McQualityState> {
    const budget = quality.budgets.find(
      (b) => b.phase === phase && b.revision === project.revision,
    );
    if (!budget || budget.settledAt) return quality;
    const consumed = steps
      .filter((s) => s.phase === phase && s.projectRevision === project.revision)
      .reduce((sum, s) => sum + this.stepConsumedCreditsFinal(s), 0);
    const bounded = Math.min(consumed, budget.reservedCredits);
    const refunded = await this.credits.refundUnconsumed(
      manager,
      project.userId,
      budget.ledgerKey,
      budget.reservedCredits,
      bounded,
    );
    const others = quality.budgets.filter((b) => b !== budget);
    return {
      ...quality,
      budgets: [
        ...others,
        {
          ...budget,
          consumedCredits: bounded,
          refundedCredits: budget.refundedCredits + refunded,
          settledAt: new Date().toISOString(),
        },
      ],
    };
  }

  /** Créditos que um step consumiu ao longo da vida (síncrono: sucesso; submit: providerJobId). */
  private stepConsumedCreditsFinal(step: McStep): number {
    if (step.status === McStepStatus.SKIPPED_CACHED || step.status === McStepStatus.CANCELED)
      return 0;
    if (isSubmitConsumeStep(step.type)) {
      return step.providerJobId && step.status !== McStepStatus.FAILED ? step.costCredits : 0;
    }
    return step.status === McStepStatus.SUCCEEDED ? step.costCredits : 0;
  }

  /**
   * Motivo para NÃO executar um step v2 (null = autorizado). Mesma regra no
   * claim e imediatamente antes do submit pago (ADR §4.1: "mesmo um job já
   * enfileirado revalida a autorização da revisão antes da submissão paga").
   */
  v2DenialReason(step: McStep, project: McProject): string | null {
    if (step.projectRevision == null) return null;
    if (project.revision !== step.projectRevision) return 'superseded_revision';
    const quality = resolveQuality(project.quality);
    switch (step.phase) {
      case 'preparation':
        return project.status === McProjectStatus.PREPARING ? null : 'phase_mismatch';
      case 'production':
        if (project.status !== McProjectStatus.GENERATING) return 'phase_mismatch';
        return approvalAuthorizes(quality, step.projectRevision, 'production')
          ? null
          : 'approval_missing';
      case 'assembly':
        if (
          project.status !== McProjectStatus.ASSEMBLING &&
          project.status !== McProjectStatus.GENERATING
        ) {
          return 'phase_mismatch';
        }
        return quality.approval && quality.approval.revision === step.projectRevision
          ? null
          : 'approval_missing';
      default:
        return null;
    }
  }

  /**
   * Revalidação imediatamente antes de um submit PAGO (vídeo/lipsync). Se a
   * autorização caiu entre o claim e o submit, o step é cancelado e nada é
   * enviado ao provider. @returns true = pode submeter.
   */
  async assertSubmitAllowed(step: McStep): Promise<boolean> {
    if (step.projectRevision == null) return true;
    const project = await this.dataSource
      .getRepository(McProject)
      .findOneBy({ id: step.projectId });
    if (!project) return false;
    const denial = this.v2DenialReason(step, project);
    if (!denial) return true;
    await this.dataSource.transaction(async (manager) => {
      const won = await this.transitions.casTransition(
        manager,
        McStep,
        step.id,
        McStepStatus.RUNNING,
        McStepStatus.CANCELED,
        { finishedAt: new Date(), errorCode: denial },
      );
      if (!won) return;
      await this.commercials.appendEvent(manager, {
        userId: project.userId,
        refKind: 'step',
        refId: step.id,
        kind: 'submit_denied',
        fromStatus: McStepStatus.RUNNING,
        toStatus: McStepStatus.CANCELED,
        detail: { type: step.type, reason: denial, projectRevision: step.projectRevision },
      });
    });
    this.logger.warn(`Submit do step ${step.id} negado (${denial}) — nenhum gasto realizado.`);
    return false;
  }

  /** Consumo contábil do custo do step (uma vez por step — chamado só por quem vence o CAS). */
  async consumeStepCredits(manager: EntityManager, projectId: string, step: McStep): Promise<void> {
    if (step.costCredits > 0) {
      await manager.increment(McProject, { id: projectId }, 'consumedCredits', step.costCredits);
    }
  }

  // ─────────────────────────── falha por classe ───────────────────────────

  /**
   * Aplica a política de falha (plano §6.4). Chamada FORA de transação (abre a
   * própria). `errorClass` explícito cobre o provider_timeout do poll; sem
   * ele, o erro é classificado (Transient/Terminal/desconhecido).
   *
   * Retry (transient <3 retries; internal <1): CAS →failed → queued + republish
   * na fila do step com backoff — o singletonKey NÃO é usado aqui (job novo).
   *
   * Terminal: estorno IDEMPOTENTE do que o step consumiu (ledger com
   * taskId=stepId; `internal` não estorna — reconciliação admin), cena failed,
   * projeto needs_attention com errorCode; quota emite admin_alert (SEM ligar
   * mc_paused automático — decisão humana).
   */
  async failStep(
    step: McStep,
    from: McStepStatus,
    err: unknown,
    opts: { errorClass?: McErrorClass; fallbackCode?: string } = {},
  ): Promise<void> {
    const errorClass = opts.errorClass ?? classifyMcError(err);
    const message = ((err as Error)?.message ?? 'erro desconhecido').slice(0, 1000);
    const code = mcErrorCode(err, opts.fallbackCode ?? `${step.type}_failed`);
    const fresh = await this.dataSource.getRepository(McStep).findOneBy({ id: step.id });
    if (!fresh) return;
    const executions = fresh.attempts;

    if (mcShouldRetry(errorClass, executions)) {
      await this.retryStep(fresh, from, errorClass, code, message, executions);
      return;
    }

    this.logger.warn(
      `Step ${step.id} (${step.type}) falhou terminal [${errorClass}/${code}]: ${message}`,
    );
    // Marcado DENTRO da transação por quem vence o CAS; o e-mail sai depois
    // dela (SMTP fora de transação — ver sendCompletionEmail).
    let wonNeedsAttention = false;
    await this.dataSource.transaction(async (manager) => {
      const won = await this.transitions.casTransition(
        manager,
        McStep,
        step.id,
        from,
        McStepStatus.FAILED,
        {
          finishedAt: new Date(),
          errorClass,
          errorCode: code,
          errorMessage: message,
        },
      );
      if (!won) return; // outro caminho já resolveu (idempotência)

      const project = await manager.findOneByOrFail(McProject, { id: step.projectId });
      await this.commercials.appendEvent(manager, {
        userId: project.userId,
        refKind: 'step',
        refId: step.id,
        kind: 'transition',
        fromStatus: from,
        toStatus: McStepStatus.FAILED,
        detail: { type: step.type, errorClass, errorCode: code },
      });
      await this.notifyStep(manager, project.userId, step, McStepStatus.FAILED);

      // Estorno IDEMPOTENTE do step (plano §6.4): devolve o que o step
      // CONSUMIU (submit assíncrono com providerJobId gravado = consumiu;
      // síncrono só consome no sucesso — falhou, não consumiu nada).
      // refundUnconsumed com taskId=step.id é no-op na segunda chamada.
      if (mcRefundsOnTerminal(errorClass)) {
        const consumed = this.stepConsumedCredits(fresh);
        if (consumed > 0) {
          await this.credits.refundUnconsumed(manager, project.userId, step.id, consumed, 0);
        }
      }

      if (errorClass === 'quota') {
        // Plano §6.4: quota NÃO liga mc_paused sozinho — só alerta o admin.
        await this.commercials.appendEvent(manager, {
          userId: project.userId,
          refKind: 'project',
          refId: project.id,
          kind: 'admin_alert',
          detail: { errorClass, stepId: step.id, message: message.slice(0, 300) },
        });
        await this.transitions.notify(
          manager,
          project.userId,
          { kind: 'mc_admin_alert', projectId: project.id, errorClass },
          MC_EVENTS_CHANNEL,
        );
      }

      if (isProjectAssemblyStep(step.type) && isPipelineV2(project)) {
        // v2 (ADR §4.1): falha recuperável da montagem (assembly, ou
        // compose_ffmpeg/finalize do F1 — D6) pausa em needs_attention com
        // fase de retomada persistida — clipes aprovados e reservas ficam.
        const wonProject = await this.transitions.casTransition(
          manager,
          McProject,
          project.id,
          McProjectStatus.ASSEMBLING,
          McProjectStatus.NEEDS_ATTENTION,
          {
            errorCode: code,
            errorMessage: message.slice(0, 300),
            quality: { ...resolveQuality(project.quality), resumePhase: 'assembly' },
          },
        );
        if (wonProject) {
          wonNeedsAttention = true;
          await this.appendProjectTransition(
            manager,
            project.userId,
            project.id,
            McProjectStatus.ASSEMBLING,
            McProjectStatus.NEEDS_ATTENTION,
            { errorCode: code, stepId: step.id, resumePhase: 'assembly' },
          );
        }
        return;
      }

      if (step.type === McStepType.ASSEMBLY) {
        // Assembly não tem cena: a falha terminal dele derruba o projeto
        // (assembling → failed, matriz §6.1) com estorno do NÃO consumido —
        // mesmo desenho da falha terminal do script (o usuário não recebeu).
        const wonProject = await this.transitions.casTransition(
          manager,
          McProject,
          project.id,
          McProjectStatus.ASSEMBLING,
          McProjectStatus.FAILED,
          { errorCode: code, errorMessage: message.slice(0, 300), finishedAt: new Date() },
        );
        if (wonProject) {
          await this.credits.refundUnconsumed(
            manager,
            project.userId,
            project.id,
            project.reservedCredits,
            project.consumedCredits,
          );
          await this.appendProjectTransition(
            manager,
            project.userId,
            project.id,
            McProjectStatus.ASSEMBLING,
            McProjectStatus.FAILED,
            { errorCode: code, stepId: step.id },
          );
        }
        return;
      }

      // Cena failed (com erro acionável) + projeto em needs_attention —
      // a falha de UMA cena não derruba o comercial inteiro (plano §6.4).
      if (step.sceneId) {
        const scene = await manager.findOneByOrFail(McScene, { id: step.sceneId });
        if (step.sceneGeneration === scene.generation) {
          await this.transitions.casTransition(
            manager,
            McScene,
            scene.id,
            McSceneStatus.PENDING,
            McSceneStatus.RUNNING,
          );
          const wonScene = await this.transitions.casTransition(
            manager,
            McScene,
            scene.id,
            McSceneStatus.RUNNING,
            McSceneStatus.FAILED,
            { errorCode: code, errorMessage: message.slice(0, 300) },
          );
          if (wonScene) {
            await this.commercials.appendEvent(manager, {
              userId: project.userId,
              refKind: 'scene',
              refId: scene.id,
              kind: 'transition',
              fromStatus: McSceneStatus.RUNNING,
              toStatus: McSceneStatus.FAILED,
              detail: { stepId: step.id, errorClass, errorCode: code },
            });
            await this.transitions.notify(
              manager,
              project.userId,
              {
                kind: 'mc_scene',
                projectId: project.id,
                sceneId: scene.id,
                status: McSceneStatus.FAILED,
                errorCode: code,
              },
              MC_EVENTS_CHANNEL,
            );
          }
        }
      }
      // v2: a fase em que a falha ocorreu fica persistida para a retomada
      // (preparação volta à preparação; produção à produção — ADR §4.1).
      const fromStatus =
        isPipelineV2(project) && project.status === McProjectStatus.PREPARING
          ? McProjectStatus.PREPARING
          : McProjectStatus.GENERATING;
      const resumePhase: McPhase =
        fromStatus === McProjectStatus.PREPARING ? 'preparation' : 'production';
      const patch: Record<string, unknown> = { errorCode: code };
      if (isPipelineV2(project)) {
        patch.quality = { ...resolveQuality(project.quality), resumePhase };
      }
      const wonProject = await this.transitions.casTransition(
        manager,
        McProject,
        project.id,
        fromStatus,
        McProjectStatus.NEEDS_ATTENTION,
        patch,
      );
      if (wonProject) {
        wonNeedsAttention = true;
        await this.appendProjectTransition(
          manager,
          project.userId,
          project.id,
          fromStatus,
          McProjectStatus.NEEDS_ATTENTION,
          { errorCode: code, stepId: step.id, ...(isPipelineV2(project) ? { resumePhase } : {}) },
        );
      }
    });

    if (wonNeedsAttention) {
      await this.sendCompletionEmail(step.projectId, McProjectStatus.NEEDS_ATTENTION);
    }
  }

  /** Retry via fila (failed → queued + republish com backoff, plano §6.4). */
  private async retryStep(
    step: McStep,
    from: McStepStatus,
    errorClass: McErrorClass,
    code: string,
    message: string,
    executions: number,
  ): Promise<void> {
    const delayS = mcRetryDelayS(executions);
    this.logger.warn(
      `Step ${step.id} (${step.type}) falhou [${errorClass}] na execução ${executions} — ` +
        `retry em ${delayS}s: ${message.slice(0, 200)}`,
    );
    await this.dataSource.transaction(async (manager) => {
      const won = await this.transitions.casTransition(
        manager,
        McStep,
        step.id,
        from,
        McStepStatus.FAILED,
        {
          errorClass,
          errorCode: code,
          errorMessage: message,
          // qualidade (texto inventado): o job antigo do provider é DESCARTADO —
          // sem isto o submit re-entrante viraria poll do mesmo vídeo reprovado.
          ...(errorClass === 'quality' ? { providerJobId: null, provider: null } : {}),
        },
      );
      if (!won) return;
      const project = await manager.findOneByOrFail(McProject, { id: step.projectId });
      await this.commercials.appendEvent(manager, {
        userId: project.userId,
        refKind: 'step',
        refId: step.id,
        kind: 'retry_scheduled',
        fromStatus: from,
        toStatus: McStepStatus.QUEUED,
        detail: { type: step.type, errorClass, delayS, execution: executions },
      });
      assertStepTransition(McStepStatus.FAILED, McStepStatus.QUEUED);
      await this.transitions.casTransition(
        manager,
        McStep,
        step.id,
        McStepStatus.FAILED,
        McStepStatus.QUEUED,
      );
      const queueName = mcQueueForStep(step.type);
      await this.queue.publish(
        queueName,
        { stepId: step.id, projectId: step.projectId },
        { startAfterSeconds: delayS, expireInSeconds: mcExpireForQueue(queueName), manager },
      );
    });
  }

  // ─────────────────────────────── apoio ───────────────────────────────

  /**
   * Créditos que o step JÁ CONSUMIU — derivado do próprio registro, sem coluna
   * nova: submits assíncronos (video/lipsync) consomem no submit, verificável
   * pelo providerJobId gravado; os síncronos consomem no sucesso (um step que
   * falhou nunca consumiu).
   */
  stepConsumedCredits(step: McStep): number {
    return isSubmitConsumeStep(step.type) && step.providerJobId ? step.costCredits : 0;
  }

  private async applySceneShortcut(
    manager: EntityManager,
    scene: McScene,
    type: McStepType,
    assetId: string | null,
  ): Promise<void> {
    if (!assetId) return;
    const patch: Partial<McScene> = {};
    if (type === McStepType.KEYFRAME) patch.keyframeAssetId = assetId;
    if (type === McStepType.TTS) patch.audioAssetId = assetId;
    if (type === McStepType.VIDEO) patch.videoAssetId = assetId;
    if (Object.keys(patch).length > 0) {
      await manager.update(McScene, { id: scene.id }, patch);
    }
  }

  /** Cena ganhou o final: (pending→)running→ready com finalAssetId (plano §6.2). */
  private async markSceneReady(
    manager: EntityManager,
    userId: string,
    scene: McScene,
    finalAssetId: string | null,
  ): Promise<void> {
    // Defesa: cena deixada em `failed` (falha antiga da MESMA geração) cujo
    // step final acabou de suceder — o sucesso do final é a prova de que ela
    // está pronta; re-arma (failed → pending, transição de correção) em vez
    // de deixá-la presa e a montagem cancelar por `composition_changed`.
    if (scene.status === McSceneStatus.FAILED) {
      const rearmed = await this.transitions.casTransition(
        manager,
        McScene,
        scene.id,
        McSceneStatus.FAILED,
        McSceneStatus.PENDING,
        { errorCode: null, errorMessage: null },
      );
      if (rearmed) {
        this.logger.warn(
          `Cena ${scene.id} estava 'failed' com o step final concluído — re-armada para ficar pronta.`,
        );
      }
    }
    await this.transitions.casTransition(
      manager,
      McScene,
      scene.id,
      McSceneStatus.PENDING,
      McSceneStatus.RUNNING,
    );
    const won = await this.transitions.casTransition(
      manager,
      McScene,
      scene.id,
      McSceneStatus.RUNNING,
      McSceneStatus.READY,
      { finalAssetId, errorCode: null, errorMessage: null },
    );
    if (!won) return;
    await this.commercials.appendEvent(manager, {
      userId,
      refKind: 'scene',
      refId: scene.id,
      kind: 'transition',
      fromStatus: McSceneStatus.RUNNING,
      toStatus: McSceneStatus.READY,
      detail: { finalAssetId },
    });
    await this.transitions.notify(
      manager,
      userId,
      {
        kind: 'mc_scene',
        projectId: scene.projectId,
        sceneId: scene.id,
        status: McSceneStatus.READY,
      },
      MC_EVENTS_CHANNEL,
    );
  }

  /**
   * Projeto entregue: assembling → succeeded.
   * - LEGADO: consumo integral da reserva (preço fechado por cena, plano §8).
   * - V2 (ADR §4.3): preço fechado POR FASE — cada fase é liquidada pela sua
   *   chave; a entrega nunca "consome de novo" reservas históricas nem cobra
   *   por itens reaproveitados do cache. `extra.quality` traz timeline/entrega.
   */
  async succeedProject(
    manager: EntityManager,
    projectId: string,
    finalAssetId: string,
    extra: { quality?: McQualityState } = {},
  ): Promise<boolean> {
    const project = await manager.findOneByOrFail(McProject, { id: projectId });
    const patch: Record<string, unknown> = {
      finalAssetId,
      finishedAt: new Date(),
      errorCode: null,
      errorMessage: null,
    };
    if (isPipelineV2(project)) {
      const steps = await manager.find(McStep, { where: { projectId } });
      let quality = extra.quality ?? resolveQuality(project.quality);
      quality = await this.settlePhase(manager, project, quality, 'production', steps);
      quality = await this.settlePhase(manager, project, quality, 'assembly', steps);
      patch.quality = { ...quality, resumePhase: null, pendingScope: null };
    } else {
      // ENTREGA CONSOME A RESERVA INTEGRAL (preço fechado por cena, plano
      // §8): garante que um re-roll pós-entrega seguido de cancel não
      // "devolva" créditos de um comercial já entregue. Antes da entrega,
      // cancel/falha estornam o não-consumido normalmente.
      patch.consumedCredits = Math.max(project.reservedCredits, project.consumedCredits);
    }
    const won = await this.transitions.casTransition(
      manager,
      McProject,
      projectId,
      McProjectStatus.ASSEMBLING,
      McProjectStatus.SUCCEEDED,
      patch,
    );
    if (!won) return false;
    await this.appendProjectTransition(
      manager,
      project.userId,
      projectId,
      McProjectStatus.ASSEMBLING,
      McProjectStatus.SUCCEEDED,
      { finalAssetId },
    );
    return true;
  }

  /**
   * E-mail de conclusão (plano §10 v1: "e-mail de conclusão"; §7.2 "pode sair —
   * e-mail/badge"): avisa quando o projeto chega a `succeeded` ou
   * `needs_attention`.
   *
   * NUNCA bloqueia o pipeline: chamada FORA da transação (SMTP lento não
   * segura lock) e com try/catch total — falha de SMTP vira warn no log e o
   * comercial segue entregue. Só é chamada por quem VENCEU o CAS da
   * transição, então não há e-mail duplicado por job repetido.
   */
  async sendCompletionEmail(projectId: string, status: McProjectStatus): Promise<void> {
    try {
      const project = await this.dataSource.getRepository(McProject).findOneBy({ id: projectId });
      if (!project) return;
      const rows = (await this.dataSource.query(
        'SELECT "email", "name" FROM "users" WHERE "id" = $1 LIMIT 1',
        [project.userId],
      )) as Array<{ email?: string; name?: string }>;
      const email = rows?.[0]?.email;
      if (!email) return;
      await this.email.sendCommercialFinished({
        email,
        name: rows[0]?.name ?? '',
        projectId: project.id,
        title: project.title,
        status,
      });
    } catch (err) {
      this.logger.warn(
        `E-mail de conclusão do projeto ${projectId} não saiu: ${(err as Error).message}`,
      );
    }
  }

  async appendProjectTransition(
    manager: EntityManager,
    userId: string,
    projectId: string,
    from: McProjectStatus,
    to: McProjectStatus,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.commercials.appendEvent(manager, {
      userId,
      refKind: 'project',
      refId: projectId,
      kind: 'transition',
      fromStatus: from,
      toStatus: to,
      detail,
    });
    await this.transitions.notify(
      manager,
      userId,
      { kind: 'mc_project', projectId, status: to },
      MC_EVENTS_CHANNEL,
    );
  }

  async notifyStep(
    manager: EntityManager,
    userId: string,
    step: McStep,
    status: McStepStatus,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.transitions.notify(
      manager,
      userId,
      {
        kind: 'mc_step',
        projectId: step.projectId,
        sceneId: step.sceneId,
        stepId: step.id,
        type: step.type,
        status,
        ...extra,
      },
      MC_EVENTS_CHANNEL,
    );
  }

  /** Cancela em lote steps que ainda não executam (pending/queued) — usado pelo cancel/re-roll. */
  async cancelIdleSteps(
    manager: EntityManager,
    projectId: string,
    sceneId?: string,
  ): Promise<number> {
    const where: Record<string, unknown> = {
      projectId,
      status: In([McStepStatus.PENDING, McStepStatus.QUEUED]),
    };
    if (sceneId) where.sceneId = sceneId;
    const result = await manager.update(McStep, where, {
      status: McStepStatus.CANCELED,
      finishedAt: new Date(),
    });
    return result.affected ?? 0;
  }
}
