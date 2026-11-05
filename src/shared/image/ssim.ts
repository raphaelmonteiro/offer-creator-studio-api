const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

/** SSIM de uma janela `win` x `win` com canto em (x, y); a janela tem de caber na imagem. */
function windowSsim(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  at: { x: number; y: number; win: number },
): number {
  const { x, y, win } = at;
  const n = win * win;
  let ma = 0;
  let mb = 0;
  for (let j = 0; j < win; j += 1) {
    for (let i = 0; i < win; i += 1) {
      const k = (y + j) * width + x + i;
      ma += a[k];
      mb += b[k];
    }
  }
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
  return ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
}

/**
 * SSIM médio em janelas `win` x `win` sem sobreposição de duas imagens cinza do mesmo tamanho.
 * Sem nenhuma janela inteira, vale 1 (semântica que os comerciais usam; a cena trata "sem amostra"
 * com um wrapper que devolve `null`).
 */
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
      sum += windowSsim(a, b, width, { x, y, win });
      count += 1;
    }
  }
  return count === 0 ? 1 : sum / count;
}
