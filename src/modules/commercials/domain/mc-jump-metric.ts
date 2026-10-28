/**
 * Métrica de "sem salto" entre falas (change video-fala-continua, D14) — funções PURAS sobre quadros em
 * luma (cinza 8 bits). `jump(a, b) = 1 − SSIM(a, b)` entre quadros VIZINHOS (consecutivos a 30 fps),
 * medida na janela do personagem. A fronteira passa quando o salto nela não passa de
 * `max(2 × P95, 0,01)`, onde P95 é o percentil 95 do salto entre quadros vizinhos DENTRO das falas do
 * mesmo vídeo (o piso evita linha de base degenerada em clipe quase parado).
 */

/** Fator sobre o P95 e piso do critério (D14). */
export const MC_JUMP_FACTOR = 2;
export const MC_JUMP_FLOOR = 0.01;
/** Quadros de cada lado de cada fronteira excluídos da linha de base. */
export const MC_JUMP_BASELINE_GUARD_FRAMES = 3;

const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

/** SSIM médio em janelas 8×8 sem sobreposição de dois quadros cinza do mesmo tamanho. */
export function ssimGray(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  win = 8,
): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y + win <= height; y += win) {
    for (let x = 0; x + win <= width; x += win) {
      let ma = 0;
      let mb = 0;
      for (let j = 0; j < win; j += 1) {
        for (let i = 0; i < win; i += 1) {
          const k = (y + j) * width + x + i;
          ma += a[k];
          mb += b[k];
        }
      }
      const n = win * win;
      ma /= n;
      mb /= n;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let j = 0; j < win; j += 1) {
        for (let i = 0; i < win; i += 1) {
          const k = (y + j) * width + x + i;
          va += (a[k] - ma) ** 2;
          vb += (b[k] - mb) ** 2;
          cov += (a[k] - ma) * (b[k] - mb);
        }
      }
      va /= n - 1;
      vb /= n - 1;
      cov /= n - 1;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      count += 1;
    }
  }
  return count === 0 ? 1 : sum / count;
}

/** Salto entre dois quadros vizinhos: 0 = idênticos, → 1 = nada em comum. */
export function jumpBetween(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  return Math.max(0, 1 - ssimGray(a, b, width, height));
}

/** Percentil (interpolação linear) de uma lista; vazia → 0. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

export interface JumpVerdict {
  /** P95 do salto dentro das falas (linha de base). */
  baselineP95: number;
  /** `max(2 × P95, 0,01)`. */
  limit: number;
  /** Salto de cada fronteira, na ordem dada. */
  boundaries: number[];
  worst: number;
  passed: boolean;
}

/**
 * Veredito de uma sequência de quadros. `boundaryFrames` são os índices `n` do PRIMEIRO quadro depois de
 * cada fronteira (o par medido é `n − 1` → `n`); a linha de base exclui ±3 quadros de cada fronteira.
 */
export function judgeJumps(
  frames: Uint8Array[],
  width: number,
  height: number,
  boundaryFrames: number[],
): JumpVerdict {
  const jumps = frames.slice(1).map((frame, i) => jumpBetween(frames[i], frame, width, height));
  const guarded = new Set<number>();
  for (const n of boundaryFrames) {
    for (
      let k = n - MC_JUMP_BASELINE_GUARD_FRAMES;
      k <= n + MC_JUMP_BASELINE_GUARD_FRAMES;
      k += 1
    ) {
      guarded.add(k - 1); // jumps[k - 1] é o par (k − 1 → k)
    }
  }
  const baseline = jumps.filter((_j, i) => !guarded.has(i));
  const baselineP95 = percentile(baseline, 0.95);
  const limit = Math.max(MC_JUMP_FACTOR * baselineP95, MC_JUMP_FLOOR);
  const boundaries = boundaryFrames.map((n) => jumps[n - 1] ?? 0);
  const worst = boundaries.length > 0 ? Math.max(...boundaries) : 0;
  return { baselineP95, limit, boundaries, worst, passed: boundaries.every((j) => j <= limit) };
}
