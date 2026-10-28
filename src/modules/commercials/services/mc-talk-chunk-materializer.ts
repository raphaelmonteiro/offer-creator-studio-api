import { EntityManager } from 'typeorm';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { McQuoteItem } from '../domain/mc-quality';
import { McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import type { McMaterializerService } from './mc-materializer.service';
import { ChunkPlanArgs, PlannedChunk, planProjectChunks } from './mc-talk-chunk-planner';
import { chunkCredits, chunkQuoteItems } from './mc-talk-chunk-quote';

export { isContinuousProject, planProjectChunks } from './mc-talk-chunk-planner';
export type { ChunkPlanArgs, ChunkScope, PlannedChunk } from './mc-talk-chunk-planner';
export {
  chunkCredits,
  chunkQuoteItems,
  quoteTalkChunks,
  resolveChunkReroll,
} from './mc-talk-chunk-quote';
export type { ChunkRerollScope } from './mc-talk-chunk-quote';

/**
 * Materialização do `talk` por TRECHO (change video-fala-continua, D4/D6/D7/D10/D13): cria o step de cada
 * trecho no escopo e religa as fatias quando o trecho vem do cache. O plano está em
 * `mc-talk-chunk-planner`; a cotação e o alcance do reroll, em `mc-talk-chunk-quote`.
 */

/** Cena pronta com o clipe `assetId` (atalho de cache; sem transição de estado, como o cache de hoje). */
async function markReady(manager: EntityManager, scene: McScene, assetId: string): Promise<void> {
  await manager.update(
    McScene,
    { id: scene.id },
    { status: McSceneStatus.READY, finalAssetId: assetId, errorCode: null, errorMessage: null },
  );
  scene.status = McSceneStatus.READY;
  scene.finalAssetId = assetId;
}

/** Trecho em cache: a líder aponta a fatia reaproveitada e as seguidoras religam as suas (metadata.chunkSlices). */
async function rehydrateCachedChunk(
  manager: EntityManager,
  chunk: PlannedChunk,
  outputAssetId: string,
): Promise<void> {
  const asset = await manager.findOne(AnimationAsset, { where: { id: outputAssetId } });
  const slices = (asset?.metadata as { chunkSlices?: Array<{ assetId: string }> } | null)
    ?.chunkSlices;
  await markReady(manager, chunk.leader, outputAssetId);
  if (!slices || slices.length !== chunk.scenes.length) return;
  for (const [i, scene] of chunk.scenes.entries()) {
    if (i > 0) await markReady(manager, scene, slices[i].assetId);
  }
}

/** Cria o step `talk` de cada trecho no escopo; cache religa as fatias. Devolve steps e itens da cotação. */
export async function materializeTalkChunks(
  mat: McMaterializerService,
  manager: EntityManager,
  args: ChunkPlanArgs,
): Promise<{ steps: McStep[]; items: McQuoteItem[] }> {
  const planned = await planProjectChunks(mat, manager, args);
  const steps: McStep[] = [];
  const items: McQuoteItem[] = [];
  for (const chunk of planned) {
    if (!chunk.inScope) continue;
    const step = await mat.createChunkStep(manager, args.project, chunk.leader, {
      inputHash: chunk.output.inputHash,
      snapshot: chunk.output.snapshot,
      attempt: chunk.attempt,
      cachedAssetId: chunk.cached?.outputAssetId ?? null,
      costCredits: chunkCredits(chunk),
    });
    steps.push(step);
    items.push(...chunkQuoteItems(chunk));
    if (step.status === McStepStatus.SKIPPED_CACHED && step.outputAssetId) {
      await rehydrateCachedChunk(manager, chunk, step.outputAssetId);
    }
  }
  return { steps, items };
}
