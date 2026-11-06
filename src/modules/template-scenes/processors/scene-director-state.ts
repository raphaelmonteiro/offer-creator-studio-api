import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { applyDirectorRequests, BriefChanges, openItems } from '../domain/scene-brief';
import { layerOpsToActions } from '../domain/scene-director-layers';
import { DirectorLayerOp, DirectorPlan } from '../domain/scene-director-schema';
import { sceneZonesFor } from '../domain/scene-formats';
import { decideTurn, TurnDecision } from '../domain/scene-director-decision';
import { SceneFailureCode } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import {
  askedAboutImageReply,
  compositionQuestion,
  currentVersionReply,
  layerReply,
  MARKING_DISCARDED_NOTE,
  PAINTED_REFUSAL_REPLIES,
  REDRAW_NOTICE,
  versionRestoredReply,
} from '../scene-texts';
import { DirectorContext } from '../services/scene-director-context';
import { displayNumbersOf } from '../services/scene-display-number';
import { bumpRevision, SceneLockService } from '../services/scene-lock.service';
import { addAssistantMessage, settleUserMessage } from '../services/scene-messages';
import { restoreInto } from '../services/scene-restore';
import { pruneSceneAssets } from '../services/scene-retention';
import { resolveUndo } from '../services/scene-undo';
import { publishQueued } from '../services/scene-turn-helpers';
import { TURN_EXPIRE_SECONDS } from '../services/scene-turn.service';
import { applyLayerActions } from './scene-layer-actions';
import { addDirectorCost, summarizeDirectorCalls } from './scene-director-cost';
import { loadAttachments } from './scene-turn-context';
import { DirectorRunResult } from './scene-director-run';
import { cancelVersion, emitVersionEvent, failVersion } from './scene-turn-finish';
import { rejectVersion } from './scene-turn-complete';

export const DEFAULT_WINDOW_SECONDS = 5;

/** A versão de leitura e a cena como estavam ao começar (a cena é relida sob o lock ao terminar). */
export interface DirectorTurn {
  scene: TemplateScene;
  version: TemplateSceneVersion;
}

const isReading = (version: TemplateSceneVersion): boolean =>
  version.status === 'queued' && version.step === 'reading';

/**
 * Transições da versão de leitura, sob o lock da cena e partindo de `queued` + `step = 'reading'`. A versão de
 * leitura nunca vira `running` (`begin` e `runningVersion` servem à imagem). Termina `rejected` (resposta),
 * `failed` (`DIRECTOR_UNAVAILABLE`), `ready` (camadas e desfazer) ou `queued` com `step` nulo (imagem).
 */
@Injectable()
export class SceneDirectorState {
  constructor(
    private readonly locks: SceneLockService,
    private readonly queue: AnimationQueueService,
    private readonly config: ConfigService,
  ) {}

  windowSeconds(): number {
    const value = Number(
      this.config.get<string>('TEMPLATE_SCENE_WINDOW_SECONDS', String(DEFAULT_WINDOW_SECONDS)),
    );
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_WINDOW_SECONDS;
  }

  /**
   * Entrada: outro estado ou outro `step` sai sem chamar nada (job repetido: a versão continua `queued` depois
   * do plano, mas com `step` nulo). Cena excluída ou parada pedida cancela a versão sem chamar o Diretor.
   */
  begin(sceneId: string, versionId: string): Promise<DirectorTurn | null> {
    return this.locks.run(
      sceneId,
      async ({ manager, scene }) => {
        const version = await manager.findOne(TemplateSceneVersion, {
          where: { id: versionId, sceneId },
        });
        if (!version || !isReading(version)) return null;
        if (scene.deletedAt || version.cancelRequestedAt) {
          await cancelVersion(manager, scene, version);
          return null;
        }
        return { scene, version };
      },
      { includeDeleted: true },
    );
  }

