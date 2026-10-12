import {
  MC_KIT_TRANSITIONS,
  MC_PROJECT_TRANSITIONS,
  MC_SCENE_TRANSITIONS,
  MC_STEP_TRANSITIONS,
  McInvalidTransitionError,
  McKitStatus,
  McProjectStatus,
  McSceneStatus,
  McStepStatus,
  assertKitTransition,
  assertProjectTransition,
  assertSceneTransition,
  assertStepTransition,
  canTransitionKit,
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
    // succeeded reabre para generating (re-roll pós-entrega, B1b) e, no pipeline
    // v2 (ADR-001 §4.1), para nova revisão editorial ou correção só de composição.
    expect(MC_PROJECT_TRANSITIONS[McProjectStatus.SUCCEEDED]).toEqual([
      McProjectStatus.GENERATING,
      McProjectStatus.STORYBOARD_REVIEW,
      McProjectStatus.VISUAL_REVIEW,
    ]);
    // v2: preparação não volta ao roteiro sem passar por revisão/cancelamento
    expect(MC_PROJECT_TRANSITIONS[McProjectStatus.PREPARING]).not.toContain(
      McProjectStatus.STORYBOARD_REVIEW,
    );
    expect(MC_PROJECT_TRANSITIONS[McProjectStatus.PREPARING]).not.toContain(
      McProjectStatus.GENERATING,
    );
    // v2: da revisão visual nunca se vai direto para assembling sem aprovação editorial — a
    // transição existe, mas quem a dispara é o approve-assembly (testado no service)
    expect(MC_PROJECT_TRANSITIONS[McProjectStatus.VISUAL_REVIEW]).toContain(
      McProjectStatus.GENERATING,
    );
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

/**
 * Change video-formatos-personagem (D4): `candidates` entre `generating` e a
 * escolha do candidato; `review → generating` para identidade trocada;
 * `candidates → review` para "usar o logo como está".
 */
describe('McStateMachines — matriz de kits (candidatos, D4)', () => {
  const allKit = Object.values(McKitStatus);

  for (const from of allKit) {
    for (const to of allKit) {
      const allowed = MC_KIT_TRANSITIONS[from].includes(to);
      it(`${from} → ${to} deve ser ${allowed ? 'permitida' : 'rejeitada'}`, () => {
        expect(canTransitionKit(from, to)).toBe(allowed);
        if (!allowed) {
          expect(() => assertKitTransition(from, to)).toThrow(McInvalidTransitionError);
        }
      });
    }
  }

  it('rodada de candidatos: generating → candidates → generating (nova rodada ou escolha) | failed', () => {
    expect(canTransitionKit(McKitStatus.GENERATING, McKitStatus.CANDIDATES)).toBe(true);
    expect(canTransitionKit(McKitStatus.CANDIDATES, McKitStatus.GENERATING)).toBe(true);
    expect(canTransitionKit(McKitStatus.CANDIDATES, McKitStatus.FAILED)).toBe(true);
    // candidatos nunca aprovam direto: referências e revisão vêm antes
    expect(canTransitionKit(McKitStatus.CANDIDATES, McKitStatus.APPROVED)).toBe(false);
  });

  it('"usar como está": candidates → review sem passar por generating', () => {
    expect(canTransitionKit(McKitStatus.CANDIDATES, McKitStatus.REVIEW)).toBe(true);
  });

  it('identidade trocada em revisão reabre a geração das referências (review → generating)', () => {
    expect(canTransitionKit(McKitStatus.REVIEW, McKitStatus.GENERATING)).toBe(true);
    // kit aprovado é imutável: nunca volta
    expect(canTransitionKit(McKitStatus.APPROVED, McKitStatus.GENERATING)).toBe(false);
    expect(canTransitionKit(McKitStatus.APPROVED, McKitStatus.CANDIDATES)).toBe(false);
  });

  it('caminhos de review/approved preservados', () => {
    expect(canTransitionKit(McKitStatus.GENERATING, McKitStatus.REVIEW)).toBe(true);
    expect(canTransitionKit(McKitStatus.REVIEW, McKitStatus.APPROVED)).toBe(true);
    expect(canTransitionKit(McKitStatus.APPROVED, McKitStatus.ARCHIVED)).toBe(true);
    expect(MC_KIT_TRANSITIONS[McKitStatus.FAILED]).toEqual([]);
    expect(MC_KIT_TRANSITIONS[McKitStatus.ARCHIVED]).toEqual([]);
  });
});
