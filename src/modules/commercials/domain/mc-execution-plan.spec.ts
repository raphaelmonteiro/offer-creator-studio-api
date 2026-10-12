import {
  isSceneType,
  legacySceneType,
  phaseOfStep,
  planSteps,
  resolveSceneType,
  scenePlan,
  sceneTypeDialogueIssue,
  sceneUsesKeyframe,
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

describe('mc-execution-plan — talk_tile (change video-formatos-personagem, D6/D7)', () => {
  it('talk_tile: tts → talk; final = talk; sem keyframe em nenhuma fase', () => {
    const plan = scenePlan('talk_tile');
    expect(plan.preparation).toEqual([McStepType.TTS]);
    expect(plan.production).toEqual([McStepType.TALK]);
    expect(plan.final).toBe(McStepType.TALK);
    expect(plan.deps[McStepType.TALK]).toEqual([McStepType.TTS]);
    expect(plan.hasTts).toBe(true);
    expect(plan.usesAvatar).toBe(true);
    expect(plan.usesActionEngine).toBe(false);
    expect(planSteps(plan)).not.toContain(McStepType.KEYFRAME);
    expect(phaseOfStep(plan, McStepType.TTS)).toBe('preparation');
    expect(phaseOfStep(plan, McStepType.TALK)).toBe('production');
    expect(phaseOfStep(plan, McStepType.KEYFRAME)).toBeNull();
  });

  it('isSceneType aceita talk_tile; sceneUsesKeyframe distingue os planos com imagem gerada', () => {
    expect(isSceneType('talk_tile')).toBe(true);
    expect(isSceneType('talk')).toBe(false);
    expect(sceneUsesKeyframe('talk_tile')).toBe(false);
    expect(sceneUsesKeyframe('presenter')).toBe(true);
    expect(sceneUsesKeyframe('action')).toBe(true);
    expect(sceneUsesKeyframe('action_voiceover')).toBe(true);
  });

  it('talk_tile exige fala (uma fala, um clipe)', () => {
    expect(sceneTypeDialogueIssue('talk_tile', null)).toMatch(/precisa de fala/);
    expect(sceneTypeDialogueIssue('talk_tile', 'Olá!')).toBeNull();
  });
});
