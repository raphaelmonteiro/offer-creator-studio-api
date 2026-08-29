/**
 * Máquinas de estado formais de mc_projects, mc_scenes e mc_steps
 * (plano-comerciais §6.1). Fonte única de verdade: os testes são gerados a
 * partir destas matrizes. Transições fora da matriz são rejeitadas —
 * chamadores fazem CAS no banco via TaskTransitionService.casTransition
 * (`UPDATE ... WHERE status = from`), então um evento duplicado vira no-op.
 *
 * Mesmo mecanismo do task-state-machine de src/shared/state/ (referência de
 * estilo) — matrizes próprias do módulo, sem importar nada de animations.
 */

/**
 * Estados do kit do mascote (plano §4/§6.1). Movido da entity para cá quando a
 * geração real do kit entrou (B1a): o domain é a casa das máquinas formais.
 */
export enum McKitStatus {
  GENERATING = 'generating',
  REVIEW = 'review',
  APPROVED = 'approved',
  FAILED = 'failed',
  ARCHIVED = 'archived',
}

export enum McProjectStatus {
  DRAFT = 'draft',
  SCRIPTING = 'scripting',
  STORYBOARD_REVIEW = 'storyboard_review',
  GENERATING = 'generating',
  NEEDS_ATTENTION = 'needs_attention',
  ASSEMBLING = 'assembling',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELED = 'canceled',
}

export enum McSceneStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  READY = 'ready',
  FAILED = 'failed',
  CANCELED = 'canceled',
}

export enum McStepStatus {
  PENDING = 'pending',
  QUEUED = 'queued',
  RUNNING = 'running',
  PROVIDER_WAIT = 'provider_wait',
  INGESTING = 'ingesting',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELED = 'canceled',
  SKIPPED_CACHED = 'skipped_cached',
}

/**
 * generating → review (gate humano do §4) → approved (imutável; muda = nova
 * versão) → archived. Regenerar UMA referência não transiciona — o kit
 * continua em review enquanto o usuário lapida o grid. Kit failed é terminal:
 * o usuário cria outro kit (nada de créditos envolvido — kit não reserva na
 * v0, plano §4).
 */
export const MC_KIT_TRANSITIONS: Record<McKitStatus, McKitStatus[]> = {
  [McKitStatus.GENERATING]: [McKitStatus.REVIEW, McKitStatus.FAILED],
  [McKitStatus.REVIEW]: [McKitStatus.APPROVED, McKitStatus.FAILED, McKitStatus.ARCHIVED],
  [McKitStatus.APPROVED]: [McKitStatus.ARCHIVED],
  [McKitStatus.FAILED]: [],
  [McKitStatus.ARCHIVED]: [],
};

/**
 * draft → scripting → storyboard_review (GATE humano) → generating →
 * needs_attention | assembling → succeeded|failed|canceled (plano §6.1).
 * - storyboard_review → scripting: usuário pede novo roteiro antes de aprovar.
 * - generating → needs_attention: recusa de política/cena falhada NÃO falha o
 *   projeto inteiro (plano §6.4) — pausa para ação humana (re-roll/editar).
 * - needs_attention → generating: retomada após o usuário resolver a cena.
 * - succeeded → generating (B1b): re-roll/regravação PÓS-ENTREGA reabre o
 *   projeto para nova montagem (plano §6.3 "re-roll por cena" vale também
 *   depois do final entregue; a entrega já consumiu a reserva integral, então
 *   reabrir nunca "des-cobra" o que foi entregue).
 */
export const MC_PROJECT_TRANSITIONS: Record<McProjectStatus, McProjectStatus[]> = {
  [McProjectStatus.DRAFT]: [McProjectStatus.SCRIPTING, McProjectStatus.CANCELED],
  [McProjectStatus.SCRIPTING]: [
    McProjectStatus.STORYBOARD_REVIEW,
    McProjectStatus.FAILED,
    McProjectStatus.CANCELED,
  ],
  [McProjectStatus.STORYBOARD_REVIEW]: [
    McProjectStatus.GENERATING, // aprovação do storyboard (GATE)
    McProjectStatus.SCRIPTING, // refazer roteiro
    McProjectStatus.CANCELED,
  ],
  [McProjectStatus.GENERATING]: [
    McProjectStatus.NEEDS_ATTENTION,
    McProjectStatus.ASSEMBLING,
    McProjectStatus.FAILED,
    McProjectStatus.CANCELED,
  ],
  [McProjectStatus.NEEDS_ATTENTION]: [
    McProjectStatus.GENERATING,
    McProjectStatus.FAILED,
    McProjectStatus.CANCELED,
  ],
  [McProjectStatus.ASSEMBLING]: [
    McProjectStatus.SUCCEEDED,
    McProjectStatus.FAILED,
    McProjectStatus.CANCELED,
  ],
  [McProjectStatus.SUCCEEDED]: [McProjectStatus.GENERATING], // re-roll pós-entrega (B1b)
  [McProjectStatus.FAILED]: [],
  [McProjectStatus.CANCELED]: [],
};

