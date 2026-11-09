import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { REFERENCE_LIMITS, ReferenceRead } from '../domain/scene-reference.types';
import { openReferenceItems, referencePlan } from '../domain/scene-reference-plan';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import {
  invalidBody,
  referenceNotProposed,
  referenceOnlyAtStart,
  referenceReviseLimit,
  sceneBusy,
} from '../scene.errors';
import { REFERENCE_TEXTS } from '../scene-texts';
import { resolveFace, faceHasImage } from './scene-faces';
import { SceneFilesService } from './scene-files.service';
import {
  assertExpectedRevision,
  assertSceneIdle,
  SceneLockContext,
  SceneLockService,
} from './scene-lock.service';
import { inspectReference, InspectedReference } from './scene-reference-file';
import {
  canRetryFrom,
  discardProposed,
  latestRead,
  patchReference,
  readOf,
  revisionsDone,
} from './scene-reference-state';
import {
  enqueueReferenceTurn,
  ReferenceTurnInput,
  ReferenceTurnResult,
} from './scene-reference-turn';
import { isBusyIndexViolation } from './scene-turn-helpers';

type UploadedFile = Parameters<typeof inspectReference>[0];

/** `expectedRevision` do formulário multipart chega como texto: inteiro >= 0 ou 400. */
function parseRevision(value: unknown): number {
  const revision = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(revision)) throw invalidBody('expectedRevision deve ser um inteiro >= 0.');
  return revision;
}

/**
 * As rotas da referência de encarte (change add-template-scene-from-reference). Cada uma roda sob o lock da cena, na
 * ordem de sempre (cena, revisão, cena ocupada, regra própria), e grava mensagem, versão e job na mesma transação.
 * Clique duplo e duas abas: um 202 e um 409. A chamada de visão e a de imagem são do worker.
 */
