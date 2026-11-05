import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { SceneCallRecord, SceneFailureCode, SceneStep } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { SceneEventKind } from '../services/scene-events';
import { cancelVersion, emitVersionEvent, failVersion } from './scene-turn-finish';
import { SceneLockService } from '../services/scene-lock.service';
import { CallOutcome, closeCallIn, recordCallIn } from './scene-turn-calls';
import { loadTurnContext, TurnContext } from './scene-turn-context';
import {
  CompleteExtra,
  CompleteImage,
  readyVersion,
  rejectVersion,
  StoredFile,
} from './scene-turn-complete';

export type { CompleteExtra, StoredFile } from './scene-turn-complete';
export type { TurnAttachmentAsset, TurnContext, TurnParent } from './scene-turn-context';

export type { CallOutcome } from './scene-turn-calls';
export type CompleteResult = 'ready' | 'cancelled' | 'stale';

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
      return loadTurnContext(manager, scene, version);
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
      const result = await recordCallIn(manager, version, call, maxCalls);
      if (result === 'limit' && onLimit === 'fail') {
        await this.failIn(manager, scene, version, 'PAID_CALL_LIMIT');
      }
      return result;
    });
  }

  /** Fecha a tentativa com o custo real e soma na versão e na cena (sempre, mesmo se for descartada). */
  closeCall(ctx: TurnContext, callId: string, outcome: CallOutcome): Promise<void> {
    return this.run(ctx, async (manager, scene) => {
      const version = await manager.findOneBy(TemplateSceneVersion, { id: ctx.versionId });
      if (version) await closeCallIn(manager, { scene, version }, callId, outcome);
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
    image: CompleteImage,
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
      return readyVersion(manager, scene, version, { target, image, extra });
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
