import { jumpBetween, judgeJumps, percentile, ssimGray } from './mc-jump-metric';

const W = 64;
const H = 64;
const frame = (fn: (x: number, y: number) => number) =>
  Uint8Array.from({ length: W * H }, (_v, k) => fn(k % W, Math.floor(k / W)));
const bar = (left: number) => frame((x) => (x >= left && x < left + 12 ? 255 : 20));

describe('métrica de salto (D14)', () => {
  it('quadros idênticos: SSIM 1, salto 0; quadros sem relação: salto alto', () => {
    expect(ssimGray(bar(10), bar(10), W, H)).toBeCloseTo(1, 6);
    expect(jumpBetween(bar(10), bar(10), W, H)).toBe(0);
    const noise = frame((x, y) => (x * 7 + y * 13) % 256);
    expect(jumpBetween(bar(10), noise, W, H)).toBeGreaterThan(0.5);
  });

  it('o salto cresce com o deslocamento da figura', () => {
    expect(jumpBetween(bar(10), bar(12), W, H)).toBeLessThan(jumpBetween(bar(10), bar(40), W, H));
  });

  it('percentil por interpolação linear; lista vazia → 0', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([0, 10], 0.95)).toBeCloseTo(9.5, 6);
    expect(percentile([], 0.95)).toBe(0);
  });

  it('vídeo suave (a figura anda 1 px por quadro) passa; um teleporte na fronteira reprova', () => {
    const smooth = Array.from({ length: 60 }, (_v, n) => bar(5 + n));
    expect(judgeJumps(smooth, W, H, [1]).passed).toBe(true);
    const cut = [...smooth.slice(0, 30), ...smooth.slice(30).map((_f, n) => bar(2 + n))];
    const verdict = judgeJumps(cut, W, H, [1]);
    expect(verdict.passed).toBe(false);
    expect(verdict.worst).toBeGreaterThan(verdict.limit);
  });

  it('piso de 0,01: clipe parado não gera linha de base degenerada', () => {
    const still = Array.from({ length: 40 }, () => bar(20));
    const verdict = judgeJumps(still, W, H, [20 / 30]);
    expect(verdict.baselineP95).toBe(0);
    expect(verdict.limit).toBe(0.01);
    expect(verdict.passed).toBe(true);
  });

  it('o salto da fronteira é o maior dos pares que a cobrem: um quadro congelado + pulo é visto qualquer que seja o arredondamento', () => {
    // textura suave que anda 0,3 px por quadro; na fronteira (t = 10/30 s, n0 = 10) um quadro repete e o seguinte pula 4 px
    const wave = (shift: number) =>
      frame((x, y) => 128 + 100 * Math.sin((x + shift) / 5) * Math.cos(y / 7));
    const frames = Array.from({ length: 30 }, (_v, n) => wave(n * 0.3));
    frames[10] = frames[9]; // congela
    for (let n = 11; n < 30; n += 1) frames[n] = wave(n * 0.3 + 4); // pula
    const verdict = judgeJumps(frames, W, H, [10 / 30]);
    expect(verdict.worst).toBeGreaterThan(verdict.limit);
    expect(verdict.passed).toBe(false);
    // o par do pulo (10 → 11) continua coberto se a fronteira cair um quadro antes ou depois
    expect(judgeJumps(frames, W, H, [9 / 30]).passed).toBe(false);
    expect(judgeJumps(frames, W, H, [11 / 30]).passed).toBe(false);
  });

  it('a linha de base exclui os 3 quadros de cada lado da fronteira', () => {
    const frames = Array.from({ length: 40 }, (_v, n) => (n >= 20 ? bar(40) : bar(10)));
    const verdict = judgeJumps(frames, W, H, [20 / 30]);
    expect(verdict.baselineP95).toBe(0); // só o par da fronteira difere, e ele não entra na base
    expect(verdict.passed).toBe(false);
  });
});
