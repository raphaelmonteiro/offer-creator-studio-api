import {
  legacySceneType,
  phaseOfStep,
  planSteps,
  resolveSceneType,
  scenePlan,
  sceneTypeDialogueIssue,
} from './mc-execution-plan';
import { McStepType } from './mc-types';

describe('mc-execution-plan — grafo por tipo de cena (ADR §3.1)', () => {
  it('presenter: keyframe+tts → lipsync (Avatar); final = lipsync', () => {
    const plan = scenePlan('presenter');
    expect(plan.preparation).toEqual([McStepType.KEYFRAME, McStepType.TTS]);
    expect(plan.production).toEqual([McStepType.LIPSYNC]);
    expect(plan.final).toBe(McStepType.LIPSYNC);
    expect(plan.usesAvatar).toBe(true);
    expect(plan.usesActionEngine).toBe(false);
  });

  it('action: keyframe → video; sem TTS; final = video', () => {
    const plan = scenePlan('action');
    expect(planSteps(plan)).toEqual([McStepType.KEYFRAME, McStepType.VIDEO]);
    expect(plan.hasTts).toBe(false);
    expect(plan.final).toBe(McStepType.VIDEO);
  });

  it('action_voiceover: keyframe+tts → video → scene_compose; NUNCA Avatar; final = scene_compose', () => {
    const plan = scenePlan('action_voiceover');
    expect(plan.production).toEqual([McStepType.VIDEO, McStepType.SCENE_COMPOSE]);
    expect(plan.production).not.toContain(McStepType.LIPSYNC);
    expect(plan.deps[McStepType.SCENE_COMPOSE]).toEqual([McStepType.VIDEO, McStepType.TTS]);
    expect(plan.final).toBe(McStepType.SCENE_COMPOSE);
    expect(plan.usesAvatar).toBe(false);
    expect(phaseOfStep(plan, McStepType.TTS)).toBe('preparation');
    expect(phaseOfStep(plan, McStepType.SCENE_COMPOSE)).toBe('production');
    expect(phaseOfStep(plan, McStepType.ASSEMBLY)).toBeNull();
  });

  it('tipo legado por diálogo só quando não há tipo gravado', () => {
    expect(legacySceneType('Oi')).toBe('presenter');
    expect(legacySceneType(null)).toBe('action');
    expect(resolveSceneType({ sceneType: 'action_voiceover', dialogue: 'Oi' })).toBe(
      'action_voiceover',
    );
    expect(resolveSceneType({ sceneType: null, dialogue: 'Oi' })).toBe('presenter');
  });

  it('validação fala × tipo', () => {
    expect(sceneTypeDialogueIssue('presenter', null)).toMatch(/precisa de fala/);
    expect(sceneTypeDialogueIssue('action_voiceover', '')).toMatch(/precisa de fala/);
    expect(sceneTypeDialogueIssue('action', 'Oi')).toMatch(/action_voiceover/);
    expect(sceneTypeDialogueIssue('action', null)).toBeNull();
    expect(sceneTypeDialogueIssue('presenter', 'Oi')).toBeNull();
  });

  it('tipo desconhecido lança', () => {
    expect(() => scenePlan('foo' as never)).toThrow(/desconhecido/);
  });
});
