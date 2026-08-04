import {
  RENDER_TRANSITIONS,
  RenderStatus,
  TASK_TRANSITIONS,
  TaskStatus,
  assertTaskTransition,
  canTransitionRender,
  canTransitionTask,
  InvalidTransitionError,
} from './task-state-machine';

describe('TaskStateMachine (TDD §3.6)', () => {
  const allTaskStatuses = Object.values(TaskStatus);
  const allRenderStatuses = Object.values(RenderStatus);

  // Testes gerados a partir da própria matriz (fonte única de verdade)
  describe('matriz de tasks', () => {
    for (const from of allTaskStatuses) {
      for (const to of allTaskStatuses) {
        const allowed = TASK_TRANSITIONS[from].includes(to);
        it(`${from} → ${to} deve ser ${allowed ? 'permitida' : 'rejeitada'}`, () => {
          expect(canTransitionTask(from, to)).toBe(allowed);
          if (!allowed) {
            expect(() => assertTaskTransition(from, to)).toThrow(InvalidTransitionError);
          }
        });
      }
    }
  });

  describe('matriz de renders', () => {
    for (const from of allRenderStatuses) {
      for (const to of allRenderStatuses) {
        it(`${from} → ${to}`, () => {
          expect(canTransitionRender(from, to)).toBe(RENDER_TRANSITIONS[from].includes(to));
        });
      }
    }
  });

  it('estados terminais não têm saída (exceto failed→queued para retry)', () => {
    expect(TASK_TRANSITIONS[TaskStatus.SUCCEEDED]).toHaveLength(0);
    expect(TASK_TRANSITIONS[TaskStatus.CANCELED]).toHaveLength(0);
    expect(TASK_TRANSITIONS[TaskStatus.FAILED]).toEqual([TaskStatus.QUEUED]);
    expect(RENDER_TRANSITIONS[RenderStatus.SUCCEEDED]).toHaveLength(0);
    expect(RENDER_TRANSITIONS[RenderStatus.FAILED]).toHaveLength(0);
  });

  it('property: sequência aleatória de transições válidas nunca sai do grafo', () => {
    for (let run = 0; run < 200; run++) {
      let current = TaskStatus.QUEUED;
      for (let step = 0; step < 20; step++) {
        const options = TASK_TRANSITIONS[current];
        if (options.length === 0) break;
        const next = options[Math.floor(Math.random() * options.length)];
        expect(() => assertTaskTransition(current, next)).not.toThrow();
        current = next;
        expect(allTaskStatuses).toContain(current);
      }
    }
  });
});
