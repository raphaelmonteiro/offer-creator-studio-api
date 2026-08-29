import {
  MC_KIT_CREDITS,
  MC_PROJECT_MINI_RESERVE_CREDITS,
  MC_STEP_CREDITS,
  custoDaCena,
  custoDoProjeto,
  stepsDaCena,
} from './mc-pricing.config';
import { McStepType } from './mc-types';

describe('mc-pricing.config (plano-comerciais §8)', () => {
  it('cena sem fala custa 90 cr (keyframe 1 + video 89)', () => {
    expect(custoDaCena({ dialogue: null })).toBe(90);
    expect(stepsDaCena({ dialogue: null })).toEqual([McStepType.KEYFRAME, McStepType.VIDEO]);
  });

  it('cena falada custa 150 cr (keyframe 1 + video 89 + tts 4 + lipsync 56)', () => {
    expect(custoDaCena({ dialogue: 'Bem-vindo às ofertas da semana!' })).toBe(150);
    expect(stepsDaCena({ dialogue: 'Olá!' })).toEqual([
      McStepType.KEYFRAME,
      McStepType.VIDEO,
      McStepType.TTS,
      McStepType.LIPSYNC,
    ]);
  });

  it('dialogue vazio conta como cena muda (sem tts/lipsync)', () => {
    expect(custoDaCena({ dialogue: '' })).toBe(90);
  });

  it('script e assembly são inclusos (custo 0 na tabela)', () => {
    expect(MC_STEP_CREDITS[McStepType.SCRIPT]).toBe(0);
    expect(MC_STEP_CREDITS[McStepType.ASSEMBLY]).toBe(0);
  });

  it('custoDoProjeto soma as cenas do roteiro (2 faladas + 2 mudas = 480)', () => {
    const script = {
      scenes: [
        { idx: 0, actionPrompt: 'abre', dialogue: 'Olá!', durationS: 8 },
        { idx: 1, actionPrompt: 'mostra produto', dialogue: null, durationS: 6 },
        { idx: 2, actionPrompt: 'aponta preço', dialogue: null, durationS: 6 },
        { idx: 3, actionPrompt: 'fecha', dialogue: 'Corre pra loja!', durationS: 8 },
      ],
    };
    // 150 + 90 + 90 + 150 — dentro da faixa de 480–600 cr do comercial de 30s (§8)
    expect(custoDoProjeto(script)).toBe(480);
  });

  it('roteiro vazio custa 0 (nada além de script/assembly inclusos)', () => {
    expect(custoDoProjeto({ scenes: [] })).toBe(0);
  });

  it('constantes do plano: kit 30 cr, mini-reserva de projeto 10 cr', () => {
    expect(MC_KIT_CREDITS).toBe(30);
    expect(MC_PROJECT_MINI_RESERVE_CREDITS).toBe(10);
  });
});
