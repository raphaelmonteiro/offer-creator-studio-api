import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { SendMessageDto } from '../dto/send-message.dto';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import {
  assetNotInScene,
  sceneBusy,
  versionNotCancellable,
  versionNotFound,
} from '../scene.errors';
import { CANCELLED_REPLY } from '../scene-texts';
import { SceneClassification } from '../domain/scene-operation.classifier';
import { publishSceneEvent } from './scene-events';
import { JobPlan, planMessage, ReplyPlan } from './scene-message-planner';
import { addAssistantMessage, settleUserMessage } from './scene-messages';
import {
  assertExpectedRevision,
  assertSceneIdle,
  bumpRevision,
  closeOpenManual,
  nextVersionNumber,
  SceneLockService,
} from './scene-lock.service';

/** Quanto o job da cena pode rodar antes de expirar (a chamada paga tem timeout de 180 s). */
const TURN_EXPIRE_SECONDS = 900;
const BUSY_INDEX = 'UQ_tsv_scene_busy';

export interface SendMessageResult {
  messageId: string;
  versionId: string;
  /** `null` quando a resposta é imediata (sem job): pedir a área, mover item da imagem, confirmar o ajuste geral. */
  jobId: string | null;
  revision: number;
  /** Como o pedido foi classificado (`generate`, `local_edit`, `needs_region`...). */
  operation: SceneClassification['operation'];
  /** Resposta do assistente quando ela já existe na hora do envio. */
  assistantMessage: { id: string; content: string } | null;
}

export interface CancelVersionResult {
  versionId: string;
  status: TemplateSceneVersion['status'];
  cancelRequestedAt: string;
  revision: number;
}

