import {
  MC_TILE_MAX_RATIO,
  MC_TILE_MIN_FACE_FRACTION,
  MC_TILE_MIN_RATIO,
  MC_TILE_MIN_SHORT_SIDE,
  McRawImage,
  computeTileCrop,
  dominantOpaqueColor,
  edgeUniformity,
  parseHexColor,
} from './mc-tile';

/** Imagem RGBA sintética: `paint(x, y)` devolve [r, g, b, a] por pixel. */
function raw(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number],
): McRawImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { data, width, height, channels: 4 };
}

const GRAY: [number, number, number, number] = [0xe5, 0xe7, 0xeb, 255];
const BLUE: [number, number, number, number] = [30, 80, 200, 255];

describe('mc-tile — geometria do recorte (spec "Tile do personagem")', () => {
  it('rosto ≥ 60% da altura, proporção entre 3:4 e 1:1, centrado no rosto com folga acima', () => {
    const plan = computeTileCrop({
      width: 1000,
      height: 1000,
      bbox: { x: 0.3, y: 0.15, w: 0.4, h: 0.4 },
    });
    expect(plan.faceFraction).toBeGreaterThanOrEqual(MC_TILE_MIN_FACE_FRACTION);
    expect(plan.ratio).toBeGreaterThanOrEqual(MC_TILE_MIN_RATIO);
    expect(plan.ratio).toBeLessThanOrEqual(MC_TILE_MAX_RATIO);
    // altura = 400 / 0,6 = 666; largura = 0,75 × 666 → 500 (≥ largura do rosto 400)
    expect(plan.tile).toEqual({ left: 250, top: 70, width: 500, height: 666 });
    // o rosto (300..700 × 150..550) cabe inteiro no tile
    expect(plan.tile.left).toBeLessThanOrEqual(300);
    expect(plan.tile.left + plan.tile.width).toBeGreaterThanOrEqual(700);
    expect(plan.tile.top).toBeLessThanOrEqual(150);
    expect(plan.tile.top + plan.tile.height).toBeGreaterThanOrEqual(550);
    // dentro da imagem: nada a estender
    expect(plan.extract).toEqual(plan.tile);
    expect(plan.extend).toEqual({ top: 0, left: 0, bottom: 0, right: 0 });
  });

  it('lado menor abaixo de 720 px é escalado para 720 mantendo a proporção', () => {
    const plan = computeTileCrop({
      width: 1000,
      height: 1000,
      bbox: { x: 0.3, y: 0.15, w: 0.4, h: 0.4 },
    });
    expect(Math.min(plan.output.width, plan.output.height)).toBe(MC_TILE_MIN_SHORT_SIDE);
    expect(plan.output.width / plan.output.height).toBeCloseTo(plan.ratio, 2);
    const big = computeTileCrop({
      width: 4000,
      height: 4000,
      bbox: { x: 0.3, y: 0.15, w: 0.4, h: 0.4 },
    });
    expect(big.scale).toBe(1);
    expect(big.output).toEqual({ width: big.tile.width, height: big.tile.height });
  });

  it('rosto encostado no topo: o tile sai da imagem e a diferença vira extend (nunca corta o rosto)', () => {
    const plan = computeTileCrop({
      width: 800,
      height: 800,
      bbox: { x: 0.3, y: 0.02, w: 0.4, h: 0.4 },
    });
    expect(plan.tile.top).toBeLessThan(0);
    expect(plan.extract.top).toBe(0);
    expect(plan.extend.top).toBe(-plan.tile.top);
    expect(plan.extract.height + plan.extend.top + plan.extend.bottom).toBe(plan.tile.height);
    expect(plan.extract.width + plan.extend.left + plan.extend.right).toBe(plan.tile.width);
  });

  it('rosto muito largo: a proporção manda (nunca passa de 1:1) e a fração do rosto cai, registrada', () => {
    const plan = computeTileCrop({
      width: 1000,
      height: 500,
      bbox: { x: 0.05, y: 0.4, w: 0.9, h: 0.2 },
    });
    expect(plan.ratio).toBeLessThanOrEqual(MC_TILE_MAX_RATIO);
    expect(plan.ratio).toBeGreaterThanOrEqual(MC_TILE_MIN_RATIO);
    expect(plan.tile.width).toBeGreaterThanOrEqual(900);
    expect(plan.faceFraction).toBeLessThan(MC_TILE_MIN_FACE_FRACTION);
  });

  it('sem caixa (logo como está): imagem inteira estendida à proporção válida mais próxima', () => {
    const landscape = computeTileCrop({ width: 1200, height: 800, bbox: null });
    expect(landscape.tile).toEqual({ left: 0, top: -200, width: 1200, height: 1200 });
    expect(landscape.extend).toEqual({ top: 200, left: 0, bottom: 200, right: 0 });
    expect(landscape.faceFraction).toBeNull();

    const tall = computeTileCrop({ width: 500, height: 1000, bbox: null });
    expect(tall.tile).toEqual({ left: -125, top: 0, width: 750, height: 1000 });
    expect(tall.ratio).toBe(MC_TILE_MIN_RATIO);

    const square = computeTileCrop({ width: 400, height: 400, bbox: null });
    expect(square.tile).toEqual({ left: 0, top: 0, width: 400, height: 400 });
    expect(square.output).toEqual({ width: 720, height: 720 });
  });

  it('dimensões inválidas são erro', () => {
    expect(() => computeTileCrop({ width: 0, height: 10, bbox: null })).toThrow(/inválidas/);
  });
});

