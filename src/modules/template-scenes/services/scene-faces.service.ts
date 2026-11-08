import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { DERIVE_BACK_MESSAGE } from '../scene-texts';
import { sceneBusy } from '../scene.errors';
import { assertDerivable, loadFrontAndBack } from './scene-derive-face';
import {
  assertExpectedRevision,
  assertSceneIdle,
  bumpRevision,
  nextVersionNumber,
  SceneLockService,
} from './scene-lock.service';
import { isBusyIndexViolation, publishQueued } from './scene-turn-helpers';
import { TURN_EXPIRE_SECONDS } from './scene-turn.service';

/** Resposta do `POST .../faces/back/derive` (202): a mensagem, a versão e o job existem antes de o worker chamar a imagem. */
export interface DeriveBackResult {
  messageId: string;
  versionId: string;
  jobId: string;
  revision: number;
}

/**
 * "Fazer o verso" pelo botão (D-3, PV-13): sinal estruturado, sem passar pelo Diretor. Sob a trava da cena confere,
 * nesta ordem, a face `back`, a `revision`, a cena ocupada, a frente pronta e o verso vazio; grava a mensagem "Fazer o
 * verso" e a versão `derive_face` e publica o job na mesma transação. Clique duplo: um 202 e um 409.
 */
@Injectable()
export class SceneFacesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly locks: SceneLockService,
    private readonly queue: AnimationQueueService,
  ) {}

  async deriveBack(
    sceneId: string,
    expectedRevision: number,
    userId: string | null,
  ): Promise<DeriveBackResult> {
    try {
      return await this.locks.run(sceneId, async ({ manager, scene }) => {
        const faces = await loadFrontAndBack(manager, sceneId);
        assertExpectedRevision(scene, expectedRevision);
        await assertSceneIdle(manager, sceneId);
        const front = await assertDerivable(manager, faces);
        const version = await manager.save(
          manager.create(TemplateSceneVersion, {
            sceneId,
            faceIndex: faces.back.index,
            parentVersionId: null,
            derivedFromVersionId: front.id,
            number: await nextVersionNumber(manager, sceneId),
            operation: 'derive_face',
            status: 'queued',
            step: null,
            elements: [],
            metrics: {},
            correlationId: randomUUID(),
            createdByUserId: userId,
          }),
        );
        const message = await manager.save(
          manager.create(TemplateSceneMessage, {
            sceneId,
            versionId: version.id,
            faceIndex: faces.back.index,
            role: 'user',
            content: DERIVE_BACK_MESSAGE,
            status: 'queued',
            createdByUserId: userId,
          }),
        );
        const jobId = await this.queue.publish(
          QUEUES.TEMPLATE_SCENE_TURN,
          { sceneId, versionId: version.id, kind: 'derive_face' },
          { manager, expireInSeconds: TURN_EXPIRE_SECONDS, retryLimit: 0 },
        );
        if (!jobId) throw new Error('A fila não aceitou o job do verso');
        const revision = await bumpRevision(manager, scene);
        await publishQueued(manager, {
          sceneId,
          versionId: version.id,
          faceKey: faces.back.key,
          revision,
          step: null,
        });
        return { messageId: message.id, versionId: version.id, jobId, revision };
      });
    } catch (error) {
      if (isBusyIndexViolation(error)) throw sceneBusy();
      throw error;
    }
  }
}
