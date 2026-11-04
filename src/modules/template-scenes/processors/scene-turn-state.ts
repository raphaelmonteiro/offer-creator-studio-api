import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { SceneCallRecord, SceneFailureCode, SceneStep, SceneZones } from '../domain/scene.types';
import { sceneZonesFor } from '../domain/scene-formats';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { CANCELLED_REPLY, failureReply, READY_REPLY } from '../scene-texts';
import { publishSceneEvent, SceneEventKind } from '../services/scene-events';
import { bumpRevision, SceneLockService } from '../services/scene-lock.service';
import { addAssistantMessage, settleUserMessage } from '../services/scene-messages';
import { pruneSceneAssets } from '../services/scene-retention';

/** O que o processor precisa saber da versão para trabalhar sem segurar lock durante a chamada paga. */
export interface TurnContext {
  sceneId: string;
  versionId: string;
  correlationId: string;
  zones: SceneZones;
  artWidthCm: number;
  artHeightCm: number;
  widthPx: number;
  heightPx: number;
  request: string;
}

export interface StoredFile {
  url: string;
  width: number;
  height: number;
  bytes: number;
}

export type CompleteResult = 'ready' | 'cancelled' | 'stale';

export interface CallOutcome {
  status: 'done' | 'failed';
  costUsd: number | null;
  requestId?: string | null;
  errorCode?: string;
  latencyMs?: number;
}

const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

/**
 * Transições da versão durante o turno. Cada uma roda sob o lock da cena (curta, nunca durante a
 * chamada paga), grava `updatedAt` (atividade, para o reconciliador), sobe a `revision` quando a
 * versão termina e publica o evento na mesma transação.
 */
@Injectable()
export class SceneTurnState {
  constructor(private readonly locks: SceneLockService) {}

  private run<T>(
    ctx: Pick<TurnContext, 'sceneId'>,
    fn: (manager: EntityManager, scene: TemplateScene) => Promise<T>,
  ): Promise<T> {
    return this.locks.run(ctx.sceneId, ({ manager, scene }) => fn(manager, scene), {
      includeDeleted: true,
    });
  }

  /** `queued` → `running`/`preparing`. `null` = nada a fazer (duplicado, já final ou cancelado). */
  begin(sceneId: string, versionId: string): Promise<TurnContext | null> {
    return this.run({ sceneId }, async (manager, scene) => {
      const version = await manager.findOne(TemplateSceneVersion, {
        where: { id: versionId, sceneId },
      });
      if (!version || version.status !== 'queued') return null;
      if (scene.deletedAt || version.cancelRequestedAt) {
        await this.cancelIn(manager, scene, version);
        return null;
      }
      version.status = 'running';
      version.step = 'preparing';
      await manager.save(version);
      await this.emit(manager, scene, version, 'version.step');
      const message = await manager.findOne(TemplateSceneMessage, {
        where: { versionId, role: 'user' },
        order: { createdAt: 'ASC' },
      });
      return {
        sceneId,
        versionId,
        correlationId: version.correlationId,
        zones: sceneZonesFor(scene.formatId),
        artWidthCm: scene.artWidthCm,
        artHeightCm: scene.artHeightCm,
        widthPx: scene.widthPx,
        heightPx: scene.heightPx,
        request: message?.content ?? '',
      };
    });
  }

  /** Há pedido de cancelamento (ou a cena foi excluída)? */
  isCancelRequested(ctx: TurnContext): Promise<boolean> {
    return this.run(ctx, async (manager, scene) => {
      const version = await manager.findOneBy(TemplateSceneVersion, { id: ctx.versionId });
      return Boolean(scene.deletedAt || version?.cancelRequestedAt);
    });
  }

  /** Próxima etapa. `false` = o turno acabou (cancelado ou a versão não está mais `running`). */
  advance(ctx: TurnContext, step: SceneStep): Promise<boolean> {
    return this.run(ctx, async (manager, scene) => {
      const version = await this.runningVersion(manager, ctx);
      if (!version) return false;
      if (scene.deletedAt || version.cancelRequestedAt) {
        await this.cancelIn(manager, scene, version);
        return false;
      }
      version.step = step;
      await manager.save(version);
      await this.emit(manager, scene, version, 'version.step');
      return true;
    });
  }

  /** Grava a tentativa ANTES da chamada paga (R10) e aplica o disjuntor de chamadas por mensagem. */
  reserveCall(
    ctx: TurnContext,
    call: SceneCallRecord,
    maxCalls: number,
  ): Promise<'ok' | 'cancelled' | 'limit'> {
    return this.run(ctx, async (manager, scene) => {
      const version = await this.runningVersion(manager, ctx);
      if (!version) return 'cancelled';
      if (scene.deletedAt || version.cancelRequestedAt) {
        await this.cancelIn(manager, scene, version);
        return 'cancelled';
      }
      const calls = version.metrics.calls ?? [];
      if (calls.length >= maxCalls) {
        await this.failIn(manager, scene, version, 'PAID_CALL_LIMIT');
        return 'limit';
      }
      version.metrics = { ...version.metrics, calls: [...calls, call] };
      await manager.save(version);
      return 'ok';
    });
  }

