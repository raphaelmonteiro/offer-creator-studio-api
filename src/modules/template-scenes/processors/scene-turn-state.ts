import { Injectable } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import {
  MaskShape,
  Rect,
  SceneCallRecord,
  SceneElement,
  SceneFailureCode,
  SceneStep,
  SceneVersionOperation,
  SceneZones,
} from '../domain/scene.types';
import { SceneClassification } from '../domain/scene-operation.classifier';
import { sceneZonesFor } from '../domain/scene-formats';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { SceneEventKind } from '../services/scene-events';
import { cancelVersion, emitVersionEvent, failVersion } from './scene-turn-finish';
import { SceneLockService } from '../services/scene-lock.service';
import { CompleteExtra, readyVersion, rejectVersion, StoredFile } from './scene-turn-complete';

export type { CompleteExtra, StoredFile } from './scene-turn-complete';

/** A versão de onde o turno parte: imagem em disco e camadas. */
export interface TurnParent {
  versionId: string;
  elements: SceneElement[];
  masterAssetId: string | null;
  previewAssetId: string | null;
  /** `null` quando a master foi apagada pelo GC (ou nunca existiu). */
  masterUrl: string | null;
}

/** Logo (ou outra imagem) anexada à mensagem. */
export interface TurnAttachmentAsset {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
}

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
  formatId: string;
  operation: SceneVersionOperation;
  /** Classificação gravada ao enfileirar; `null` na geração simples (versões antigas). */
  plan: SceneClassification | null;
  requestedRegion: Rect | null;
  requestedMask: MaskShape | null;
  targetElementId: string | null;
  parent: TurnParent | null;
  attachmentAssets: TurnAttachmentAsset[];
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
        formatId: scene.formatId,
        operation: version.operation,
        plan: (version.metrics.plan as SceneClassification | undefined) ?? null,
        requestedRegion: version.requestedRegion,
        requestedMask: version.requestedMask,
        targetElementId: version.targetElementId,
        parent: await this.loadParent(manager, scene),
        attachmentAssets: await this.loadAttachments(manager, scene.id, message),
      };
    });
  }

  private async loadParent(
    manager: EntityManager,
    scene: TemplateScene,
  ): Promise<TurnParent | null> {
    const parent = scene.currentVersionId
      ? await manager.findOne(TemplateSceneVersion, { where: { id: scene.currentVersionId } })
      : null;
    if (!parent) return null;
    const master = parent.masterAssetId
      ? await manager.findOne(TemplateSceneAsset, { where: { id: parent.masterAssetId } })
      : null;
    return {
      versionId: parent.id,
      elements: parent.elements,
      masterAssetId: parent.masterAssetId,
      previewAssetId: parent.previewAssetId,
      masterUrl: master && !master.purgedAt ? master.url : null,
    };
  }

  private async loadAttachments(
    manager: EntityManager,
    sceneId: string,
    message: TemplateSceneMessage | null,
  ): Promise<TurnAttachmentAsset[]> {
    const ids = (message?.attachments ?? []).map((attachment) => attachment.assetId);
    if (ids.length === 0) return [];
    const assets = await manager.findBy(TemplateSceneAsset, { sceneId, id: In(ids) });
    return assets
      .filter((asset) => !asset.purgedAt)
      .map((a) => ({ id: a.id, url: a.url, width: a.width, height: a.height }));
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

  /**
   * Grava a tentativa ANTES da chamada paga (R10) e aplica o disjuntor de chamadas por mensagem.
   * No limite, `onLimit: 'fail'` (chamada de imagem) falha a versão com `PAID_CALL_LIMIT`; `'skip'`
   * (visão, opcional) só devolve `'limit'` e a versão segue.
   */
  reserveCall(
    ctx: TurnContext,
    call: SceneCallRecord,
    maxCalls: number,
    onLimit: 'fail' | 'skip' = 'fail',
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
        if (onLimit === 'fail') await this.failIn(manager, scene, version, 'PAID_CALL_LIMIT');
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

  /** `running` → `ready` com master e prévia novas (geração, ajuste geral e edição local). */
  complete(
    ctx: TurnContext,
    files: { master: StoredFile; preview: StoredFile },
    extra: CompleteExtra = {},
  ): Promise<CompleteResult> {
    return this.completeWith(ctx, { kind: 'files', ...files }, extra);
  }

  /** `running` → `ready` apontando para a imagem da versão de origem, sem arquivo novo (camadas e "adicionar"). */
  completeReusingImage(
    ctx: TurnContext,
    extra: CompleteExtra,
    elementFile?: StoredFile & { id: string },
  ): Promise<CompleteResult> {
    const image = {
      kind: 'reuse' as const,
      masterAssetId: ctx.parent?.masterAssetId ?? null,
      previewAssetId: ctx.parent?.previewAssetId ?? null,
    };
    return this.completeWith(ctx, image, extra, elementFile);
  }

  private completeWith(
    ctx: TurnContext,
    image: Parameters<typeof readyVersion>[4],
    extra: CompleteExtra,
    elementFile?: StoredFile & { id: string },
  ): Promise<CompleteResult> {
    return this.run(ctx, async (manager, scene) => {
      const version = await this.runningVersion(manager, ctx);
      if (!version) return 'stale';
      const target = {
        sceneId: ctx.sceneId,
        versionId: ctx.versionId,
        parentElements: structuredClone(ctx.parent?.elements ?? []),
        elementFile,
      };
      return readyVersion(manager, scene, version, target, image, extra);
    });
  }

  /** `running` → `rejected`: nada para fazer (por exemplo, a logo citada não existe); só a resposta no chat. */
  reject(ctx: TurnContext, reply: string): Promise<void> {
    return this.run(ctx, async (manager, scene) => {
      const version = await this.runningVersion(manager, ctx);
      if (version) await rejectVersion(manager, scene, version, reply);
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

  private cancelIn(
    manager: EntityManager,
    scene: TemplateScene,
    version: TemplateSceneVersion,
  ): Promise<void> {
    return cancelVersion(manager, scene, version);
  }

  failIn(
    manager: EntityManager,
    scene: TemplateScene,
    version: TemplateSceneVersion,
    code: SceneFailureCode,
  ): Promise<void> {
    return failVersion(manager, scene, version, code);
  }

  private emit(
    manager: EntityManager,
    scene: TemplateScene,
    version: TemplateSceneVersion,
    kind: SceneEventKind,
  ): Promise<void> {
    return emitVersionEvent(manager, scene, version, kind);
  }
}
