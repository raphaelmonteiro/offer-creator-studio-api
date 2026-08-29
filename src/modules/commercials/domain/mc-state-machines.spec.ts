import {
  MC_PROJECT_TRANSITIONS,
  MC_SCENE_TRANSITIONS,
  MC_STEP_TRANSITIONS,
  McInvalidTransitionError,
  McProjectStatus,
  McSceneStatus,
  McStepStatus,
  assertProjectTransition,
  assertSceneTransition,
  assertStepTransition,
  canTransitionProject,
  canTransitionScene,
  canTransitionStep,
} from './mc-state-machines';

describe('McStateMachines (plano-comerciais §6.1)', () => {
  const allProject = Object.values(McProjectStatus);
  const allScene = Object.values(McSceneStatus);
  const allStep = Object.values(McStepStatus);

  // Testes gerados a partir das próprias matrizes (fonte única de verdade)
  describe('matriz de projects', () => {
    for (const from of allProject) {
      for (const to of allProject) {
        const allowed = MC_PROJECT_TRANSITIONS[from].includes(to);
        it(`${from} → ${to} deve ser ${allowed ? 'permitida' : 'rejeitada'}`, () => {
          expect(canTransitionProject(from, to)).toBe(allowed);
          if (!allowed) {
            expect(() => assertProjectTransition(from, to)).toThrow(McInvalidTransitionError);
          }
        });
      }
    }
  });

  describe('matriz de scenes', () => {
    for (const from of allScene) {
      for (const to of allScene) {
        const allowed = MC_SCENE_TRANSITIONS[from].includes(to);
        it(`${from} → ${to} deve ser ${allowed ? 'permitida' : 'rejeitada'}`, () => {
          expect(canTransitionScene(from, to)).toBe(allowed);
          if (!allowed) {
            expect(() => assertSceneTransition(from, to)).toThrow(McInvalidTransitionError);
          }
        });
      }
    }
  });

  describe('matriz de steps', () => {
    for (const from of allStep) {
      for (const to of allStep) {
        const allowed = MC_STEP_TRANSITIONS[from].includes(to);
        it(`${from} → ${to} deve ser ${allowed ? 'permitida' : 'rejeitada'}`, () => {
          expect(canTransitionStep(from, to)).toBe(allowed);
          if (!allowed) {
            expect(() => assertStepTransition(from, to)).toThrow(McInvalidTransitionError);
          }
        });
      }
    }
  });

  it('gate humano: só storyboard_review aprova para generating', () => {
    expect(
      canTransitionProject(McProjectStatus.STORYBOARD_REVIEW, McProjectStatus.GENERATING),
    ).toBe(true);
    expect(canTransitionProject(McProjectStatus.DRAFT, McProjectStatus.GENERATING)).toBe(false);
    expect(canTransitionProject(McProjectStatus.SCRIPTING, McProjectStatus.GENERATING)).toBe(false);
  });

  it('needs_attention não é terminal: retoma para generating (plano §6.4)', () => {
    expect(canTransitionProject(McProjectStatus.NEEDS_ATTENTION, McProjectStatus.GENERATING)).toBe(
      true,
    );
  });

  it('estados terminais não têm saída (exceto retry/re-roll documentados)', () => {
    // succeeded reabre APENAS para generating: re-roll/regravação pós-entrega (B1b)
    expect(MC_PROJECT_TRANSITIONS[McProjectStatus.SUCCEEDED]).toEqual([McProjectStatus.GENERATING]);
    expect(MC_PROJECT_TRANSITIONS[McProjectStatus.FAILED]).toHaveLength(0);
    expect(MC_PROJECT_TRANSITIONS[McProjectStatus.CANCELED]).toHaveLength(0);
    // cena: ready/failed voltam a pending no re-roll (generation++)
    expect(MC_SCENE_TRANSITIONS[McSceneStatus.READY]).toEqual([McSceneStatus.PENDING]);
    expect(MC_SCENE_TRANSITIONS[McSceneStatus.FAILED]).toEqual([McSceneStatus.PENDING]);
    expect(MC_SCENE_TRANSITIONS[McSceneStatus.CANCELED]).toHaveLength(0);
    // step: failed → queued é o retry; succeeded/canceled/skipped_cached são finais
    expect(MC_STEP_TRANSITIONS[McStepStatus.FAILED]).toEqual([McStepStatus.QUEUED]);
    expect(MC_STEP_TRANSITIONS[McStepStatus.SUCCEEDED]).toHaveLength(0);
    expect(MC_STEP_TRANSITIONS[McStepStatus.CANCELED]).toHaveLength(0);
    expect(MC_STEP_TRANSITIONS[McStepStatus.SKIPPED_CACHED]).toHaveLength(0);
  });

  it('property: sequência aleatória de transições válidas nunca sai do grafo', () => {
    for (let run = 0; run < 200; run++) {
      let current = McProjectStatus.DRAFT;
      for (let step = 0; step < 20; step++) {
        const options = MC_PROJECT_TRANSITIONS[current];
        if (options.length === 0) break;
        const next = options[Math.floor(Math.random() * options.length)];
        expect(() => assertProjectTransition(current, next)).not.toThrow();
        current = next;
        expect(allProject).toContain(current);
      }
    }
  });
});
