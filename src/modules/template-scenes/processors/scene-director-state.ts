import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { resolveGenericDrops } from '../domain/scene-desist';
import { applyDirectorRequests, BriefChanges, openItems } from '../domain/scene-brief';
import { promptableTexts } from '../domain/scene-director-painted';
import { DirectorPlan } from '../domain/scene-director-schema';
import { decideTurn, TurnDecision } from '../domain/scene-director-decision';
import { SceneFailureCode } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import {
  askedAboutImageReply,
  compositionQuestion,
  droppedNote,
  NO_INSTRUCTION_REPLY,
  NO_OPEN_REQUEST_REPLY,
  whichToForgetReply,
  NUMBER_QUESTION,
  PAINTED_QUESTION,
  currentVersionReply,
  PAINTED_REFUSAL_REPLIES,
} from '../scene-texts';
import { DirectorContext } from '../services/scene-director-context';
import { displayNumbersOf } from '../services/scene-display-number';
import { SceneLockService } from '../services/scene-lock.service';
import { addDirectorCost, DirectorCallRecord, summarizeDirectorCalls } from './scene-director-cost';
import { DirectorRunResult } from './scene-director-run';
import { cancelVersion, failVersion } from './scene-turn-finish';
import { applyLayersEffect } from './scene-director-layer-effect';
import { queueImageEffect } from './scene-director-image-effect';
import { DirectorTarget, rejectTarget } from './scene-director-target';
import { applyUndoEffect } from './scene-director-undo-effect';

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
  failReading(
    sceneId: string,
    versionId: string,
    code: SceneFailureCode,
    calls: DirectorCallRecord[] = [],
  ): Promise<void> {
    return this.locks.run(
      sceneId,
      async ({ manager, scene }) => {
        const version = await manager.findOne(TemplateSceneVersion, {
          where: { id: versionId, sceneId },
        });
        if (!version || !isReading(version)) return;
        if (calls.length) addDirectorCost({ scene, version }, summarizeDirectorCalls(calls));
        await manager.save(scene);
        await failVersion(manager, scene, version, code);
      },
      { includeDeleted: true },
    );
  }

  private async apply(
    target: DirectorTarget,
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
    if (outcome.kind === 'number_question') {
      await this.reject(target, NUMBER_QUESTION);
      return;
    }
    if (outcome.kind === 'painted_question') {
      await this.reject(target, PAINTED_QUESTION);
      return;
    }
    if (outcome.kind === 'instruction_question') {
      await this.reject(target, NO_INSTRUCTION_REPLY);
      return;
    }
    const dropped = resolveGenericDrops(outcome.plan, scene.brief ?? []);
    if (dropped.kind === 'none') {
      await this.reject(target, NO_OPEN_REQUEST_REPLY);
      return;
    }
    if (dropped.kind === 'ask') {
      await this.reject(target, whichToForgetReply(dropped.items));
      return;
    }
    const { plan } = dropped;
    version.metrics = {
      ...version.metrics,
      plan,
      ...(outcome.patches ? { planPatched: true, numberPatches: outcome.patches } : {}),
    };
    const decision = this.decide(scene, { plan, context });
    if (decision.kind === 'refuse') {
      await this.reject(target, PAINTED_REFUSAL_REPLIES[decision.refusal]);
      return;
    }
    // Camada não abre pedido (C-3): o juiz só olha a imagem e relataria "Ainda não vi" sobre a logo.
    const brief =
      plan.turn_kind === 'camada'
        ? undefined
        : await this.updateBrief(manager, scene, version, plan);
    version.metrics = { ...version.metrics, director: { ...director, brief } };
    const note = this.droppedNote(scene, brief);
    await this.run(target, { decision, plan, context, note });
  }

  /** Efeito do turno pela tabela do código; o plano pode abrir pedidos agora, e eles contam como em aberto. */
  private decide(
    scene: TemplateScene,
    input: { plan: DirectorPlan; context: DirectorContext },
  ): TurnDecision {
    const { plan, context } = input;
    const opened = applyDirectorRequests(scene.brief ?? [], plan.requests, {
      messageId: '',
      message: context.script.message,
      now: new Date(),
    }).brief;
    return decideTurn({
      plan,
      marked: context.script.marked,
      hasImage: context.script.hasImage,
      openRequests: promptableTexts(openItems(opened).map((item) => item.text)),
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
      message: message?.content ?? '',
      now: new Date(),
    });
    scene.brief = applied.brief;
    return applied.changes;
  }

  /** "Tirei da lista: X.": o que este turno desistiu, para o pedido não sumir em silêncio (G9). */
  private droppedNote(scene: TemplateScene, changes: BriefChanges | undefined): string {
    const texts = (changes?.dropped ?? [])
      .map((id) => (scene.brief ?? []).find((item) => item.id === id)?.text)
      .filter((text): text is string => Boolean(text));
    return texts.length ? droppedNote(texts) : '';
  }

  private reject(target: DirectorTarget, reply: string): Promise<void> {
    return rejectTarget(target, reply);
  }

  private async run(
    target: DirectorTarget,
    input: { decision: TurnDecision; plan: DirectorPlan; context: DirectorContext; note: string },
  ): Promise<void> {
    const { decision, plan, context, note } = input;
    const withNote = (text: string): string => (note ? `${text} ${note}` : text);
    const { manager, scene } = target;
    switch (decision.kind) {
      case 'reply': {
        const fact = await this.versionFact(manager, scene, context.script.message, plan);
        const text =
          fact ?? (decision.aboutImage ? askedAboutImageReply(decision.reply) : decision.reply);
        await this.reject(target, withNote(text));
        return;
      }
      case 'image':
        await queueImageEffect(
          target,
          { ...decision, announcement: withNote(decision.announcement) },
          {
            queue: this.queue,
            windowSeconds: this.windowSeconds(),
          },
        );
        return;
      case 'undo':
        await applyUndoEffect(target, decision.target);
        return;
      case 'layers':
        await applyLayersEffect(target, decision.ops);
        return;
      case 'refuse':
        // Já tratada antes da lista (a recusa não abre pedidos), mas o tipo exige o ramo.
        await this.reject(target, PAINTED_REFUSAL_REPLIES[decision.refusal]);
    }
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
}
