import { EntityManager } from 'typeorm';
import { McTalkChunkReason } from '../domain/mc-quality';
import { McStepStatus } from '../domain/mc-state-machines';
import { readChunkSnapshot } from '../domain/mc-talk-chunk-step';
import { McStepType } from '../domain/mc-types';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import type { PlannedChunk } from './mc-talk-chunk-planner';

/** Motivo de cada trecho (D13, Q2): de que depende cobrar crédito ou não. */

const DONE: McStepStatus[] = [McStepStatus.SUCCEEDED, McStepStatus.SKIPPED_CACHED];

/**
 * Áudio (TTS) com que cada fala já foi gravada em algum `talk` concluído do projeto: `sceneRowId` → ids.
 * Fala cujo TTS atual não está aqui foi EDITADA (ou é nova); fala que está aqui só entra no trecho
 * regravado por cascata (junção ou reagrupamento), sem crédito (Q2).
 */
export async function recordedAudioHistory(
  manager: EntityManager,
  projectId: string,
): Promise<Map<string, Set<string>>> {
  const steps = await manager.find(McStep, { where: { projectId, type: McStepType.TALK } });
  const history = new Map<string, Set<string>>();
  for (const step of steps) {
    if (!DONE.includes(step.status)) continue;
    for (const speech of readChunkSnapshot(step.inputSnapshot)?.speeches ?? []) {
      const ids = history.get(speech.sceneRowId) ?? new Set<string>();
      ids.add(speech.audioAssetId);
      history.set(speech.sceneRowId, ids);
    }
  }
  return history;
}

export type ChunkDraft = Omit<PlannedChunk, 'reason' | 'chargedScenes'> & {
  chargedScenes?: McScene[];
};

/** Motivo do trecho e as falas que cobram crédito (D13, Q2): reroll → as pedidas; edited → as editadas; cascade/cached → nenhuma. */
export function classifyChunk(args: {
  draft: ChunkDraft;
  history: Map<string, Set<string>>;
  rerollTarget: boolean;
  targetScenes: McScene[];
}): { reason: McTalkChunkReason; chargedScenes: McScene[] } {
  const { draft, history } = args;
  if (args.rerollTarget) return { reason: 'reroll', chargedScenes: args.targetScenes };
  if (draft.cached) return { reason: 'cached', chargedScenes: [] };
  if (history.size === 0) return { reason: 'new', chargedScenes: draft.scenes };
  const edited = draft.scenes.filter((s) => !history.get(s.id)?.has(s.audioAssetId as string));
  return edited.length > 0
    ? { reason: 'edited', chargedScenes: edited }
    : { reason: 'cascade', chargedScenes: [] };
}
