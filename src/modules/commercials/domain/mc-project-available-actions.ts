import { McProjectStatus, McStepStatus } from './mc-state-machines';
import { McProjectTier, McStepType } from './mc-types';

/**
 * Ações disponíveis de um projeto para a UI (change video-formatos-personagem,
 * spec "Motor indisponível"): função PURA sobre projeto + steps, exposta em
 * `GET /commercials/projects/:id` como `availableActions`.
 *
 * - `refazer`: projeto em `needs_attention` com um step de cena falhado
 *   terminal na revisão corrente (o usuário manda refazer a cena).
 * - `duplicar_como_economico`: o mesmo caso, quando a falha terminal foi de um
 *   `talk` num projeto `premium` — a cópia reaproveita roteiro, falas e tile
 *   e gera só os clipes no motor econômico (`POST /projects/:id/duplicate`
 *   com `tier: 'economico'`).
 */
export const MC_PROJECT_ACTIONS = ['refazer', 'duplicar_como_economico'] as const;
export type McProjectAction = (typeof MC_PROJECT_ACTIONS)[number];

export interface AvailableActionsProject {
  status: McProjectStatus;
  tier?: McProjectTier | null;
  revision?: number | null;
}

export interface AvailableActionsStep {
  sceneId: string | null;
  type: McStepType;
  status: McStepStatus;
  projectRevision?: number | null;
}

export function availableProjectActions(
  project: AvailableActionsProject,
  steps: AvailableActionsStep[],
): McProjectAction[] {
  if (project.status !== McProjectStatus.NEEDS_ATTENTION) return [];
  const revision = project.revision ?? null;
  const failed = steps.filter(
    (s) =>
      s.sceneId !== null &&
      s.status === McStepStatus.FAILED &&
      (revision == null || s.projectRevision == null || s.projectRevision === revision),
  );
  if (failed.length === 0) return [];
  const actions: McProjectAction[] = ['refazer'];
  if (project.tier === 'premium' && failed.some((s) => s.type === McStepType.TALK)) {
    actions.push('duplicar_como_economico');
  }
  return actions;
}
