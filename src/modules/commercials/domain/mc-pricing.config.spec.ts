import {
  MC_KIT_CREDITS,
  MC_MUSIC_CREDITS,
  MC_PROJECT_MINI_RESERVE_CREDITS,
  MC_STEP_CREDITS,
  custoDaCena,
  custoDoProjeto,
  projectStepCredits,
  quotePhase,
  stepsDaCena,
} from './mc-pricing.config';
import { McStepType, defaultMusicEnabled } from './mc-types';

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

  describe('trilha (achado 5 da 3.7): escolha explícita e no custo antes da produção', () => {
    it('default por formato: F3 ligada (v1-B1); F1/F2 desligada', () => {
      expect(defaultMusicEnabled('scenes')).toBe(true);
      expect(defaultMusicEnabled(null)).toBe(true);
      expect(defaultMusicEnabled('talking_art')).toBe(false);
      expect(defaultMusicEnabled('offer_carousel')).toBe(false);
    });

    it('a trilha soma só no finalize, e só quando pedida', () => {
      expect(projectStepCredits(McStepType.FINALIZE, { musicEnabled: true })).toBe(
        MC_STEP_CREDITS[McStepType.FINALIZE] + MC_MUSIC_CREDITS,
      );
      expect(projectStepCredits(McStepType.FINALIZE, { musicEnabled: false })).toBe(
        MC_STEP_CREDITS[McStepType.FINALIZE],
      );
      expect(projectStepCredits(McStepType.COMPOSE_FFMPEG, { musicEnabled: true })).toBe(
        MC_STEP_CREDITS[McStepType.COMPOSE_FFMPEG],
      );
      // F3 não muda nesta change: a trilha do assembly segue inclusa
      expect(projectStepCredits(McStepType.ASSEMBLY, { musicEnabled: true })).toBe(
        MC_STEP_CREDITS[McStepType.ASSEMBLY],
      );
    });

    it.each(['talking_art', 'offer_carousel'] as const)(
      'cotação da produção do %s muda com a trilha',
      (format) => {
        const scenes = [{ sceneId: 's1', sceneType: 'talk_tile' as const, cached: [] }];
        const off = quotePhase('production', 3, scenes, { format, musicEnabled: false });
        const on = quotePhase('production', 3, scenes, { format, musicEnabled: true });
        expect(on.totalCredits - off.totalCredits).toBe(MC_MUSIC_CREDITS);
        expect(on.items.find((i) => i.stepType === McStepType.FINALIZE)?.credits).toBe(
          MC_MUSIC_CREDITS,
        );
        // fase assembly (remontagem) também cota a trilha
        expect(
          quotePhase('assembly', 3, [], { format, musicEnabled: true }).totalCredits -
            quotePhase('assembly', 3, [], { format }).totalCredits,
        ).toBe(MC_MUSIC_CREDITS);
      },
    );
  });
});