describe('mc-tile — guarda de uniformidade da borda', () => {
  it('fundo liso opaco: uniforme, cor de fundo detectada em hex', () => {
    const result = edgeUniformity(raw(40, 40, () => GRAY));
    expect(result.uniform).toBe(true);
    expect(result.transparent).toBe(false);
    expect(result.hex).toBe('#E5E7EB');
    expect(result.fractions).toEqual({ top: 1, left: 1, right: 1, bottom: 1 });
  });

  it('fundo transparente: uniforme, sem hex (RGB de pixels transparentes é ignorado)', () => {
    const result = edgeUniformity(
      raw(40, 40, (x, y) => (x > 10 && x < 30 && y > 10 && y < 30 ? BLUE : [x * 6, y * 6, 0, 0])),
    );
    expect(result.uniform).toBe(true);
    expect(result.transparent).toBe(true);
    expect(result.hex).toBeNull();
  });

  it('personagem saindo pela borda de baixo e pela metade inferior das laterais continua uniforme', () => {
    const result = edgeUniformity(
      raw(40, 60, (x, y) => (y >= 30 && x >= 0 && x < 40 ? BLUE : GRAY)),
    );
    expect(result.fractions.bottom).toBe(0);
    expect(result.fractions.left).toBeCloseTo(0.5, 1);
    expect(result.uniform).toBe(true);
  });

  it('gradiente no fundo reprova (borda superior não uniforme)', () => {
    const result = edgeUniformity(raw(60, 60, (x) => [x * 4, x * 4, x * 4, 255]));
    expect(result.uniform).toBe(false);
    expect(result.fractions.top).toBeLessThan(0.97);
  });

  it('personagem cruzando o topo ou toda a lateral reprova', () => {
    const crossingTop = edgeUniformity(
      raw(40, 40, (x, y) => (y < 2 && x > 10 && x < 30 ? BLUE : GRAY)),
    );
    expect(crossingTop.uniform).toBe(false);
    const crossingSide = edgeUniformity(raw(40, 40, (x) => (x < 2 ? BLUE : GRAY)));
    expect(crossingSide.fractions.left).toBe(0);
    expect(crossingSide.uniform).toBe(false);
  });

  it('pequenas variações de compressão dentro da tolerância não reprovam', () => {
    const result = edgeUniformity(
      raw(40, 40, (x, y) => [0xe5 + ((x + y) % 5), 0xe7 - ((x * y) % 4), 0xeb, 255]),
    );
    expect(result.uniform).toBe(true);
  });

  it('parseHexColor lê #RRGGBB e #RRGGBBAA; inválido → null', () => {
    expect(parseHexColor('#E5E7EB')).toEqual({ r: 229, g: 231, b: 235, alpha: 1 });
    expect(parseHexColor('#ff000080')?.alpha).toBeCloseTo(0.502, 2);
    expect(parseHexColor('light gray')).toBeNull();
    expect(parseHexColor(null)).toBeNull();
  });
});

describe('mc-tile — cor dominante dos pixels opacos (cor de marca do logo transparente)', () => {
  it('ignora pixels transparentes e devolve a cor mais frequente entre os opacos', () => {
    const image = raw(20, 20, (x, y) =>
      x >= 5 && x < 15 && y >= 5 && y < 15 ? [250, 10, 10, 255] : [0, 0, 0, 0],
    );
    expect(dominantOpaqueColor(image)).toBe('#FA0A0A');
  });

  it('imagem toda transparente → null; imagem opaca → cor dominante', () => {
    expect(dominantOpaqueColor(raw(4, 4, () => [255, 255, 255, 0]))).toBeNull();
    expect(dominantOpaqueColor(raw(4, 4, (x) => (x < 3 ? BLUE : GRAY)))).toBe('#1E50C8');
  });
});
