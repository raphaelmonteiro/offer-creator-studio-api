import { computeInputHash, MC_BUILDER_VERSIONS } from './input-hash';
import { McStepType } from './mc-types';

describe('computeInputHash (plano-comerciais §6.3)', () => {
  const base = { briefing: 'Oferta de arroz', aspectRatio: '9:16', targetDurationS: 10 };

  it('é determinístico para a mesma entrada', () => {
    const a = computeInputHash(McStepType.SCRIPT, 1, base);
    const b = computeInputHash(McStepType.SCRIPT, 1, { ...base });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('é insensível à ordem das chaves, inclusive aninhadas', () => {
    const a = computeInputHash(McStepType.VIDEO, 1, {
      scene: { actionPrompt: 'acena', durationS: 10 },
      kit: { id: 'k1', version: 2 },
    });
    const b = computeInputHash(McStepType.VIDEO, 1, {
      kit: { version: 2, id: 'k1' },
      scene: { durationS: 10, actionPrompt: 'acena' },
    });
    expect(a).toBe(b);
  });

  it('normaliza espaços em strings (topo e aninhadas) mas preserva case', () => {
    const a = computeInputHash(McStepType.TTS, 1, {
      dialogue: ' Bem-vindo   às ofertas! ',
      voice: { style: '  animado  demais ' },
    });
    const b = computeInputHash(McStepType.TTS, 1, {
      dialogue: 'Bem-vindo às ofertas!',
      voice: { style: 'animado demais' },
    });
    expect(a).toBe(b);
    expect(
      computeInputHash(McStepType.TTS, 1, {
        dialogue: 'BEM-VINDO ÀS OFERTAS!',
        voice: { style: 'animado demais' },
      }),
    ).not.toBe(a);
  });

  it('muda com o tipo, a versão do builder e qualquer input', () => {
    const a = computeInputHash(McStepType.KEYFRAME, 1, base);
    expect(computeInputHash(McStepType.VIDEO, 1, base)).not.toBe(a);
    expect(computeInputHash(McStepType.KEYFRAME, 2, base)).not.toBe(a);
    expect(computeInputHash(McStepType.KEYFRAME, 1, { ...base, targetDurationS: 15 })).not.toBe(a);
  });

  it('ordem de arrays é semântica (cenas/refs não comutam)', () => {
    const a = computeInputHash(McStepType.ASSEMBLY, 1, { clips: ['c1', 'c2'] });
    const b = computeInputHash(McStepType.ASSEMBLY, 1, { clips: ['c2', 'c1'] });
    expect(a).not.toBe(b);
  });

  it('chave com undefined é ignorada (mesma semântica do JSON.stringify)', () => {
    const a = computeInputHash(McStepType.SCRIPT, 1, { briefing: 'x', soundtrack: undefined });
    const b = computeInputHash(McStepType.SCRIPT, 1, { briefing: 'x' });
    expect(a).toBe(b);
  });

  it('toda etapa tem versão de builder registrada (bump = invalidação de cache)', () => {
    for (const type of Object.values(McStepType)) {
      expect(MC_BUILDER_VERSIONS[type]).toBeGreaterThanOrEqual(1);
    }
  });
});