/** Turno do chat: mensagem + versão `queued` + job (mesma transação) e o cancelamento. */
@Injectable()
export class SceneTurnService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly locks: SceneLockService,
    private readonly queue: AnimationQueueService,
  ) {}

  /**
   * Classifica a mensagem por regra (sem modelo) sob o lock da cena e: enfileira o job (versão
   * `queued`, `retryLimit: 0`: chamada paga nunca é repetida pela fila) ou responde na hora, sem job
   * (versão `rejected`, custo 0), nos casos de pedir a área, mover item da imagem e confirmar o
   * ajuste geral.
   */
  async sendMessage(
    sceneId: string,
    dto: SendMessageDto,
    userId: string | null,
  ): Promise<SendMessageResult> {
    try {
      return await this.locks.run(sceneId, async ({ manager, scene }) => {
        assertExpectedRevision(scene, dto.expectedRevision);
        await assertSceneIdle(manager, sceneId);
        await this.assertAttachmentsInScene(manager, sceneId, dto);
        const plan = await planMessage(manager, scene, dto);
        if (plan.kind === 'reply') return this.recordReply(manager, scene, dto, plan, userId);
        await closeOpenManual(manager, sceneId);
        return this.enqueueJob(manager, scene, dto, plan, userId);
      });
    } catch (error) {
      if (isBusyIndexViolation(error)) throw sceneBusy();
      throw error;
    }
  }

  private async saveUserMessage(
    manager: EntityManager,
    scene: TemplateScene,
    versionId: string,
    dto: SendMessageDto,
    status: 'queued' | 'done',
    userId: string | null,
  ): Promise<TemplateSceneMessage> {
    return manager.save(
      manager.create(TemplateSceneMessage, {
        sceneId: scene.id,
        versionId,
        role: 'user',
        content: dto.content,
        attachments: dto.attachments ?? [],
        status,
        createdByUserId: userId,
      }),
    );
  }

  private async enqueueJob(
    manager: EntityManager,
    scene: TemplateScene,
    dto: SendMessageDto,
    plan: JobPlan,
    userId: string | null,
  ): Promise<SendMessageResult> {
    const version = await manager.save(
      manager.create(TemplateSceneVersion, {
        sceneId: scene.id,
        parentVersionId: scene.currentVersionId,
        number: await nextVersionNumber(manager, scene.id),
        operation: plan.operation,
        status: 'queued',
        requestedRegion: plan.requestedRegion,
        requestedMask: plan.requestedMask,
        targetElementId: plan.targetElementId,
        metrics: {
          plan: plan.classification,
          ...(plan.repositionGenerated ? { repositionGenerated: true } : {}),
        },
        correlationId: randomUUID(),
        createdByUserId: userId,
      }),
    );
    const message = await this.saveUserMessage(manager, scene, version.id, dto, 'queued', userId);
    const jobId = await this.queue.publish(
      QUEUES.TEMPLATE_SCENE_TURN,
      { sceneId: scene.id, versionId: version.id },
      { manager, expireInSeconds: TURN_EXPIRE_SECONDS, retryLimit: 0 },
    );
    if (!jobId) throw new Error('A fila não aceitou o job da cena');
    const revision = await bumpRevision(manager, scene);
    await publishSceneEvent(manager, {
      sceneId: scene.id,
      versionId: version.id,
      kind: 'version.step',
      step: null,
      status: 'queued',
      cancelRequested: false,
      costUsd: 0,
      revision,
    });
    return {
      messageId: message.id,
      versionId: version.id,
      jobId,
      revision,
      operation: plan.classification.operation,
      assistantMessage: null,
    };
  }

  /** Resposta imediata: versão `rejected` (custo 0), as duas mensagens do chat e nenhum job. */
  private async recordReply(
    manager: EntityManager,
    scene: TemplateScene,
    dto: SendMessageDto,
    plan: ReplyPlan,
    userId: string | null,
  ): Promise<SendMessageResult> {
    const version = await manager.save(
      manager.create(TemplateSceneVersion, {
        sceneId: scene.id,
        parentVersionId: scene.currentVersionId,
        number: await nextVersionNumber(manager, scene.id),
        operation: plan.operation,
        status: 'rejected',
        metrics: {
          plan: plan.classification,
          ...(plan.pendingConfirmation ? { pendingConfirmation: plan.pendingConfirmation } : {}),
        },
        correlationId: randomUUID(),
        createdByUserId: userId,
      }),
    );
    const message = await this.saveUserMessage(manager, scene, version.id, dto, 'done', userId);
    const assistant = await addAssistantMessage(manager, {
      sceneId: scene.id,
      versionId: version.id,
      content: plan.reply,
      status: 'done',
    });
    const revision = await bumpRevision(manager, scene);
    return {
      messageId: message.id,
      versionId: version.id,
      jobId: null,
      revision,
      operation: plan.classification.operation,
      assistantMessage: { id: assistant.id, content: assistant.content },
    };
  }

  /**
   * Grava `cancelRequestedAt` na hora. Versão `queued` (o worker ainda não pegou) cancela direto;
   * `running` continua assim até o worker parar, para nunca haver duas chamadas pagas ao mesmo
   * tempo. Repetir enquanto em curso responde igual, sem mudar nada. Estado final: 409.
   */
  async cancel(sceneId: string, versionId: string): Promise<CancelVersionResult> {
    return this.locks.run(sceneId, async ({ manager, scene }) => {
      const version = await manager.findOne(TemplateSceneVersion, {
        where: { id: versionId, sceneId },
      });
      if (!version) throw versionNotFound();
      if (version.status !== 'queued' && version.status !== 'running') {
        throw versionNotCancellable(version.status);
      }
      if (!version.cancelRequestedAt) {
        const wasQueued = version.status === 'queued';
        version.cancelRequestedAt = new Date();
        if (wasQueued) await this.cancelQueued(manager, version);
        else await manager.save(version);
        await bumpRevision(manager, scene);
        await publishSceneEvent(manager, {
          sceneId,
          versionId,
          kind: wasQueued ? 'version.cancelled' : 'version.step',
          step: version.step,
          status: version.status,
          cancelRequested: true,
          costUsd: version.providerCostUsd,
          revision: scene.revision,
        });
      }
      return {
        versionId,
        status: version.status,
        cancelRequestedAt: (version.cancelRequestedAt as Date).toISOString(),
        revision: scene.revision,
      };
    });
  }

  private async cancelQueued(manager: EntityManager, version: TemplateSceneVersion): Promise<void> {
    version.status = 'cancelled';
    await manager.save(version);
    await settleUserMessage(manager, version.id, 'failed');
    await addAssistantMessage(manager, {
      sceneId: version.sceneId,
      versionId: version.id,
      content: CANCELLED_REPLY,
      status: 'done',
    });
  }

  /** Anexos só podem ser assets da própria cena. */
  private async assertAttachmentsInScene(
    manager: EntityManager,
    sceneId: string,
    dto: SendMessageDto,
  ): Promise<void> {
    for (const attachment of dto.attachments ?? []) {
      const found = await manager.findOne(TemplateSceneAsset, {
        where: { id: attachment.assetId, sceneId },
      });
      if (!found || found.purgedAt) throw assetNotInScene(attachment.assetId);
    }
  }
}

/** O índice parcial `UQ_tsv_scene_busy` é a rede de segurança de D-3: a violação também é SCENE_BUSY. */
function isBusyIndexViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driver = error.driverError as { code?: string; constraint?: string } | undefined;
  return driver?.code === '23505' && driver.constraint === BUSY_INDEX;
}
