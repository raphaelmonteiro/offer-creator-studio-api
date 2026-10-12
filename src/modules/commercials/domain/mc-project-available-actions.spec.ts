import { availableProjectActions } from './mc-project-available-actions';
import { McProjectStatus, McStepStatus } from './mc-state-machines';
import { McStepType } from './mc-types';

describe('availableProjectActions — ações da UI em needs_attention (spec "Motor indisponível")', () => {
  const failedTalk = {
    sceneId: 'sc1',
    type: McStepType.TALK,
    status: McStepStatus.FAILED,
    projectRevision: 1,
  };

  it('falha terminal do talk em projeto PREMIUM → "refazer" e "duplicar como econômico"', () => {
    expect(
      availableProjectActions(
        { status: McProjectStatus.NEEDS_ATTENTION, tier: 'premium', revision: 1 },
        [failedTalk],
      ),
    ).toEqual(['refazer', 'duplicar_como_economico']);
  });

  it('projeto econômico com talk falhado → só "refazer"', () => {
    expect(
      availableProjectActions(
        { status: McProjectStatus.NEEDS_ATTENTION, tier: 'economico', revision: 1 },
        [failedTalk],
      ),
    ).toEqual(['refazer']);
  });

  it('premium com falha de OUTRO step (tts) → só "refazer" (não é o motor de fala)', () => {
    expect(
      availableProjectActions(
        { status: McProjectStatus.NEEDS_ATTENTION, tier: 'premium', revision: 1 },
        [{ ...failedTalk, type: McStepType.TTS }],
      ),
    ).toEqual(['refazer']);
  });

  it('fora de needs_attention, ou sem step de cena falhado na revisão corrente, nada', () => {
    expect(
      availableProjectActions({ status: McProjectStatus.GENERATING, tier: 'premium' }, [
        failedTalk,
      ]),
    ).toEqual([]);
    expect(
      availableProjectActions(
        { status: McProjectStatus.NEEDS_ATTENTION, tier: 'premium', revision: 2 },
        [failedTalk], // revisão 1 — antiga
      ),
    ).toEqual([]);
    expect(
      availableProjectActions(
        { status: McProjectStatus.NEEDS_ATTENTION, tier: 'premium', revision: 1 },
        [{ ...failedTalk, status: McStepStatus.SUCCEEDED }],
      ),
    ).toEqual([]);
    expect(
      availableProjectActions(
        { status: McProjectStatus.NEEDS_ATTENTION, tier: 'premium', revision: 1 },
        [{ ...failedTalk, sceneId: null, type: McStepType.ASSEMBLY }],
      ),
    ).toEqual([]);
  });
});