  /**
   * Depois do Diretor: relê sob o lock. Versão fora de `queued` foi parada: descarta o plano e só grava o
   * custo (que fica na versão `cancelled` e na cena, fora de `metrics.calls`).
   */
  settle(turn: DirectorTurn, context: DirectorContext, result: DirectorRunResult): Promise<void> {
    return this.locks.run(
      turn.scene.id,
      async ({ manager, scene }) => {
        const version = await manager.findOne(TemplateSceneVersion, {
          where: { id: turn.version.id, sceneId: scene.id },
        });
        if (!version) return;
        const director = summarizeDirectorCalls(result.calls);
        addDirectorCost({ scene, version }, director);
        if (!isReading(version)) {
          await manager.save(version);
          await manager.save(scene);
          return;
        }
        if (scene.deletedAt || version.cancelRequestedAt) {
          await manager.save(version);
          await cancelVersion(manager, scene, version);
          return;
        }
        await this.apply({ manager, scene, version }, context, result, director);
      },
      { includeDeleted: true },
    );
  }

  /** Último recurso do processor: qualquer erro inesperado fecha a versão de leitura como falha. */
  failReading(sceneId: string, versionId: string, code: SceneFailureCode): Promise<void> {
    return this.locks.run(
      sceneId,
      async ({ manager, scene }) => {
        const version = await manager.findOne(TemplateSceneVersion, {
          where: { id: versionId, sceneId },
        });
        if (version && isReading(version)) await failVersion(manager, scene, version, code);
      },
      { includeDeleted: true },
    );
  }

  private async apply(
    target: { manager: EntityManager; scene: TemplateScene; version: TemplateSceneVersion },
    context: DirectorContext,
    result: DirectorRunResult,
    director: ReturnType<typeof summarizeDirectorCalls>,
  ): Promise<void> {
    const { manager, scene, version } = target;
    const { outcome } = result;
    if (outcome.kind === 'unavailable') {
      await manager.save(version);
      const code = outcome.reason === 'quota' ? 'PROVIDER_QUOTA' : 'DIRECTOR_UNAVAILABLE';
      await failVersion(manager, scene, version, code);
      return;
    }
    if (outcome.kind === 'composition_question') {
      await this.reject(target, compositionQuestion(outcome.labels));
      return;
    }
    const { plan } = outcome;
    version.metrics = { ...version.metrics, plan };
    const decision = this.decide(scene, { plan, context });
    if (decision.kind === 'refuse') {
      await this.reject(target, PAINTED_REFUSAL_REPLIES[decision.refusal]);
      return;
    }
    const brief = await this.updateBrief(manager, scene, version, plan);
    version.metrics = { ...version.metrics, director: { ...director, brief } };
    await this.run(target, { decision, plan, context });
  }

  /** Efeito do turno pela tabela do código; o plano pode abrir pedidos agora, e eles contam como em aberto. */
  private decide(
    scene: TemplateScene,
    input: { plan: DirectorPlan; context: DirectorContext },
  ): TurnDecision {
    const { plan, context } = input;
    const opened = applyDirectorRequests(scene.brief ?? [], plan.requests, {
      messageId: '',
      now: new Date(),
    }).brief;
    return decideTurn({
      plan,
      marked: context.script.marked,
      hasImage: context.script.hasImage,
      openRequests: openItems(opened).length,
    });
  }

  private async updateBrief(
    manager: EntityManager,
    scene: TemplateScene,
    version: TemplateSceneVersion,
    plan: DirectorPlan,
  ): Promise<BriefChanges> {
    const message = await manager.findOne(TemplateSceneMessage, {
      where: { versionId: version.id, role: 'user' },
      order: { createdAt: 'ASC' },
    });
    const applied = applyDirectorRequests(scene.brief ?? [], plan.requests, {
      messageId: message?.id ?? '',
      now: new Date(),
    });
    scene.brief = applied.brief;
    return applied.changes;
  }

