import {
  chooseCutoutKey,
  MC_CUTOUT_KEY_BLUE,
  MC_CUTOUT_KEY_GREEN,
  MC_CUTOUT_KEY_RULE_VERSION,
  rgbToLab,
  deltaE76,
} from './mc-cutout-key';
import { isCharacterCutoutEnabled } from './mc-cutout.config';

function solid(rgb: [number, number, number], count: number, alpha = 255): number[] {
  return Array.from({ length: count }, () => [...rgb, alpha]).flat();
}

describe('chooseCutoutKey (D3)', () => {
  it('personagem azul fica com o verde, a primeira candidata segura', () => {
    const decision = chooseCutoutKey({
      data: Uint8Array.from(solid([200, 30, 30], 1000)),
      channels: 4,
    });
    expect(decision).toMatchObject({
      chosen: MC_CUTOUT_KEY_GREEN,
      safe: true,
      ruleVersion: MC_CUTOUT_KEY_RULE_VERSION,
    });
    expect(decision.candidates).toHaveLength(2);
  });

  it('personagem verde passa para o azul', () => {
    const decision = chooseCutoutKey({
      data: Uint8Array.from(solid([0, 177, 64], 1000)),
      channels: 4,
    });
    expect(decision.chosen).toBe(MC_CUTOUT_KEY_BLUE);
  });

  it('personagem metade verde e metade azul: sem chave segura (recusa)', () => {
    const data = Uint8Array.from([...solid([0, 177, 64], 500), ...solid([0, 71, 187], 500)]);
    const decision = chooseCutoutKey({ data, channels: 4 });
    expect(decision).toMatchObject({ chosen: null, safe: false });
  });

  it('pixels transparentes não contam para a regra', () => {
    const data = Uint8Array.from([...solid([200, 30, 30], 100), ...solid([0, 177, 64], 5000, 0)]);
    expect(chooseCutoutKey({ data, channels: 4 }).chosen).toBe(MC_CUTOUT_KEY_GREEN);
  });

  it('Lab: a própria chave tem ΔE 0 e vermelho fica longe', () => {
    expect(deltaE76(rgbToLab(0, 177, 64), rgbToLab(0, 177, 64))).toBe(0);
    expect(deltaE76(rgbToLab(0, 177, 64), rgbToLab(200, 30, 30))).toBeGreaterThan(60);
  });
});

describe('isCharacterCutoutEnabled', () => {
  it('padrão desligado; só "true" liga', () => {
    expect(isCharacterCutoutEnabled({})).toBe(false);
    expect(isCharacterCutoutEnabled({ MC_CHARACTER_CUTOUT: 'false' })).toBe(false);
    expect(isCharacterCutoutEnabled({ MC_CHARACTER_CUTOUT: 'TRUE' })).toBe(true);
  });
});
