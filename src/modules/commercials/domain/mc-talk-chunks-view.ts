import { McStepStatus } from './mc-state-machines';
import { readChunkSnapshot } from './mc-talk-chunk-step';
import { McStepType } from './mc-types';

/**
 * Trechos de fala contínua na leitura do projeto (`GET projects/:id`, change video-fala-continua, D13):
 * o plano (cenas do trecho, segundos enviados) vem do snapshot do step `talk` da revisão corrente e o
 * estado, do próprio step. Função PURA.
 */
export type McTalkChunkStatus = 'pending' | 'running' | 'ready' | 'failed';

export interface McTalkChunkView {
  index: number;
  /** `sceneId` do roteiro das falas do trecho, na ordem. */
  sceneIds: string[];
  status: McTalkChunkStatus;
  /** Segundos enviados ao motor (e cobrados), do plano. */
  billedSeconds: number;
  stepId: string;
}

interface ChunkStepLike {
  id: string;
  type: McStepType;
  status: McStepStatus;
  attempt?: number | null;
  projectRevision?: number | null;
  inputSnapshot?: unknown;
}

export function chunkStatusOf(status: McStepStatus): McTalkChunkStatus {
  switch (status) {
    case McStepStatus.SUCCEEDED:
    case McStepStatus.SKIPPED_CACHED:
      return 'ready';
    case McStepStatus.FAILED:
      return 'failed';
    case McStepStatus.QUEUED:
    case McStepStatus.RUNNING:
    case McStepStatus.PROVIDER_WAIT:
    case McStepStatus.INGESTING:
      return 'running';
    default:
      return 'pending';
  }
}

/** `null` fora do modo contínuo ou antes de existir um `talk` de trecho na revisão corrente. */
export function talkChunksView(
  script: { talkMode?: string } | null | undefined,
  revision: number | null | undefined,
  steps: ChunkStepLike[],
): McTalkChunkView[] | null {
  if (script?.talkMode !== 'continuous') return null;
  const byIndex = new Map<number, { step: ChunkStepLike; attempt: number }>();
  for (const step of steps) {
    if (step.type !== McStepType.TALK) continue;
    if (revision != null && step.projectRevision != null && step.projectRevision !== revision) {
      continue;
    }
    const chunk = readChunkSnapshot(step.inputSnapshot);
    if (!chunk) continue;
    const attempt = step.attempt ?? 1;
    const current = byIndex.get(chunk.index);
    if (!current || attempt >= current.attempt) byIndex.set(chunk.index, { step, attempt });
  }
  if (byIndex.size === 0) return null;
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, { step }]) => {
      const chunk = readChunkSnapshot(step.inputSnapshot)!;
      return {
        index,
        sceneIds: chunk.sceneIds,
        status: chunkStatusOf(step.status),
        billedSeconds: Number((chunk.sentMs / 1000).toFixed(3)),
        stepId: step.id,
      };
    });
}