  /** Fecha a tentativa com o custo real e soma na versão e na cena (sempre, mesmo se for descartada). */
  closeCall(ctx: TurnContext, callId: string, outcome: CallOutcome): Promise<void> {
    return this.run(ctx, async (manager, scene) => {
      const version = await manager.findOneBy(TemplateSceneVersion, { id: ctx.versionId });
      if (!version) return;
      const cost = outcome.costUsd ?? 0;
      version.metrics = {
        ...version.metrics,
        calls: (version.metrics.calls ?? []).map((call) =>
          call.id === callId
            ? {
                ...call,
                status: outcome.status,
                finishedAt: new Date().toISOString(),
                costUsd: outcome.costUsd,
                requestId: outcome.requestId ?? null,
                ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
              }
            : call,
        ),
      };
      version.providerCostUsd = round6(version.providerCostUsd + cost);
      if (outcome.latencyMs !== undefined) version.latencyMs = outcome.latencyMs;
      scene.totalCostUsd = round6(scene.totalCostUsd + cost);
      await manager.save(version);
      await manager.save(scene);
    });
  }

  /** `running` → `ready`: cria os assets, torna a versão atual, poda e responde no chat. */
  complete(
    ctx: TurnContext,
    files: { master: StoredFile; preview: StoredFile },
  ): Promise<CompleteResult> {
    return this.run(ctx, async (manager, scene) => {
      const version = await this.runningVersion(manager, ctx);
      if (!version) return 'stale';
      if (scene.deletedAt || version.cancelRequestedAt) {
        await this.cancelIn(manager, scene, version);
        return 'cancelled';
      }
      const [master, preview] = await Promise.all(
        (['master', 'preview'] as const).map((role) =>
          manager.save(
            manager.create(TemplateSceneAsset, {
              versionId: ctx.versionId,
              sceneId: ctx.sceneId,
              role,
              ...files[role],
            }),
          ),
        ),
      );
      version.status = 'ready';
      version.step = 'done';
      version.masterAssetId = master.id;
      version.previewAssetId = preview.id;
      await manager.save(version);
      scene.currentVersionId = version.id;
      await pruneSceneAssets(manager, scene.id);
      await settleUserMessage(manager, version.id, 'done');
      await addAssistantMessage(manager, {
        sceneId: scene.id,
        versionId: version.id,
        content: READY_REPLY,
        status: 'done',
      });
      await bumpRevision(manager, scene);
      await this.emit(manager, scene, version, 'version.ready');
      return 'ready';
    });
  }

  /** `running` → `failed` com o código e a mensagem em pt-BR; a versão atual não muda. */
  fail(ctx: TurnContext, code: SceneFailureCode): Promise<void> {
    return this.run(ctx, async (manager, scene) => {
      const version = await this.runningVersion(manager, ctx);
      if (version) await this.failIn(manager, scene, version, code);
    });
  }

  /** `running` → `cancelled` (pedido registrado durante o turno). */
  cancel(ctx: TurnContext): Promise<void> {
    return this.run(ctx, async (manager, scene) => {
      const version = await this.runningVersion(manager, ctx);
      if (version) await this.cancelIn(manager, scene, version);
    });
  }

  private runningVersion(
    manager: EntityManager,
    ctx: TurnContext,
  ): Promise<TemplateSceneVersion | null> {
    return manager.findOneBy(TemplateSceneVersion, {
      id: ctx.versionId,
      sceneId: ctx.sceneId,
      status: 'running',
    });
  }

  private async cancelIn(
    manager: EntityManager,
    scene: TemplateScene,
    version: TemplateSceneVersion,
  ): Promise<void> {
    version.status = 'cancelled';
    version.cancelRequestedAt = version.cancelRequestedAt ?? new Date();
    await manager.save(version);
    await settleUserMessage(manager, version.id, 'failed');
    await addAssistantMessage(manager, {
      sceneId: scene.id,
      versionId: version.id,
      content: CANCELLED_REPLY,
      status: 'done',
    });
    await bumpRevision(manager, scene);
    await this.emit(manager, scene, version, 'version.cancelled');
  }

  async failIn(
    manager: EntityManager,
    scene: TemplateScene,
    version: TemplateSceneVersion,
    code: SceneFailureCode,
  ): Promise<void> {
    version.status = 'failed';
    version.errorCode = code;
    await manager.save(version);
    await settleUserMessage(manager, version.id, 'failed');
    await addAssistantMessage(manager, {
      sceneId: scene.id,
      versionId: version.id,
      content: failureReply(code),
      status: 'failed',
    });
    await bumpRevision(manager, scene);
    await this.emit(manager, scene, version, 'version.failed');
  }

  private emit(
    manager: EntityManager,
    scene: TemplateScene,
    version: TemplateSceneVersion,
    kind: SceneEventKind,
  ): Promise<void> {
    return publishSceneEvent(manager, {
      sceneId: scene.id,
      versionId: version.id,
      kind,
      step: version.step,
      status: version.status,
      cancelRequested: version.cancelRequestedAt !== null,
      costUsd: version.providerCostUsd,
      revision: scene.revision,
    });
  }
}
