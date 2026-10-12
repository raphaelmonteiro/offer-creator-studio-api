import { fixtureTalkTileScript } from './__fixtures__/mc-script-v2.fixtures';
import { validateScriptV2 } from './mc-script-v2';
import {
  artBoxToOutputWindow,
  containFitRect,
  defaultCharacterWindow,
  listWindowPresets,
  safeAreaFor,
  validateCharacterWindow,
  windowCoversPriceWarning,
  windowPxToFractions,
} from './mc-talking-art-window';

const px = (w: { x: number; y: number; w: number; h: number }, W: number, H: number) => ({
  left: w.x * W,
  top: w.y * H,
  right: (w.x + w.w) * W,
  bottom: (w.y + w.h) * H,
});

describe('mc-talking-art-window — área segura, presets e validação da janela (tarefa 4.7)', () => {
  it('área segura por tamanho: 1080×1920 x 65–1015 / y 269–1248; demais com 65 px', () => {
    expect(safeAreaFor(1080, 1920)).toEqual({ left: 65, top: 269, right: 1015, bottom: 1248 });
    expect(safeAreaFor(1080, 1350)).toEqual({ left: 65, top: 65, right: 1015, bottom: 1285 });
    expect(safeAreaFor(1080, 1080)).toEqual({ left: 65, top: 65, right: 1015, bottom: 1015 });
    expect(safeAreaFor(1920, 1080)).toEqual({ left: 65, top: 65, right: 1855, bottom: 1015 });
  });

  it('presets: cantos + centro inferior, todos dentro da área segura e no aspecto do tile; o canto inferior direito é o default do diretor', () => {
    for (const [W, H] of [
      [1080, 1920],
      [1080, 1350],
      [1080, 1080],
      [1920, 1080],
    ]) {
      const presets = listWindowPresets(W, H, 0.75);
      expect(presets.map((p) => p.id)).toEqual([
        'top_left',
        'top_right',
        'bottom_left',
        'bottom_right',
        'bottom_center',
      ]);
      const safe = safeAreaFor(W, H);
      for (const preset of presets) {
        const b = px(preset.window, W, H);
        expect(b.left).toBeGreaterThanOrEqual(safe.left);
        expect(b.top).toBeGreaterThanOrEqual(safe.top);
        expect(b.right).toBeLessThanOrEqual(safe.right);
        expect(b.bottom).toBeLessThanOrEqual(safe.bottom);
        expect((preset.window.w * W) / (preset.window.h * H)).toBeCloseTo(0.75, 2);
      }
      const bottomRight = presets.find((p) => p.id === 'bottom_right')!;
      expect(bottomRight.window).toEqual(
        defaultCharacterWindow({ width: W, height: H, tileWidth: 720, tileHeight: 960 }),
      );
    }
    // preset "canto inferior esquerdo" num Reels 9:16 (cenário da spec)
    const reels = listWindowPresets(1080, 1920, 0.75).find((p) => p.id === 'bottom_left')!;
    const b = px(reels.window, 1080, 1920);
    expect(b.left).toBeCloseTo(65, 0);
    expect(b.bottom).toBeCloseTo(1248, 0);
    expect(reels.label).toBe('Canto inferior esquerdo');
  });

  it('arte 1:1 em 9:16: nenhum preset na faixa inferior de preenchimento (y > 1500) nem abaixo de y 1248; janela lá é recusada apontando a borda', () => {
    const art = containFitRect(1080, 1080, 1080, 1920);
    expect(art).toEqual({ x: 0, y: 420, width: 1080, height: 1080 });
    for (const preset of listWindowPresets(1080, 1920, 0.75)) {
      expect(px(preset.window, 1080, 1920).bottom).toBeLessThanOrEqual(1248);
    }
    // janela posta na faixa de baixo (sobre o preenchimento): recusada
    const inBand = { x: 0.6, y: 1550 / 1920, w: 0.28, h: 0.2 };
    const issues = validateCharacterWindow({ window: inBand, width: 1080, height: 1920 });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'WINDOW_OUTSIDE_SAFE_AREA',
      element: 'character_window',
      details: expect.objectContaining({ edges: ['bottom'] }),
    });
    // faixa SUPERIOR dentro da área segura (y ≥ 269) é aceita
    const top = { x: 0.06, y: 280 / 1920, w: 0.25, h: (0.25 * 1080) / 0.75 / 1920 };
    expect(
      validateCharacterWindow({ window: top, width: 1080, height: 1920, tileRatio: 0.75 }),
    ).toEqual([]);
  });

  it('1080×1350: janela a 40 px da borda direita é recusada; aspecto ≠ tile além de 2% é recusado; rosto do logo é isento', () => {
    const near = { x: (1080 - 40 - 300) / 1080, y: 0.5, w: 300 / 1080, h: 400 / 1350 };
    const right = validateCharacterWindow({
      window: near,
      width: 1080,
      height: 1350,
      tileRatio: 0.75,
    });
    expect(right.map((i) => i.code)).toEqual(['WINDOW_OUTSIDE_SAFE_AREA']);
    expect(right[0].details).toMatchObject({ edges: ['right'] });
    const squashed = { x: 0.1, y: 0.1, w: 300 / 1080, h: 300 / 1350 }; // 1:1 com tile 3:4
    const aspect = validateCharacterWindow({
      window: squashed,
      width: 1080,
      height: 1350,
      tileRatio: 0.75,
    });
    expect(aspect.map((i) => i.code)).toEqual(['WINDOW_ASPECT_MISMATCH']);
    // dentro dos 2%: 0,76 vs 0,75 passa
    const close = { x: 0.1, y: 0.1, w: 304 / 1080, h: 400 / 1350 };
    expect(
      validateCharacterWindow({ window: close, width: 1080, height: 1350, tileRatio: 0.75 }),
    ).toEqual([]);
    expect(
      validateCharacterWindow({
        window: { x: 0.01, y: 0.95, w: 0.2, h: 0.04 },
        width: 1080,
        height: 1920,
        tileRatio: 0.75,
        logoFace: true,
      }),
    ).toEqual([]);
  });

  it('artBoxToOutputWindow: caixa em frações da ARTE → pixels do quadro pelo contain-fit (faixa superior em 9:16; faixa lateral em 16:9)', () => {
    // 1080×1350 → 1080×1920: escala 1, desce a faixa superior (285 px)
    expect(containFitRect(1080, 1350, 1080, 1920)).toEqual({
      x: 0,
      y: 285,
      width: 1080,
      height: 1350,
    });
    expect(
      artBoxToOutputWindow({ x: 0.1, y: 0.05, w: 0.3, h: 0.1 }, 1080, 1350, 1080, 1920),
    ).toEqual({ x: 108, y: 285 + 68, width: 324, height: 136 });
    // 1280×928 (NINI) → 1920×1080: escala 1080/928, arte 1490 px, faixa lateral de 215 px
    expect(containFitRect(1280, 928, 1920, 1080)).toEqual({
      x: 215,
      y: 0,
      width: 1490,
      height: 1080,
    });
    const nini = artBoxToOutputWindow({ x: 0.5, y: 0.1, w: 0.2, h: 0.2 }, 1280, 928, 1920, 1080);
    expect(nini).toEqual({ x: 215 + 745, y: 108, width: 298, height: 216 });
    // mesmo aspecto: identidade
    expect(
      artBoxToOutputWindow({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 2160, 2700, 1080, 1350),
    ).toEqual({ x: 270, y: 675, width: 540, height: 338 });
    expect(windowPxToFractions({ x: 108, y: 353, width: 324, height: 136 }, 1080, 1920)).toEqual({
      x: 0.1,
      y: 0.1839,
      w: 0.3,
      h: 0.0708,
    });
  });

  it('aviso de preço coberto: preço sob a janela avisa e sugere presets livres; texto sem preço, baixa confiança ou cobertura < 20% não avisam', () => {
    const presets = listWindowPresets(1080, 1350, 0.75);
    const bottomRight = presets.find((p) => p.id === 'bottom_right')!.window;
    const price = {
      text: 'R$ 8,99',
      bbox: { x: bottomRight.x + 0.02, y: bottomRight.y + 0.05, w: 0.1, h: 0.04 },
    };
    const warning = windowCoversPriceWarning([price], bottomRight, presets);
    expect(warning).toMatchObject({ code: 'WINDOW_COVERS_PRICE', covered: [price] });
    expect(warning?.suggestedPresetIds).not.toContain('bottom_right');
    expect(warning?.suggestedPresetIds).toContain('top_left');
    expect(
      windowCoversPriceWarning(
        [{ text: 'Feijão carioca', bbox: price.bbox }],
        bottomRight,
        presets,
      ),
    ).toBeNull();
    expect(
      windowCoversPriceWarning([{ ...price, confidence: 0.3 }], bottomRight, presets),
    ).toBeNull();
    const grazing = {
      text: '12,90',
      bbox: { x: bottomRight.x - 0.095, y: bottomRight.y, w: 0.1, h: 0.04 }, // 5% sob a janela
    };
    expect(windowCoversPriceWarning([grazing], bottomRight)).toBeNull();
    expect(
      windowCoversPriceWarning([{ text: 'oferta', kind: 'price', bbox: price.bbox }], bottomRight),
    ).not.toBeNull();
  });

  it('validateScriptV2 (F1) com o quadro do projeto: janela fora da área segura ou fora do aspecto do tile vira issue apontando o elemento; sem quadro, só a forma é checada', () => {
    const base = fixtureTalkTileScript();
    const valid = { ...base, window: listWindowPresets(1080, 1920, 0.75)[3].window };
    expect(
      validateScriptV2(valid, { format: 'talking_art', aspectRatio: '9:16', tileRatio: 0.75 }),
    ).toEqual([]);
    const outside = { ...base, window: { x: 0.6, y: 0.8, w: 0.28, h: 0.15 } };
    const issues = validateScriptV2(outside, { format: 'talking_art', aspectRatio: '9:16' });
    expect(issues).toEqual([
      expect.objectContaining({ code: 'WINDOW_OUTSIDE_SAFE_AREA', element: 'character_window' }),
    ]);
    const mismatch = validateScriptV2(valid, {
      format: 'talking_art',
      aspectRatio: '9:16',
      tileRatio: 1,
    });
    expect(mismatch.map((i) => i.code)).toEqual(['WINDOW_ASPECT_MISMATCH']);
    // chamadores sem o quadro (legado): comportamento anterior
    expect(validateScriptV2(outside, { format: 'talking_art' })).toEqual([]);
    // rosto do logo: a janela é a caixa da arte — isenta
    expect(
      validateScriptV2(
        { ...outside, logoFace: true },
        { format: 'talking_art', aspectRatio: '9:16' },
      ),
    ).toEqual([]);
  });
});
