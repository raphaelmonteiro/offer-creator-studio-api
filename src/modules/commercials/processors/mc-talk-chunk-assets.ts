import { EntityManager } from 'typeorm';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { ChunkSnapshot } from '../domain/mc-talk-chunk-step';
import { TalkConformPlan } from '../domain/mc-talk-conform-graph';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import type { ClipInspection } from '../services/mc-clip-inspector.service';
import type { TalkConformGate } from './mc-talk-conform-gate';
import type {
  ChunkBilling,
  ConformedChunk,
  PublishedJoinFrame,
  PublishedVideo,
} from './mc-talk-chunk-ingest.types';
import type { TalkResolutionRecord } from './mc-ingest.processor';

export interface SaveChunkAssetsInput {
  step: McStep;
  project: McProject;
  chunk: ChunkSnapshot;
  scenes: McScene[];
  conformed: ConformedChunk;
  published: PublishedVideo[];
  chunkAsset: PublishedVideo | null;
  joinFrame: PublishedJoinFrame | null;
  resolution: TalkResolutionRecord;
  inspection: ClipInspection | null;
  billing: ChunkBilling;
}

interface SliceMeta {
  sceneRowId: string;
  assetId: string;
  speechMs: number;
}

/**
 * Grava, na transação do ingest, os assets do trecho: uma fatia por cena (a líder leva custo e telemetria),
 * o trecho inteiro e o quadro de junção. Devolve o id do asset da fatia líder.
 */
export async function saveChunkAssets(
  manager: EntityManager,
  input: SaveChunkAssetsInput,
): Promise<string> {
  const { conformed, scenes, published, chunkAsset, joinFrame } = input;
  const repo = manager.getRepository(AnimationAsset);
  const slicesMeta: SliceMeta[] = conformed.slices.map((slice, i) => ({
    sceneRowId: scenes[i].id,
    assetId: published[i].assetId,
    speechMs: slice.speechMs,
  }));
  for (const i of conformed.slices.keys()) {
    await repo.save(sliceAsset(input, i, slicesMeta));
  }
  if (joinFrame) await repo.save(joinFrameAsset(input, joinFrame));
  if (chunkAsset) await repo.save(fullChunkAsset(input, chunkAsset, slicesMeta));
  return published[0].assetId;
}

function sliceAsset(input: SaveChunkAssetsInput, i: number, slicesMeta: SliceMeta[]) {
  const { step, project, chunk, scenes, conformed, published, chunkAsset, joinFrame } = input;
  const slice = conformed.slices[i];
  const leader = i === 0;
  return {
    id: published[i].assetId,
    userId: project.userId,
    kind: 'scene_synced' as const,
    status: 'ready' as const,
    name: `Cena ${scenes[i].idx + 1} — ${project.title.slice(0, 40)}`,
    origin: 'ai_generated' as const,
    fileUrl: published[i].fileUrl,
    posterUrl: published[i].posterUrl,
    thumbUrl: published[i].thumbUrl,
    mimeType: 'video/mp4',
    width: slice.measured.width,
    height: slice.measured.height,
    durationMs: slice.measured.durationMs,
    fileSize: String(published[i].size),
    metadata: {
      projectId: project.id,
      sceneId: scenes[i].id,
      generation: scenes[i].generation,
      provider: step.provider,
      providerJobId: step.providerJobId,
      sceneType: 'talk_tile',
      chunkStepId: step.id,
      chunkIndex: chunk.index,
      chunkAssetId: chunkAsset?.assetId ?? null,
      speechMs: slice.speechMs,
      joinedToNext: slice.joinedToNext,
      // a inspeção é do trecho: toda fatia mostra o veredito na revisão; custo e motor só a líder
      ...inspectionMetadata(input),
      ...(leader ? leaderMetadata(input, slicesMeta) : {}),
      ...(leader && joinFrame ? { joinFrameAssetId: joinFrame.assetId } : {}),
    },
  };
}

function joinFrameAsset(input: SaveChunkAssetsInput, joinFrame: PublishedJoinFrame) {
  const { step, project, chunk, published } = input;
  return {
    id: joinFrame.assetId,
    userId: project.userId,
    kind: 'talk_join_frame' as const,
    status: 'ready' as const,
    name: `Quadro de junção ${chunk.index + 1} — ${project.title.slice(0, 40)}`,
    origin: 'ai_generated' as const,
    fileUrl: joinFrame.fileUrl,
    mimeType: 'image/png',
    width: joinFrame.width,
    height: joinFrame.height,
    fileSize: String(joinFrame.size),
    metadata: {
      projectId: project.id,
      chunkIndex: chunk.index,
      sourceStepId: step.id,
      sourceAssetId: published[0].assetId,
    },
  };
}

function fullChunkAsset(
  input: SaveChunkAssetsInput,
  chunkAsset: PublishedVideo,
  slicesMeta: SliceMeta[],
) {
  const { step, project, chunk, conformed } = input;
  return {
    id: chunkAsset.assetId,
    userId: project.userId,
    kind: 'talk_chunk_clip' as const,
    status: 'ready' as const,
    name: `Trecho ${chunk.index + 1} — ${project.title.slice(0, 40)}`,
    origin: 'ai_generated' as const,
    fileUrl: chunkAsset.fileUrl,
    posterUrl: chunkAsset.posterUrl,
    thumbUrl: chunkAsset.thumbUrl,
    mimeType: 'video/mp4',
    width: conformed.measured.width,
    height: conformed.measured.height,
    durationMs: conformed.measured.durationMs,
    fileSize: String(chunkAsset.size),
    metadata: {
      projectId: project.id,
      chunkStepId: step.id,
      chunkIndex: chunk.index,
      slices: slicesMeta,
    },
  };
}

/** Telemetria do trecho no asset da fatia LÍDER (custo, motor, conformação, inspeção); as demais não levam custo. */
function leaderMetadata(input: SaveChunkAssetsInput, slices: SliceMeta[]): Record<string, unknown> {
  const { conformed, billing, resolution } = input;
  return {
    providerCostUsd: Number(billing.providerCostUsd.toFixed(4)),
    ...billing.engineRecord,
    resolution,
    ...(resolution.requiredLongSidePx != null
      ? { premiumResolutionOk: resolution.ok === true }
      : {}),
    chunkSlices: slices,
    conform: conformMetadata({ ...conformed.gate, conformed, chunk: input.chunk }),
  };
}

function inspectionMetadata(input: SaveChunkAssetsInput): Record<string, unknown> {
  const { inspection, step } = input;
  if (!inspection) return {};
  return {
    inspected: inspection.available,
    inspection: { ...inspection, accepted: inspection.flagged, executions: step.attempts },
  };
}

function conformMetadata(input: {
  plan: TalkConformPlan;
  verdict: TalkConformGate['verdict'];
  accepted: TalkConformGate['accepted'];
  conformed: ConformedChunk;
  chunk: ChunkSnapshot;
}): Record<string, unknown> {
  const { plan, verdict, accepted, conformed, chunk } = input;
  return {
    durationAction: verdict,
    executedAction: plan.durationAction,
    deltaMs: plan.deltaMs,
    padS: plan.padS,
    crop: plan.crop,
    rawDurationMs: conformed.rawDurationMs,
    rawWidth: conformed.rawWidth,
    rawHeight: conformed.rawHeight,
    audioMs: chunk.audioMs,
    audioAssetId: conformed.leaderAudioAssetId,
    audioPolicy: 'replace_clip_audio',
    ...(accepted
      ? { accepted: true, acceptedReason: accepted.reason, executions: accepted.executions }
      : {}),
  };
}
