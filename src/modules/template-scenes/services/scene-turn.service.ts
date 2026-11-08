import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { SendMessageDto } from '../dto/send-message.dto';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
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
import { publishSceneEvent } from './scene-events';
import { faceKeyOfVersion, resolveFace } from './scene-faces';
import { isBusyIndexViolation, publishQueued, TurnInput } from './scene-turn-helpers';
import {
  assertShapeBigEnough,
  assertSingleTarget,
  assertTargetElementExists,
  requestedTargetOf,
} from './scene-message-target';
import { addAssistantMessage, settleUserMessage } from './scene-messages';
import { closeTurnBrief } from './scene-turn-brief';
import {
  assertExpectedRevision,
  assertSceneIdle,
  bumpRevision,
  closeOpenManual,
  nextVersionNumber,
  SceneLockService,
} from './scene-lock.service';

/** Quanto o job da imagem pode rodar antes de expirar (a chamada paga tem timeout de 180 s). */
export const TURN_EXPIRE_SECONDS = 900;
/** Quanto o job do Diretor pode rodar: o teto do Diretor é 20 s, e o plano é refeito no máximo uma vez. */
const DIRECTOR_EXPIRE_SECONDS = 180;

/** Resposta do `POST .../messages` (202): a mensagem e a versão existem antes de o Diretor ler. */
export interface SendMessageResult {
  messageId: string;
  versionId: string;
  /** Sempre presente: toda mensagem vira um job do Diretor. */
  jobId: string;
  revision: number;
}

export interface CancelVersionResult {
  versionId: string;
  status: TemplateSceneVersion['status'];
  cancelRequestedAt: string;
  revision: number;
}

/** Turno do chat: mensagem + versão `queued` (lendo) + job do Diretor (mesma transação) e o cancelamento. */
@Injectable()
export class SceneTurnService {
  private readonly logger = new Logger(SceneTurnService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly locks: SceneLockService,
    private readonly queue: AnimationQueueService,
  ) {}

  /**
   * Sob o lock da cena: confere revisão, cena ocupada, corpo e anexos, e então grava a mensagem do cliente, a
   * versão `queued` no step `reading` e o job do Diretor na MESMA transação (`retryLimit: 0`). Responde 202
   * sem esperar o Diretor: fechar a aba não perde a mensagem, e o índice `UQ_tsv_scene_busy` garante um só turno,
   * inclusive durante a leitura. Duas abas com a mesma revisão: uma recebe 202 e a outra 409, e o Diretor é
   * chamado uma só vez.
   */
  async sendMessage(
    sceneId: string,
    dto: SendMessageDto,
    userId: string | null,
  ): Promise<SendMessageResult> {
    try {
      return await this.locks.run(sceneId, async ({ manager, scene }) => {
        const face = await resolveFace(manager, scene, dto.face); // 422 `FACE_NOT_FOUND`, nada gravado
        assertExpectedRevision(scene, dto.expectedRevision);
        await assertSceneIdle(manager, sceneId);
        assertSingleTarget(dto); // 400 antes de qualquer consulta: o corpo inválido vence o 422 do anexo
        await this.assertAttachmentsInScene(manager, sceneId, dto);
        const hasImage = await manager.exists(TemplateSceneVersion, {
          where: { sceneId, faceIndex: face.index, status: 'ready' },
        });
        if (hasImage) {
          await assertShapeBigEnough(dto, scene);
          await assertTargetElementExists(manager, face, dto);
        }
        await closeOpenManual(manager, sceneId, face.index);
        return this.enqueueReading(manager, scene, { dto, userId }, { hasImage, face });
      });
    } catch (error) {
      if (isBusyIndexViolation(error)) throw sceneBusy();
      throw error;
    }
  }

  private async enqueueReading(
    manager: EntityManager,
    scene: TemplateScene,
    input: TurnInput,
    target: { hasImage: boolean; face: TemplateSceneFace },
  ): Promise<SendMessageResult> {
    const { dto, userId } = input;
    const { hasImage, face } = target;
    const version = await manager.save(
      manager.create(TemplateSceneVersion, {
        sceneId: scene.id,
        faceIndex: face.index,
        parentVersionId: face.currentVersionId,
        number: await nextVersionNumber(manager, scene.id),
        // Operação inicial; o consumer do Diretor a troca para `set_layer`, `restore` ou `generate` quando é o caso.
        operation: hasImage ? 'redraw' : 'generate',
        status: 'queued',
        step: 'reading',
        ...requestedTargetOf(dto, scene, face),
        metrics: {},
        correlationId: randomUUID(),
        createdByUserId: userId,
      }),
    );
    const message = await manager.save(
      manager.create(TemplateSceneMessage, {
        sceneId: scene.id,
        versionId: version.id,
        faceIndex: face.index,
        role: 'user',
        content: dto.content,
        attachments: dto.attachments ?? [],
        status: 'queued',
        createdByUserId: userId,
      }),
    );
    const jobId = await this.queue.publish(
      QUEUES.TEMPLATE_SCENE_DIRECTOR,
      { sceneId: scene.id, versionId: version.id },
      { manager, expireInSeconds: DIRECTOR_EXPIRE_SECONDS, retryLimit: 0 },
    );
    if (!jobId) throw new Error('A fila não aceitou o job do Diretor');
    const revision = await bumpRevision(manager, scene);
    await publishQueued(manager, {
      sceneId: scene.id,
      versionId: version.id,
      faceKey: face.key,
      revision,
      step: 'reading',
    });
    return { messageId: message.id, versionId: version.id, jobId, revision };
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
        if (wasQueued) await this.cancelQueued(manager, scene, version);
        else await manager.save(version);
        await bumpRevision(manager, scene);
        await publishSceneEvent(manager, {
          sceneId,
          versionId,
          faceKey: faceKeyOfVersion(scene, version),
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

  private async cancelQueued(
    manager: EntityManager,
    scene: TemplateScene,
    version: TemplateSceneVersion,
  ): Promise<void> {
    version.status = 'cancelled';
    // Parar na janela fecha o pedido do turno e o que sobrou do anterior (D-59).
    await closeTurnBrief(manager, scene, version, { stopped: true });
    await manager.save(version);
    await settleUserMessage(manager, version.id, 'failed');
    await addAssistantMessage(manager, {
      sceneId: version.sceneId,
      versionId: version.id,
      content: CANCELLED_REPLY,
      status: 'done',
    });
  }

  /** Anexos só podem ser logos já enviados à própria cena (outro papel é `ASSET_NOT_IN_SCENE`). */
  private async assertAttachmentsInScene(
    manager: EntityManager,
    sceneId: string,
    dto: SendMessageDto,
  ): Promise<void> {
    for (const attachment of dto.attachments ?? []) {
      const found = await manager.findOne(TemplateSceneAsset, {
        where: { id: attachment.assetId, sceneId, role: 'logo' },
      });
      if (!found || found.purgedAt) throw assetNotInScene(attachment.assetId);
    }
  }
}