@Injectable()
export class SceneReferenceService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly locks: SceneLockService,
    private readonly queue: AnimationQueueService,
    private readonly files: SceneFilesService,
  ) {}

  /** Envia o encarte: confere o arquivo, guarda só a cópia reduzida e abre a leitura. */
  async upload(
    sceneId: string,
    file: UploadedFile,
    input: { expectedRevision: unknown; userId: string | null },
  ): Promise<ReferenceTurnResult> {
    const inspected = await inspectReference(file);
    const versionId = randomUUID();
    const assetId = randomUUID();
    const url = (
      await this.files.write(
        sceneId,
        versionId,
        `reference-${assetId}.jpg`,
        inspected.reduced.buffer,
      )
    ).url;
    try {
      return await this.guarded(sceneId, async ({ manager, scene }) => {
        const face = await resolveFace(manager, scene);
        assertExpectedRevision(scene, parseRevision(input.expectedRevision));
        await assertSceneIdle(manager, sceneId);
        if (await faceHasImage(manager, sceneId, face.index)) throw referenceOnlyAtStart();
        await discardProposed(manager, sceneId);
        const reference = this.newRead(assetId, inspected, input.userId);
        const result = await this.enqueue(manager, scene, {
          operation: 'read_reference',
          content: REFERENCE_TEXTS.uploaded(inspected.origin.fileName),
          attachments: [{ assetId, name: inspected.origin.fileName }],
          metrics: { reference },
          face,
          userId: input.userId,
          versionId,
        });
        await this.insertAsset(manager, { sceneId, versionId, assetId, url, inspected });
        return result;
      });
    } catch (error) {
      await this.files.remove(url).catch(() => undefined);
      throw error;
    }
  }

  /** Corrige a ficha proposta (D-3): nova leitura do mesmo encarte com o pedido do cliente, no máximo 5 vezes. */
  async revise(
    sceneId: string,
    input: { expectedRevision: number; note: string; userId: string | null },
  ): Promise<ReferenceTurnResult> {
    return this.guarded(sceneId, async ({ manager, scene }) => {
      const face = await resolveFace(manager, scene);
      assertExpectedRevision(scene, input.expectedRevision);
      await assertSceneIdle(manager, sceneId);
      const previous = await latestRead(manager, sceneId);
      const read = previous && readOf(previous);
      if (!previous || !read || read.state !== 'proposed') throw referenceNotProposed();
      if ((await revisionsDone(manager, sceneId, read.assetId)) >= REFERENCE_LIMITS.maxRevisions) {
        throw referenceReviseLimit(REFERENCE_LIMITS.maxRevisions);
      }
      patchReference(previous, { state: 'discarded' });
      await manager.save(previous);
      const reference: ReferenceRead = {
        state: 'reading',
        assetId: read.assetId,
        origin: read.origin,
        note: input.note,
        correctionOf: previous.id,
      };
      return this.enqueue(manager, scene, {
        operation: 'read_reference',
        content: input.note,
        metrics: { reference },
        face,
        userId: input.userId,
      });
    });
  }

  /** "Gerar assim" (e, pela D-4, "Tentar de novo com o encarte"): a versão `generate` com o plano do código. */
  async generate(
    sceneId: string,
    input: { expectedRevision: number; userId: string | null },
  ): Promise<ReferenceTurnResult> {
    return this.guarded(sceneId, async ({ manager, scene }) => {
      const face = await resolveFace(manager, scene);
      assertExpectedRevision(scene, input.expectedRevision);
      await assertSceneIdle(manager, sceneId);
      const read = await latestRead(manager, sceneId);
      const state = read && readOf(read);
      const retry = Boolean(read && state?.state === 'used' && (await canRetryFrom(manager, read)));
      if (!read || !state?.concept || !state.summary || (state.state !== 'proposed' && !retry)) {
        throw referenceNotProposed();
      }
      const { concept, summary } = state;
      const result = await this.enqueue(manager, scene, {
        operation: 'generate',
        content: retry ? REFERENCE_TEXTS.retry : REFERENCE_TEXTS.confirm,
        metrics: {
          plan: referencePlan(concept),
          referenceReadVersionId: read.id,
          referenceFrom: retry ? 'used' : 'proposed',
        },
        face,
        userId: input.userId,
        onMessage: (messageId) => {
          scene.brief = openReferenceItems(scene.brief ?? [], {
            summary,
            messageId,
            now: new Date(),
          });
        },
      });
      patchReference(read, {
        state: 'used',
        usedByVersionIds: [...(state.usedByVersionIds ?? []), result.versionId],
      });
      await manager.save(read);
      return result;
    });
  }

  private newRead(
    assetId: string,
    inspected: InspectedReference,
    userId: string | null,
  ): ReferenceRead {
    return {
      state: 'reading',
      assetId,
      origin: {
        ...inspected.origin,
        uploadedByUserId: userId,
        uploadedAt: new Date().toISOString(),
      },
    };
  }

  private enqueue(
    manager: EntityManager,
    scene: TemplateScene,
    input: Omit<ReferenceTurnInput, 'face'> & { face: TemplateSceneFace },
  ): Promise<ReferenceTurnResult> {
    const { face } = input;
    return enqueueReferenceTurn(
      manager,
      { scene, queue: this.queue },
      {
        ...input,
        face: { index: face.index, key: face.key, currentVersionId: face.currentVersionId },
      },
    );
  }

  private async insertAsset(
    manager: EntityManager,
    input: {
      sceneId: string;
      versionId: string;
      assetId: string;
      url: string;
      inspected: InspectedReference;
    },
  ): Promise<void> {
    const { reduced } = input.inspected;
    await manager.insert(TemplateSceneAsset, {
      id: input.assetId,
      versionId: input.versionId,
      sceneId: input.sceneId,
      role: 'reference',
      url: input.url,
      width: reduced.width,
      height: reduced.height,
      bytes: reduced.buffer.length,
      expiresAt: null,
    });
  }

  /** O lock da cena, com o índice de "uma versão em curso" traduzido para `SCENE_BUSY`. */
  private async guarded<T>(
    sceneId: string,
    fn: (context: SceneLockContext) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.locks.run(sceneId, fn);
    } catch (error) {
      if (isBusyIndexViolation(error)) throw sceneBusy();
      throw error;
    }
  }
}
