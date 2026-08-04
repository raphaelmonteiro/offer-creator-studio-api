/**
 * Máquina de estados formal de animation_tasks e render_jobs (TDD §3.6).
 * Fonte única de verdade: os testes são gerados a partir destas matrizes.
 * Transições fora da matriz são rejeitadas — chamadores fazem CAS no banco
 * (`UPDATE ... WHERE status = from`), então um evento duplicado vira no-op.
 */

export enum TaskStatus {
  QUEUED = 'queued',
  PREPARING = 'preparing',
  SUBMITTED = 'submitted',
  PROVIDER_PROCESSING = 'provider_processing',
  INGESTING = 'ingesting',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELED = 'canceled',
}

export enum RenderStatus {
  QUEUED = 'queued',
  COMPOSITING = 'compositing',
  ENCODING = 'encoding',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELED = 'canceled',
}

export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  [TaskStatus.QUEUED]: [TaskStatus.PREPARING, TaskStatus.CANCELED],
  [TaskStatus.PREPARING]: [TaskStatus.SUBMITTED, TaskStatus.FAILED],
  [TaskStatus.SUBMITTED]: [TaskStatus.PROVIDER_PROCESSING, TaskStatus.FAILED],
  [TaskStatus.PROVIDER_PROCESSING]: [
    TaskStatus.INGESTING,
    TaskStatus.FAILED,
    // pipeline N→N+1: próxima etapa volta a submeter
    TaskStatus.SUBMITTED,
  ],
  [TaskStatus.INGESTING]: [
    TaskStatus.SUCCEEDED,
    // resultado da etapa vira input da próxima
    TaskStatus.PREPARING,
    TaskStatus.FAILED,
  ],
  [TaskStatus.FAILED]: [TaskStatus.QUEUED], // retry
  [TaskStatus.SUCCEEDED]: [],
  [TaskStatus.CANCELED]: [],
};

export const RENDER_TRANSITIONS: Record<RenderStatus, RenderStatus[]> = {
  [RenderStatus.QUEUED]: [RenderStatus.COMPOSITING, RenderStatus.CANCELED],
  [RenderStatus.COMPOSITING]: [RenderStatus.ENCODING, RenderStatus.FAILED, RenderStatus.CANCELED],
  [RenderStatus.ENCODING]: [RenderStatus.SUCCEEDED, RenderStatus.FAILED],
  [RenderStatus.SUCCEEDED]: [],
  [RenderStatus.FAILED]: [],
  [RenderStatus.CANCELED]: [],
};

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  TaskStatus.SUCCEEDED,
  TaskStatus.CANCELED,
];

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return (TASK_TRANSITIONS[from] ?? []).includes(to);
}

export function canTransitionRender(from: RenderStatus, to: RenderStatus): boolean {
  return (RENDER_TRANSITIONS[from] ?? []).includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly kind: 'task' | 'render',
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Transição inválida de ${kind}: ${from} → ${to}`);
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) throw new InvalidTransitionError('task', from, to);
}

export function assertRenderTransition(from: RenderStatus, to: RenderStatus): void {
  if (!canTransitionRender(from, to)) throw new InvalidTransitionError('render', from, to);
}
