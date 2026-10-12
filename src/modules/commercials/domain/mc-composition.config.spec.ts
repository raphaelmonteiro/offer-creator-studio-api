import { HttpException } from '@nestjs/common';
import { assemblyDimensions } from './mc-assembly-graph';
import {
  assertAspectSupportedForFormat,
  compositionDimensions,
  inferAspectRatio,
  isAspectSupportedForFormat,
  MC_COMPOSITION_DIMENSIONS,
  supportedAspectRatios,
} from './mc-composition.config';
import { MC_ASPECT_RATIOS, MC_SCENES_ASPECT_RATIOS } from './mc-types';

/** Resolução e inferência de aspecto dos formatos novos (video-formatos-personagem, design D12). */
describe('compositionDimensions — resolução de saída dos formatos novos (D12)', () => {
  it.each([
    ['9:16', 1080, 1920],
    ['4:5', 1080, 1350],
    ['1:1', 1080, 1080],
    ['16:9', 1920, 1080],
  ] as const)('%s → %i×%i', (aspect, width, height) => {
    expect(compositionDimensions(aspect)).toEqual({ width, height });
  });

  it('cobre exatamente os aspectos de MC_ASPECT_RATIOS (4:5 incluído)', () => {
    expect(Object.keys(MC_COMPOSITION_DIMENSIONS).sort()).toEqual([...MC_ASPECT_RATIOS].sort());
    expect(MC_ASPECT_RATIOS).toContain('4:5');
  });

  it('devolve uma cópia (mutar o retorno não altera a tabela)', () => {
    const dims = compositionDimensions('1:1');
    dims.width = 1;
    expect(compositionDimensions('1:1')).toEqual({ width: 1080, height: 1080 });
  });

  it('aspecto desconhecido lança (nunca cai silenciosamente em outro)', () => {
    expect(() => compositionDimensions('4:3' as never)).toThrow(/Aspecto desconhecido "4:3"/);
  });

  it('assemblyDimensions (F3, 720p) fica intocado e desconhece 4:5', () => {
    expect(assemblyDimensions('9:16')).toEqual({ width: 720, height: 1280 });
    expect(assemblyDimensions('1:1')).toEqual({ width: 960, height: 960 });
    expect(assemblyDimensions('16:9')).toEqual({ width: 1280, height: 720 });
    // o F3 nunca recebe 4:5 (admissão recusa); se recebesse, cairia no default 9:16
    expect(assemblyDimensions('4:5')).toEqual({ width: 720, height: 1280 });
  });
});

describe('inferAspectRatio — aspecto da arte por largura/altura (D12)', () => {
  it.each([
    ['NINI 1280×928 (1,38) → 16:9', 1280, 928, '16:9'],
    ['feed 1080×1350 exato → 4:5', 1080, 1350, '4:5'],
    ['página 20×27 (0,74) → 4:5 pela faixa 0,7–0,9', 20, 27, '4:5'],
    ['story 1080×1920 exato → 9:16', 1080, 1920, '9:16'],
    ['quadrado 1000×1000 → 1:1', 1000, 1000, '1:1'],
    ['1080×1100 (0,98, dentro dos 2%) → 1:1', 1080, 1100, '1:1'],
    ['A4 retrato 210×297 (0,71) → 4:5', 210, 297, '4:5'],
    ['A4 paisagem 297×210 (1,41) → 16:9', 297, 210, '16:9'],
    ['muito alto 500×1000 (0,5) → 9:16', 500, 1000, '9:16'],
  ] as const)('%s', (_label, width, height, expected) => {
    expect(inferAspectRatio(width, height)).toBe(expected);
  });

  it('tolerância de 2% é relativa ao aspecto alvo', () => {
    // 9:16 = 0,5625; 2% → até ~0,574. 1080×1890 = 0,5714 ✓ ; 1080×1860 = 0,5806 ✗ (faixa < 0,7 → 9:16 mesmo assim)
    expect(inferAspectRatio(1080, 1890)).toBe('9:16');
    // 16:9 = 1,778; 1900×1080 = 1,759 (1,04%) ✓
    expect(inferAspectRatio(1900, 1080)).toBe('16:9');
  });

  it('limites das faixas: 0,7 e 0,9 caem no aspecto "de cima"; 1,1 ainda é 1:1', () => {
    expect(inferAspectRatio(70, 100)).toBe('4:5');
    expect(inferAspectRatio(69, 100)).toBe('9:16');
    expect(inferAspectRatio(90, 100)).toBe('1:1');
    expect(inferAspectRatio(110, 100)).toBe('1:1');
    expect(inferAspectRatio(111, 100)).toBe('16:9');
  });

  it('dimensões inválidas lançam em vez de inferir algo', () => {
    expect(() => inferAspectRatio(0, 100)).toThrow(/Dimensões inválidas/);
    expect(() => inferAspectRatio(100, -1)).toThrow(/Dimensões inválidas/);
    expect(() => inferAspectRatio(Number.NaN, 100)).toThrow(/Dimensões inválidas/);
  });
});

describe('assertAspectSupportedForFormat — F3 recusa 4:5 (D12/D13)', () => {
  it('scenes aceita só 9:16 · 1:1 · 16:9; formatos novos aceitam os quatro', () => {
    expect(supportedAspectRatios('scenes')).toEqual(MC_SCENES_ASPECT_RATIOS);
    expect(supportedAspectRatios('talking_art')).toEqual(MC_ASPECT_RATIOS);
    expect(supportedAspectRatios('offer_carousel')).toEqual(MC_ASPECT_RATIOS);
    expect(isAspectSupportedForFormat('scenes', '4:5')).toBe(false);
    expect(isAspectSupportedForFormat('talking_art', '4:5')).toBe(true);
    expect(isAspectSupportedForFormat('offer_carousel', '4:3')).toBe(false);
  });

  it('scenes + 4:5 → 422 ASPECT_NOT_SUPPORTED_FOR_FORMAT com detalhes', () => {
    try {
      assertAspectSupportedForFormat('scenes', '4:5');
      fail('deveria lançar');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const http = err as HttpException;
      expect(http.getStatus()).toBe(422);
      expect(http.getResponse()).toMatchObject({
        code: 'ASPECT_NOT_SUPPORTED_FOR_FORMAT',
        details: { format: 'scenes', aspectRatio: '4:5', supported: ['9:16', '1:1', '16:9'] },
      });
      expect((http.getResponse() as { message: string }).message).toMatch(/"4:5".*"scenes"/);
    }
  });

  it('scenes com os três aspectos históricos e formatos novos com 4:5 não lançam', () => {
    for (const aspect of MC_SCENES_ASPECT_RATIOS) {
      expect(() => assertAspectSupportedForFormat('scenes', aspect)).not.toThrow();
    }
    expect(() => assertAspectSupportedForFormat('talking_art', '4:5')).not.toThrow();
    expect(() => assertAspectSupportedForFormat('offer_carousel', '4:5')).not.toThrow();
  });
});
