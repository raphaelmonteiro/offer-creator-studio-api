import { EntityManager } from 'typeorm';
import { TaskTransitionService } from './task-transition.service';
import { TaskStatus, RenderStatus, InvalidTransitionError } from '../domain/task-state-machine';

/**
 * Idempotência/concorrência das transições CAS (TDD §3.6): simula o banco com
 * um registro em memória — o UPDATE condicional só afeta 1 linha se o status
 * atual bate com o `from`, exatamente como `UPDATE ... WHERE status = $from`.
 */
function fakeManager(initialStatus: string) {
  const record = {
    id: 't1',
    status: initialStatus,
    userId: 'u1',
    currentStepIndex: 0,
    pipeline: [{ label: 'Gerando voz' }],
    progressPct: 0,
  };
  const events: Array<{ fromStatus: string; toStatus: string }> = [];
  const notifications: string[] = [];
  const manager = {
    record,
    events,
    notifications,
    createQueryBuilder: jest.fn(() => {
      let setPatch: Record<string, unknown>;
      let fromStatus: string;
      const qb = {
        update: () => qb,
        set: (patch: Record<string, unknown>) => {
          setPatch = patch;
          return qb;
        },
        where: (_sql: string, params: { from: string }) => {
          fromStatus = params.from;
          return qb;
        },
        execute: () => {
          // CAS: só atualiza se o status atual é o esperado
          if (record.status === fromStatus) {
            Object.assign(record, setPatch);
            return Promise.resolve({ affected: 1 });
          }
          return Promise.resolve({ affected: 0 });
        },
      };
      return qb;
    }),
    findOneByOrFail: jest.fn(() => Promise.resolve(record)),
    findOneBy: jest.fn(() => Promise.resolve(record)),
    insert: jest.fn((_entity: unknown, event: { fromStatus: string; toStatus: string }) => {
      events.push(event);
      return Promise.resolve();
    }),
    update: jest.fn((_e: unknown, _w: unknown, patch: Record<string, unknown>) => {
      Object.assign(record, patch);
      return Promise.resolve();
    }),
    query: jest.fn((sql: string) => {
      if (sql.includes('pg_notify')) notifications.push(sql);
      return Promise.resolve();
    }),
  };
  return manager as unknown as EntityManager & typeof manager;
}

describe('TaskTransitionService — CAS e idempotência (TDD §3.6)', () => {
  const service = new TaskTransitionService();

  it('transição válida vence e grava evento de auditoria + pg_notify', async () => {
    const manager = fakeManager(TaskStatus.QUEUED);
    const won = await service.transitionTask(
      manager,
      't1',
      TaskStatus.QUEUED,
      TaskStatus.PREPARING,
    );
    expect(won).toBe(true);
    expect(manager.record.status).toBe(TaskStatus.PREPARING);
    expect(manager.events).toEqual([
      {
        taskId: 't1',
        userId: 'u1',
        kind: 'task',
        fromStatus: 'queued',
        toStatus: 'preparing',
        detail: {},
      },
    ]);
    expect(manager.notifications).toHaveLength(1);
  });

  it('webhook duplicado: segunda transição idêntica vira no-op sem evento', async () => {
    const manager = fakeManager(TaskStatus.PROVIDER_PROCESSING);
    const first = await service.transitionTask(
      manager,
      't1',
      TaskStatus.PROVIDER_PROCESSING,
      TaskStatus.INGESTING,
    );
    const duplicate = await service.transitionTask(
      manager,
      't1',
      TaskStatus.PROVIDER_PROCESSING,
      TaskStatus.INGESTING,
    );
    expect(first).toBe(true);
    expect(duplicate).toBe(false);
    expect(manager.events).toHaveLength(1); // exatamente 1 evento
  });

  it('webhook × poll concorrentes: exatamente 1 vence', async () => {
    const manager = fakeManager(TaskStatus.PROVIDER_PROCESSING);
    const [a, b] = await Promise.all([
      service.transitionTask(manager, 't1', TaskStatus.PROVIDER_PROCESSING, TaskStatus.INGESTING),
      service.transitionTask(manager, 't1', TaskStatus.PROVIDER_PROCESSING, TaskStatus.INGESTING),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(manager.events).toHaveLength(1);
  });

  it('transição fora da matriz é rejeitada antes de tocar o banco', async () => {
    const manager = fakeManager(TaskStatus.QUEUED);
    await expect(
      service.transitionTask(manager, 't1', TaskStatus.QUEUED, TaskStatus.SUCCEEDED),
    ).rejects.toThrow(InvalidTransitionError);
    expect(manager.record.status).toBe(TaskStatus.QUEUED);
    expect(manager.events).toHaveLength(0);
  });

  it('render: cancel em compositing vence; em encoding não existe', async () => {
    const manager = fakeManager(RenderStatus.COMPOSITING);
    const won = await service.transitionRender(
      manager,
      't1',
      RenderStatus.COMPOSITING,
      RenderStatus.CANCELED,
    );
    expect(won).toBe(true);
    await expect(
      service.transitionRender(manager, 't1', RenderStatus.ENCODING, RenderStatus.CANCELED),
    ).rejects.toThrow(InvalidTransitionError);
  });
});
