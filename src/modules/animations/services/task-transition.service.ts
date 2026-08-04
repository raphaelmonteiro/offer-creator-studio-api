import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AnimationTask } from '../entities/animation-task.entity';
import { RenderJob } from '../entities/render-job.entity';
import { AnimationTaskEvent } from '../entities/animation-task-event.entity';
import {
  RenderStatus,
  TaskStatus,
  assertRenderTransition,
  assertTaskTransition,
} from '../domain/task-state-machine';

/**
 * Transições CAS (TDD §3.6): `UPDATE ... WHERE id AND status = from`.
 * Um webhook duplicado ou um poll que perde a corrida afeta 0 linhas e vira
 * no-op — idempotência por construção, sem lock pessimista.
 */
@Injectable()
export class TaskTransitionService {
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
    const result = await manager
      .createQueryBuilder()
      .update(AnimationTask)
      .set({ ...patch, status: to })
      .where('id = :taskId AND status = :from', { taskId, from })
      .execute();
    const won = (result.affected ?? 0) === 1;
    if (won) {
      const task = await manager.findOneByOrFail(AnimationTask, { id: taskId });
      await manager.insert(AnimationTaskEvent, {
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
    const result = await manager
      .createQueryBuilder()
      .update(RenderJob)
      .set({ ...patch, status: to })
      .where('id = :renderId AND status = :from', { renderId, from })
      .execute();
    const won = (result.affected ?? 0) === 1;
    if (won) {
      const job = await manager.findOneByOrFail(RenderJob, { id: renderId });
      await manager.insert(AnimationTaskEvent, {
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

  /** pg_notify: barramento worker → API para o fan-out SSE (TDD ADR-03). */
  private async notify(
    manager: EntityManager,
    userId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await manager.query(`SELECT pg_notify('animation_events', $1)`, [
      JSON.stringify({ userId, at: new Date().toISOString(), ...payload }),
    ]);
  }
}
