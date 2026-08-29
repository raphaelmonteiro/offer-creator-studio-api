import { Injectable } from '@nestjs/common';
import { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import { AnimationTask } from '../../modules/animations/entities/animation-task.entity';
import { RenderJob } from '../../modules/animations/entities/render-job.entity';
import { AnimationTaskEvent } from './animation-task-event.entity';
import {
  RenderStatus,
  TaskStatus,
  assertRenderTransition,
  assertTaskTransition,
} from './task-state-machine';

/** Canal pg_notify do barramento worker → API (TDD ADR-03). */
export const EVENTS_CHANNEL = 'animation_events';

/**
 * Transições CAS (TDD §3.6): `UPDATE ... WHERE id AND status = from`.
 * Um webhook duplicado ou um poll que perde a corrida afeta 0 linhas e vira
 * no-op — idempotência por construção, sem lock pessimista.
 *
 * Infraestrutura compartilhada (plano-comerciais §11): o MECANISMO
 * (CAS + evento de auditoria + pg_notify na mesma transação) está exposto nos
 * métodos genéricos `casTransition`/`appendEvent`/`notify` — módulos novos
 * definem suas próprias matrizes de estado e compõem esses três passos.
 * `transitionTask`/`transitionRender` são a composição usada pelo módulo
 * animations, preservada byte a byte.
 */
@Injectable()
export class TaskTransitionService {
  /**
   * Núcleo genérico do CAS: atualiza a entidade apenas se `status = from`.
   * @returns true se ESTA chamada venceu a transição; false = alguém já transicionou.
   */
  async casTransition<Entity extends ObjectLiteral>(
    manager: EntityManager,
    entity: EntityTarget<Entity>,
    id: string,
    from: string,
    to: string,
    patch: Record<string, unknown> = {},
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(entity)
      .set({ ...patch, status: to })
      .where('id = :id AND status = :from', { id, from })
      .execute();
    return (result.affected ?? 0) === 1;
  }

  /** Evento de auditoria (trilha do timeline da UI e do replay SSE). */
  async appendEvent(
    manager: EntityManager,
    event: {
      taskId: string;
      userId: string;
      kind: 'task' | 'render';
      fromStatus: string;
      toStatus: string;
      detail: Record<string, unknown>;
    },
  ): Promise<void> {
    await manager.insert(AnimationTaskEvent, event);
  }

  /** pg_notify na MESMA transação: barramento worker → API para o fan-out SSE (TDD ADR-03). */
  async notify(
    manager: EntityManager,
    userId: string,
    payload: Record<string, unknown>,
    channel: string = EVENTS_CHANNEL,
  ): Promise<void> {
    await manager.query(`SELECT pg_notify($1, $2)`, [
      channel,
      JSON.stringify({ userId, at: new Date().toISOString(), ...payload }),
    ]);
  }

  /** @returns true se ESTA chamada venceu a transição; false = alguém já transicionou. */
  async transitionTask(
    manager: EntityManager,
    taskId: string,
    from: TaskStatus,
    to: TaskStatus,
    patch: Partial<AnimationTask> = {},
    detail: Record<string, unknown> = {},
  ): Promise<boolean> {
    assertTaskTransition(from, to);
    const won = await this.casTransition(manager, AnimationTask, taskId, from, to, patch);
    if (won) {
      const task = await manager.findOneByOrFail(AnimationTask, { id: taskId });
      await this.appendEvent(manager, {
        taskId,
        userId: task.userId,
        kind: 'task',
        fromStatus: from,
        toStatus: to,
        detail,
      });
      await this.notify(manager, task.userId, {
        taskId,
        kind: 'task',
        status: to,
        stepIndex: task.currentStepIndex,
        stepLabel: task.pipeline?.[task.currentStepIndex]?.label ?? null,
      });
    }
    return won;
  }

  async transitionRender(
    manager: EntityManager,
    renderId: string,
    from: RenderStatus,
    to: RenderStatus,
    patch: Partial<RenderJob> = {},
    detail: Record<string, unknown> = {},
  ): Promise<boolean> {
    assertRenderTransition(from, to);
    const won = await this.casTransition(manager, RenderJob, renderId, from, to, patch);
    if (won) {
      const job = await manager.findOneByOrFail(RenderJob, { id: renderId });
      await this.appendEvent(manager, {
        taskId: renderId,
        userId: job.userId,
        kind: 'render',
        fromStatus: from,
        toStatus: to,
        detail,
      });
      await this.notify(manager, job.userId, {
        renderId,
        kind: 'render',
        status: to,
        progressPct: job.progressPct,
      });
    }
    return won;
  }

  /** Progresso de render não é transição — update simples + notify (throttle no chamador). */
  async reportRenderProgress(
    manager: EntityManager,
    renderId: string,
    progressPct: number,
  ): Promise<void> {
    await manager.update(RenderJob, { id: renderId }, { progressPct });
    const job = await manager.findOneBy(RenderJob, { id: renderId });
    if (job) {
      await this.notify(manager, job.userId, {
        renderId,
        kind: 'render',
        status: job.status,
        progressPct,
      });
    }
  }
}
