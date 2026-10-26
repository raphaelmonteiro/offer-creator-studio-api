/** Morfologia binária das máscaras do recorte (janela quadrada, separável). */

/** Dilata uma linha (ou coluna) da máscara: `start` é o primeiro índice, `stride` o passo. */
function dilateLine(
  source: Uint8Array,
  target: Uint8Array,
  line: { start: number; stride: number; length: number },
  radius: number,
): void {
  const { start, stride, length } = line;
  for (let p = 0; p < length; p++) {
    let hit = 0;
    const to = Math.min(length - 1, p + radius);
    for (let k = Math.max(0, p - radius); k <= to && !hit; k++) {
      hit = source[start + k * stride] ? 1 : 0;
    }
    target[start + p * stride] = hit;
  }
}

/** Máscara binária dilatada em `radius` px (janela quadrada, separável). */
export function dilate(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const horizontal = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    dilateLine(mask, horizontal, { start: y * width, stride: 1, length: width }, radius);
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < width; x++) {
    dilateLine(horizontal, out, { start: x, stride: width, length: height }, radius);
  }
  return out;
}

/** Erosão = complemento da dilatação do complemento. */
export function erode(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const inverse = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inverse[i] = mask[i] ? 0 : 1;
  const grown = dilate(inverse, width, height, radius);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = grown[i] ? 0 : 1;
  return out;
}