  private async reject(
    target: { manager: EntityManager; scene: TemplateScene; version: TemplateSceneVersion },
    reply: string,
  ): Promise<void> {
    const { manager, scene, version } = target;
    await manager.save(version);
    await manager.save(scene);
    await rejectVersion(manager, scene, version, reply);
  }

  private async run(
    target: { manager: EntityManager; scene: TemplateScene; version: TemplateSceneVersion },
    input: { decision: TurnDecision; plan: DirectorPlan; context: DirectorContext },
  ): Promise<void> {
    const { decision, plan, context } = input;
    const { manager, scene } = target;
    switch (decision.kind) {
      case 'reply': {
        const fact = await this.versionFact(manager, scene, context.script.message, plan);
        const text =
          fact ?? (decision.aboutImage ? askedAboutImageReply(decision.reply) : decision.reply);
        await this.reject(target, text);
        return;
      }
      case 'image':
        await this.queueImage(target, decision);
        return;
      case 'undo':
        await this.undo(target, decision.target);
        return;
      case 'layers':
        await this.layers(target, decision.ops);
        return;
      case 'refuse':
        // Já tratada antes da lista (a recusa não abre pedidos), mas o tipo exige o ramo.
        await this.reject(target, PAINTED_REFUSAL_REPLIES[decision.refusal]);
    }
  }

  /**
   * Camadas pelo chat (logo e texto exatos) sem chamar o modelo de imagem e sem fila: a versão de leitura vira
   * `ready` com a master da atual e as camadas novas, sob o lock. Alvo ausente ou ambíguo termina `rejected`.
   */
  private async layers(
    target: { manager: EntityManager; scene: TemplateScene; version: TemplateSceneVersion },
    ops: DirectorLayerOp[],
  ): Promise<void> {
    const { manager, scene, version } = target;
    const current = await manager.findOneByOrFail(TemplateSceneVersion, {
      id: scene.currentVersionId as string,
    });
    const message = await manager.findOne(TemplateSceneMessage, {
      where: { versionId: version.id, role: 'user' },
      order: { createdAt: 'ASC' },
    });
    const attachments = await loadAttachments(manager, scene.id, message);
    const converted = layerOpsToActions(ops, {
      elements: current.elements,
      attachmentId: attachments[0]?.id ?? null,
      hintElementId: version.targetElementId,
    });
    if (converted.ok === false) return this.reject(target, converted.reply);
    const result = applyLayerActions(converted.actions, {
      zones: sceneZonesFor(scene.formatId),
      widthPx: scene.widthPx,
      heightPx: scene.heightPx,
      elements: current.elements,
      attachments,
    });
    if (result.ok === false) return this.reject(target, result.reply);
    Object.assign(version, {
      operation: 'set_layer' as const,
      status: 'ready' as const,
      step: 'done' as const,
      parentVersionId: current.id,
      masterAssetId: current.masterAssetId,
      previewAssetId: current.previewAssetId,
      elements: result.elements,
      metrics: { ...version.metrics, layer: { changed: result.changed } },
    });
    await manager.save(version);
    scene.currentVersionId = version.id;
    await pruneSceneAssets(manager, scene);
    await settleUserMessage(manager, version.id, 'done');
    await addAssistantMessage(manager, {
      sceneId: scene.id,
      versionId: version.id,
      content: layerReply(result.changed),
      status: 'done',
    });
    await bumpRevision(manager, scene);
    await emitVersionEvent(manager, scene, version, 'version.ready');
  }

