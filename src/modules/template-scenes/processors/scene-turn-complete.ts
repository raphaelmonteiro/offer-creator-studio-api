import { EntityManager } from 'typeorm';
import { QueuePort } from '../../../shared/queue/animation-queue.service';
import { Rect, SceneElement } from '../domain/scene.types';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { publishSceneEvent } from '../services/scene-events';
import {
  faceKeyOfVersion,
  setFaceCurrentVersion,
  stampVersionZones,
} from '../services/scene-faces';
import { bumpRevision } from '../services/scene-lock.service';
import { addAssistantMessage, settleUserMessage, turnMessageOf } from '../services/scene-messages';
import { pruneSceneAssets } from '../services/scene-retention';
import { closeTurnBrief } from '../services/scene-turn-brief';
import { cancelVersion, emitVersionReady } from './scene-turn-finish';
import { applyJudgeVerdict, JudgeBriefVerdict } from '../domain/scene-brief';
import { conceptDoneItem } from '../domain/scene-reference-plan';

export interface StoredFile {
  url: string;
  width: number;
  height: number;
  bytes: number;
}

/** O que muda na versão `ready` além da imagem: resposta, camadas, métricas e a região alterada. */
export interface CompleteExtra {
  /** Resposta do chat, montada pelo código a partir do que o juiz conferiu (G8). */
  reply: string;
  /** Camadas da versão; sem isto, herda as da versão de onde saiu. */
  elements?: SceneElement[];
  /** Mesclado em `metrics` (as chamadas já gravadas ficam). */
  metrics?: Record<string, unknown>;
  /** Região alterada (a caixa de uma forma de pincel/laço), para o destaque na prévia. */
  requestedRegion?: Rect | null;
  /** O que o juiz viu e não viu da lista do que o cliente pediu: só ele fecha ou reabre um item (G9). */
  judge?: JudgeBriefVerdict;
  /** Derivação do verso: o fim do turno não supera os pedidos em aberto (o do verso fica para o cliente pedir). */
  keepBrief?: boolean;
  /** Geração por referência: o item "Conceito do encarte: ..." entra no brief como pedido atendido. */
  briefDone?: string;
}

/** Imagem da versão: arquivos novos (master e prévia). Camadas e desfazer não passam por aqui: reaproveitam a master sob o lock do Diretor. */
export type CompleteImage = { kind: 'files'; master: StoredFile; preview: StoredFile };

export interface CompleteTarget {
  sceneId: string;
  versionId: string;
  parentElements: SceneElement[];
}

/** Cria o asset do arquivo na versão que o criou. */
function saveAsset(
  manager: EntityManager,
  target: CompleteTarget,
  role: TemplateSceneAsset['role'],
  file: StoredFile,
): Promise<TemplateSceneAsset> {
  return manager.save(
    manager.create(TemplateSceneAsset, {
      versionId: target.versionId,
      sceneId: target.sceneId,
      role,
      ...file,
    }),
  );
}

async function resolveImage(
  manager: EntityManager,
  target: CompleteTarget,
  image: CompleteImage,
): Promise<{ masterAssetId: string | null; previewAssetId: string | null }> {
  const master = await saveAsset(manager, target, 'master', image.master);
  const preview = await saveAsset(manager, target, 'preview', image.preview);
  return { masterAssetId: master.id, previewAssetId: preview.id };
}

/**
 * `running` → `ready` sob o lock da cena: cria os assets (ou reaproveita a imagem da origem), grava
 * camadas e métricas, torna a versão atual, PODA as masters que saíram do conjunto protegido (D-12,
 * em todo caminho que cria versão `ready`), responde no chat, sobe a `revision` e publica o evento.
 */
export async function readyVersion(
  manager: EntityManager,
  scene: TemplateScene,
  version: TemplateSceneVersion,
  completion: {
    target: CompleteTarget;
    image: CompleteImage;
    extra: CompleteExtra;
    queue: Pick<QueuePort, 'publish'>;
  },
): Promise<'ready' | 'cancelled'> {
  const { target, image, extra, queue } = completion;
  if (scene.deletedAt || version.cancelRequestedAt) {
    await cancelVersion(manager, scene, version);
    return 'cancelled';
  }
  const ids = await resolveImage(manager, target, image);
  version.status = 'ready';
  version.step = 'done';
  version.masterAssetId = ids.masterAssetId;
  version.previewAssetId = ids.previewAssetId;
  version.elements = extra.elements ?? target.parentElements;
  version.metrics = { ...version.metrics, ...extra.metrics };
  const messageId = (await turnMessageOf(manager, version))?.id ?? '';
  if (extra.judge) {
    const judged = applyJudgeVerdict(scene.brief ?? [], extra.judge, {
      messageId,
      now: new Date(),
    });
    scene.brief = judged.brief;
    version.metrics = { ...version.metrics, judgeBrief: judged.changes };
  }
  if (!extra.keepBrief) await closeTurnBrief(manager, scene, version, { messageId });
  if (extra.briefDone) {
    scene.brief = conceptDoneItem(scene.brief ?? [], {
      text: extra.briefDone,
      messageId,
      now: new Date(),
    });
  }
  if (extra.requestedRegion !== undefined) version.requestedRegion = extra.requestedRegion;
  await stampVersionZones(manager, scene, version);
  await manager.save(version);
  // O resultado é sempre a versão atual, inclusive com o juiz reprovando (D-26): "Voltar para a anterior" é do cliente.
  await setFaceCurrentVersion(manager, scene, version.faceIndex, version.id);
  await pruneSceneAssets(manager, scene);
  await settleUserMessage(manager, version.id, 'done');
  await addAssistantMessage(manager, {
    sceneId: scene.id,
    versionId: version.id,
    content: extra.reply,
    status: 'done',
  });
  await bumpRevision(manager, scene);
  await emitVersionReady(manager, queue, scene, version);
  return 'ready';
}

/** `running` → `rejected`: o turno terminou sem mudar nada (custo já gravado), só com a resposta no chat. */
export async function rejectVersion(
  manager: EntityManager,
  scene: TemplateScene,
  version: TemplateSceneVersion,
  reply: string,
): Promise<void> {
  version.status = 'rejected';
  version.step = 'done';
  await closeTurnBrief(manager, scene, version);
  await manager.save(version);
  await settleUserMessage(manager, version.id, 'done');
  await addAssistantMessage(manager, {
    sceneId: scene.id,
    versionId: version.id,
    content: reply,
    status: 'done',
  });
  await bumpRevision(manager, scene);
  await publishSceneEvent(manager, {
    sceneId: scene.id,
    versionId: version.id,
    faceKey: faceKeyOfVersion(scene, version),
    kind: 'version.failed',
    step: version.step,
    status: version.status,
    cancelRequested: false,
    costUsd: version.providerCostUsd,
    revision: scene.revision,
  });
}
