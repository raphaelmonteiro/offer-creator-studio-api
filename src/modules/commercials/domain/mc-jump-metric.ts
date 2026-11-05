/**
 * Métrica de "sem salto" entre falas (change video-fala-continua, D14) — funções PURAS sobre quadros em
 * luma (cinza 8 bits). `jump(a, b) = 1 − SSIM(a, b)` entre quadros VIZINHOS (consecutivos a 30 fps),
 * medida na janela do personagem. A fronteira passa quando o salto nela não passa de
 * `max(2 × P95, 0,01)`, onde P95 é o percentil 95 do salto entre quadros vizinhos DENTRO das falas do
 * mesmo vídeo (o piso evita linha de base degenerada em clipe quase parado).
 */

import { ssimGray } from '../../../shared/image/ssim';
import { percentile } from '../../../shared/image/stats';
import { ASSEMBLY_FPS } from './mc-assembly-graph';

// `ssimGray` e `percentile` vivem em `shared/image` (DT-10); reexportados para quem já importa daqui.
export { percentile, ssimGray };

/** Fator sobre o P95 e piso do critério (D14). */
export const MC_JUMP_FACTOR = 2;
export const MC_JUMP_FLOOR = 0.01;
/** Quadros de cada lado de cada fronteira excluídos da linha de base. */
export const MC_JUMP_BASELINE_GUARD_FRAMES = 3;

/** Salto entre dois quadros vizinhos: 0 = idênticos, → 1 = nada em comum. */
export function jumpBetween(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  return Math.max(0, 1 - ssimGray(a, b, width, height));
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

/** fps do vídeo montado (CFR): o da montagem. */
export const MC_JUMP_FPS = ASSEMBLY_FPS;

/**
 * Veredito de uma sequência de quadros. `boundaryTimesS` são os instantes (s) em que cada fala seguinte começa
 * (ou o trecho seguinte entra). O salto de uma fronteira é o MAIOR entre os pares de quadros vizinhos que a
 * cobrem (`n0 − 1 → n0`, `n0 → n0 + 1` e `n0 + 1 → n0 + 2`, com `n0 = ⌊t × 30⌋`): a fronteira cai entre
 * dois quadros da grade, e um corte fora dela congela um quadro e pula o seguinte (dois quadros de movimento
 * de uma vez), o que o par único esconderia ou mostraria conforme o arredondamento. A linha de base exclui
 * ±3 quadros de cada fronteira.
 */
export function judgeJumps(
  frames: Uint8Array[],
  width: number,
  height: number,
  boundaryTimesS: number[],
  fps: number = MC_JUMP_FPS,
): JumpVerdict {
  const jumps = frames.slice(1).map((frame, i) => jumpBetween(frames[i], frame, width, height));
  const firsts = boundaryTimesS.map((t) => Math.floor(t * fps));
  const guarded = new Set<number>();
  for (const n of firsts) {
    for (
      let k = n - MC_JUMP_BASELINE_GUARD_FRAMES;
      k <= n + MC_JUMP_BASELINE_GUARD_FRAMES + 1;
      k += 1
    ) {
      guarded.add(k - 1); // jumps[k - 1] é o par (k − 1 → k)
    }
  }
  const baseline = jumps.filter((_j, i) => !guarded.has(i));
  const baselineP95 = percentile(baseline, 0.95);
  const limit = Math.max(MC_JUMP_FACTOR * baselineP95, MC_JUMP_FLOOR);
  // jumps[i] é o par (i → i + 1): os três pares que cobrem a fronteira são os de índice n0 − 1, n0 e n0 + 1
  const boundaries = firsts.map((n) =>
    Math.max(jumps[n - 1] ?? 0, jumps[n] ?? 0, jumps[n + 1] ?? 0),
  );
  const worst = boundaries.length > 0 ? Math.max(...boundaries) : 0;
  return { baselineP95, limit, boundaries, worst, passed: boundaries.every((j) => j <= limit) };
}