/**
 * Cena é a unidade de re-roll (plano §6.1): ready|failed → pending re-arma a
 * cena com `generation++` (steps da geração antiga ficam para trás e são
 * ignorados pelo scheduler).
 */
export const MC_SCENE_TRANSITIONS: Record<McSceneStatus, McSceneStatus[]> = {
  [McSceneStatus.PENDING]: [McSceneStatus.RUNNING, McSceneStatus.CANCELED],
  [McSceneStatus.RUNNING]: [McSceneStatus.READY, McSceneStatus.FAILED, McSceneStatus.CANCELED],
  [McSceneStatus.READY]: [McSceneStatus.PENDING], // re-roll "veio errado" (generation++)
  [McSceneStatus.FAILED]: [McSceneStatus.PENDING], // re-roll/correção após needs_attention
  [McSceneStatus.CANCELED]: [],
};

/**
 * pending → queued → running → provider_wait → ingesting → succeeded
 * | failed|canceled|skipped_cached (plano §6.1).
 * - running → succeeded direto: steps síncronos (script/tts/assembly) não
 *   passam por provider_wait/ingesting.
 * - pending → skipped_cached: cache hit por input_hash no agendamento (§6.3).
 * - failed → queued: retry (política por classe de erro, §6.4).
 */
export const MC_STEP_TRANSITIONS: Record<McStepStatus, McStepStatus[]> = {
  [McStepStatus.PENDING]: [McStepStatus.QUEUED, McStepStatus.SKIPPED_CACHED, McStepStatus.CANCELED],
  [McStepStatus.QUEUED]: [McStepStatus.RUNNING, McStepStatus.FAILED, McStepStatus.CANCELED],
  [McStepStatus.RUNNING]: [
    McStepStatus.PROVIDER_WAIT,
    McStepStatus.INGESTING,
    McStepStatus.SUCCEEDED,
    McStepStatus.FAILED,
    McStepStatus.CANCELED,
  ],
  [McStepStatus.PROVIDER_WAIT]: [
    McStepStatus.INGESTING,
    McStepStatus.FAILED,
    McStepStatus.CANCELED,
  ],
  [McStepStatus.INGESTING]: [McStepStatus.SUCCEEDED, McStepStatus.FAILED],
  [McStepStatus.FAILED]: [McStepStatus.QUEUED], // retry
  [McStepStatus.SUCCEEDED]: [],
  [McStepStatus.CANCELED]: [],
  [McStepStatus.SKIPPED_CACHED]: [],
};

export const TERMINAL_PROJECT_STATUSES: readonly McProjectStatus[] = [
  McProjectStatus.SUCCEEDED,
  McProjectStatus.FAILED,
  McProjectStatus.CANCELED,
];

/** `skipped_cached` conta como sucesso para dependências do scheduler (§6.3). */
export const DONE_STEP_STATUSES: readonly McStepStatus[] = [
  McStepStatus.SUCCEEDED,
  McStepStatus.SKIPPED_CACHED,
];

export function canTransitionKit(from: McKitStatus, to: McKitStatus): boolean {
  return (MC_KIT_TRANSITIONS[from] ?? []).includes(to);
}

export function canTransitionProject(from: McProjectStatus, to: McProjectStatus): boolean {
  return (MC_PROJECT_TRANSITIONS[from] ?? []).includes(to);
}

export function canTransitionScene(from: McSceneStatus, to: McSceneStatus): boolean {
  return (MC_SCENE_TRANSITIONS[from] ?? []).includes(to);
}

export function canTransitionStep(from: McStepStatus, to: McStepStatus): boolean {
  return (MC_STEP_TRANSITIONS[from] ?? []).includes(to);
}

export class McInvalidTransitionError extends Error {
  constructor(
    public readonly kind: 'kit' | 'project' | 'scene' | 'step',
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Transição inválida de ${kind}: ${from} → ${to}`);
  }
}

export function assertKitTransition(from: McKitStatus, to: McKitStatus): void {
  if (!canTransitionKit(from, to)) throw new McInvalidTransitionError('kit', from, to);
}

export function assertProjectTransition(from: McProjectStatus, to: McProjectStatus): void {
  if (!canTransitionProject(from, to)) throw new McInvalidTransitionError('project', from, to);
}

export function assertSceneTransition(from: McSceneStatus, to: McSceneStatus): void {
  if (!canTransitionScene(from, to)) throw new McInvalidTransitionError('scene', from, to);
}

export function assertStepTransition(from: McStepStatus, to: McStepStatus): void {
  if (!canTransitionStep(from, to)) throw new McInvalidTransitionError('step', from, to);
}