  /**
   * Desfazer sem chamar o modelo de imagem: a versão de leitura vira a restauração (sem segunda versão), sob o
   * mesmo lock. Sem como voltar, termina `rejected` com a resposta.
   */
  private async undo(
    target: { manager: EntityManager; scene: TemplateScene; version: TemplateSceneVersion },
    undoTarget: 'previous' | number,
  ): Promise<void> {
    const { manager, scene, version } = target;
    const resolution = await resolveUndo(manager, scene, undoTarget);
    if (resolution.kind === 'reply') {
      await this.reject(target, resolution.reply);
      return;
    }
    await restoreInto(manager, scene, resolution.source, { reading: version });
    scene.currentVersionId = version.id;
    await pruneSceneAssets(manager, scene);
    await settleUserMessage(manager, version.id, 'done');
    const shown = (await displayNumbersOf(manager, scene.id)).get(version.id) ?? 0;
    await addAssistantMessage(manager, {
      sceneId: scene.id,
      versionId: version.id,
      content: versionRestoredReply(resolution.sourceDisplayNumber, shown),
      status: 'done',
    });
    await bumpRevision(manager, scene);
    await emitVersionEvent(manager, scene, version, 'version.ready');
  }

  /** Fato do próprio sistema (a versão atual), que vem do código e nunca do modelo. */
  private async versionFact(
    manager: EntityManager,
    scene: TemplateScene,
    message: string,
    plan: DirectorPlan,
  ): Promise<string | null> {
    if (plan.turn_kind !== 'pergunta' || !/\bvers[aã]o\b/i.test(message)) return null;
    if (!scene.currentVersionId) return null;
    const current = (await displayNumbersOf(manager, scene.id)).get(scene.currentVersionId);
    return current ? currentVersionReply(current) : null;
  }

  /** Já houve aviso do redesenho nesta cena? É fato do banco: alguma versão com `metrics.notice = true`. */
  private async alreadyNotified(manager: EntityManager, sceneId: string): Promise<boolean> {
    const rows: unknown[] = await manager.query(
      `SELECT 1 FROM template_scene_versions WHERE "sceneId" = $1 AND metrics->>'notice' = 'true' LIMIT 1`,
      [sceneId],
    );
    return rows.length > 0;
  }

  /** Grava o anúncio e o plano e publica o job de imagem, com `startAfterSeconds` quando há janela. */
  private async queueImage(
    target: { manager: EntityManager; scene: TemplateScene; version: TemplateSceneVersion },
    decision: Extract<TurnDecision, { kind: 'image' }>,
  ): Promise<void> {
    const { manager, scene, version } = target;
    const windowSeconds = decision.window ? this.windowSeconds() : 0;
    version.operation = decision.operation;
    version.step = null;
    if (decision.window) {
      version.metrics = {
        ...version.metrics,
        windowEndsAt: new Date(Date.now() + windowSeconds * 1000).toISOString(),
      };
    }
    if (decision.discardMarking) {
      version.requestedRegion = null;
      version.requestedMask = null;
    }
    await manager.save(scene);
    const notes: string[] = [];
    if (decision.discardMarking) notes.push(MARKING_DISCARDED_NOTE);
    if (decision.isEdit && !(await this.alreadyNotified(manager, scene.id))) {
      // D-35: o aviso fica gravado com a versão do anúncio, antes da janela, então "Parar" não o repete.
      notes.push(REDRAW_NOTICE);
      version.metrics = { ...version.metrics, notice: true };
    }
    await manager.save(version);
    await addAssistantMessage(manager, {
      sceneId: scene.id,
      versionId: version.id,
      content: [decision.announcement, ...notes].join(' '),
      status: 'done',
    });
    const jobId = await this.queue.publish(
      QUEUES.TEMPLATE_SCENE_TURN,
      { sceneId: scene.id, versionId: version.id },
      {
        manager,
        expireInSeconds: TURN_EXPIRE_SECONDS + windowSeconds,
        retryLimit: 0,
        ...(windowSeconds > 0 ? { startAfterSeconds: windowSeconds } : {}),
      },
    );
    if (!jobId) throw new Error('A fila não aceitou o job de imagem da cena');
    const revision = await bumpRevision(manager, scene);
    await publishQueued(manager, {
      sceneId: scene.id,
      versionId: version.id,
      revision,
      step: null,
    });
  }
}
